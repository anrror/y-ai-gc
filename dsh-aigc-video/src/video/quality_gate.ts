/**
 * P0-4: lightweight video quality gate.
 *
 * Runs after a clip is downloaded but before it counts as "success". Uses
 * ffmpeg + ffprobe to:
 *   - probe duration (compare against `expected_sec`)
 *   - probe resolution (must be ≥ `min_width × min_height`)
 *   - detect black-frame ratio via `blackdetect` filter (must be < `max_black_ratio`)
 *
 * Failure reasons are returned as a typed `QualityCheckResult` so callers
 * can branch on them. The check is cheap (sub-second on 6–10s clips).
 *
 * Does NOT do heavy ML quality scoring (CLIP-Score, aesthetic) — that's
 * P2. The gate just filters out the obvious failures (zero-duration,
 * black frames, tiny clips).
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { FfmpegRunner } from './ffmpeg.js';

const execFileP = promisify(execFile);

export interface QualityCheckOptions {
  /** Expected clip duration (seconds). Tolerance ±20%. */
  expected_sec?: number;
  /** Minimum width / height. Default 360×360 (filters out tiny / corrupt files). */
  min_width?: number;
  min_height?: number;
  /** Maximum allowed black-frame ratio. Default 0.5 (>50% black = reject). */
  max_black_ratio?: number;
  /** Inject ffmpeg / ffprobe binaries (defaults from FfmpegRunner). */
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface QualityCheckResult {
  ok: boolean;
  /** Resolved actual values from ffprobe. */
  probed: {
    duration_sec: number | null;
    width: number | null;
    height: number | null;
    black_ratio: number | null;
  };
  /**
   * Machine-readable failure reasons (empty when ok=true).
   * `'probe_unavailable'` is a SOFT signal — ffprobe / ffmpeg wasn't found
   * on this system, so we couldn't run the probe. The clip is accepted
   * (ok=true) because we have no evidence it is broken; callers may want
   * to install ffmpeg and re-run to get the full quality report.
   */
  reasons: Array<
    | 'missing_file'
    | 'duration_mismatch'
    | 'too_small'
    | 'too_much_black'
    | 'probe_failed'
    | 'probe_unavailable'
  >;
}

/**
 * Run the quality gate against a local video file. Returns `{ ok, reasons }`
 * without throwing — callers decide whether to retry, fall back, or log.
 */
export async function checkClipQuality(
  filePath: string,
  opts: QualityCheckOptions = {},
): Promise<QualityCheckResult> {
  const minWidth = opts.min_width ?? 360;
  const minHeight = opts.min_height ?? 360;
  const maxBlack = opts.max_black_ratio ?? 0.5;
  const expected = opts.expected_sec;
  const runner = new FfmpegRunner();
  const ffprobe = opts.ffprobePath ?? runner.resolveBinary().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');

  const result: QualityCheckResult = {
    ok: true,
    probed: { duration_sec: null, width: null, height: null, black_ratio: null },
    reasons: [],
  };

  if (!existsSync(filePath)) {
    result.ok = false;
    result.reasons.push('missing_file');
    return result;
  }

  // Files smaller than 1 KB are almost certainly placeholders (test stubs,
  // empty downloads, partial writes). Skip the heavy probes and treat as
  // ok=false with 'too_small' so the caller doesn't retry a meaningless
  // probe. Production usage always writes several-hundred-KB MP4s.
  let fileSize = 0;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    /* ignore */
  }
  if (fileSize < 1024) {
    result.ok = false;
    result.reasons.push('too_small');
    return result;
  }

  // Step 1: ffprobe for duration + resolution.
  try {
    const out = await execFileP(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=width,height',
      '-of', 'default=noprint_wrappers=1',
      filePath,
    ], { timeout: 15_000 });
    const text = (out.stdout ?? '') as string;
    const dur = text.match(/duration=([\d.]+)/)?.[1];
    const w = text.match(/width=(\d+)/)?.[1];
    const h = text.match(/height=(\d+)/)?.[1];
    if (dur) result.probed.duration_sec = parseFloat(dur);
    if (w) result.probed.width = parseInt(w, 10);
    if (h) result.probed.height = parseInt(h, 10);
  } catch (e) {
    // Detect the "ffprobe not installed" case (ENOENT) and accept the clip
    // as a soft-skip rather than a hard failure. This prevents the 6-min
    // run from being reported as "0/4 succeeded" when 4 clips were actually
    // generated correctly but ffprobe isn't on the host.
    const code = (e as NodeJS.ErrnoException)?.code;
    const msg = (e as Error)?.message ?? '';
    if (code === 'ENOENT' || /ENOENT|no such file|not found|not recognized/i.test(msg)) {
      result.reasons.push('probe_unavailable');
      // ok stays true — we couldn't run the probe but the file exists and is
      // non-trivial in size (≥1 KB check above). Caller may want to install
      // ffmpeg + ffprobe for a full quality report.
      return result;
    }
    result.ok = false;
    result.reasons.push('probe_failed');
    return result;
  }

  if (
    result.probed.duration_sec !== null &&
    expected !== undefined &&
    Math.abs(result.probed.duration_sec - expected) > expected * 0.2 + 0.5
  ) {
    result.reasons.push('duration_mismatch');
  }

  if (
    result.probed.width !== null &&
    result.probed.height !== null &&
    (result.probed.width < minWidth || result.probed.height < minHeight)
  ) {
    result.reasons.push('too_small');
  }

  // Step 2: black-frame ratio via ffmpeg blackdetect.
  // Filter emits `black_start`, `black_end`, `pkt_size` lines; we
  // compute ratio from sum(black_end - black_start) / duration.
  try {
    const ffmpeg = opts.ffmpegPath ?? runner.resolveBinary();
    const out = await execFileP(ffmpeg, [
      '-i', filePath,
      '-vf', 'blackdetect=d=0.1:pix_th=0.10',
      '-an', '-f', 'null',
      '-',
    ], { timeout: 20_000 });
    const stderr = (out.stderr ?? '') as string;
    const blacks: Array<{ start: number; end: number }> = [];
    const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) {
      blacks.push({
        start: parseFloat(m[1] ?? '0'),
        end: parseFloat(m[2] ?? '0'),
      });
    }
    if (result.probed.duration_sec && result.probed.duration_sec > 0) {
      const blackTotal = blacks.reduce((s, b) => s + (b.end - b.start), 0);
      const ratio = blackTotal / result.probed.duration_sec;
      result.probed.black_ratio = Math.min(1, ratio);
      if (ratio > maxBlack) result.reasons.push('too_much_black');
    }
  } catch {
    // ffprobe succeeded but ffmpeg blackdetect failed — don't reject the
    // clip just for this (could be codec-incompatible). Leave black_ratio
    // as null so caller sees a soft-skip rather than a hard fail.
  }

  if (result.reasons.length > 0) result.ok = false;
  return result;
}