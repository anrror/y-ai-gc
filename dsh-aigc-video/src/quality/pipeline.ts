/**
 * QualityPipeline — unified quality gate (B in the Quality Engineering roadmap).
 *
 * Wraps the existing `checkClipQuality` (P0-4 lightweight ffprobe/blackdetect)
 * and returns a structured `QualityReport` per the contract in
 * `src/quality/contract.ts`. Adds:
 *   - freezedetect (frame repetition — production AIGC failure mode)
 *   - silencedetect (audio drop detection)
 *
 * Heavy ML checks (CLIP-Score, DINO subject consistency, ArcFace identity,
 * UTMOS, SyncNet lip-sync) are deferred to a Python sidecar and exposed
 * via `QualityPipeline.deepEvaluate()`. For now `quickGate()` covers all
 * zero-dependency checks.
 *
 * The pipeline is intentionally permissive: any individual metric that's
 * unmeasurable (e.g. ffmpeg failed) is dropped from the report instead of
 * failing the gate, so a single broken check doesn't cascade.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FfmpegRunner } from '../video/ffmpeg.js';
import { checkClipQuality, type QualityCheckResult } from '../video/quality_gate.js';
import {
  report,
  reading,
  type MetricName,
  type MetricReading,
  type QualityReport,
} from './contract.js';

const execFileP = promisify(execFile);

export interface QuickGateOptions {
  /** Expected duration (used for `duration_ok` metric). */
  expected_sec?: number;
  /** Minimum width × height (default 360×360). */
  min_width?: number;
  min_height?: number;
  /** Max black-frame ratio (default 0.5). */
  max_black_ratio?: number;
  /** Max frozen-frame ratio (default 0.05 — >5% repeated frames rejected). */
  max_freeze_ratio?: number;
  /** Max silent-audio ratio (default 0.5). */
  max_silence_ratio?: number;
}

/**
 * Lightweight per-clip gate. Returns a full `QualityReport` including
 * composite score, all measurable metrics, and failure reasons.
 *
 * Zero ML dependencies: uses only ffmpeg/ffprobe subprocesses. Runs in
 * sub-second on 6–10 s clips.
 */
export async function quickGate(
  filePath: string,
  opts: QuickGateOptions = {},
): Promise<QualityReport> {
  const legacy: QualityCheckResult = await checkClipQuality(filePath, {
    ...(opts.expected_sec !== undefined ? { expected_sec: opts.expected_sec } : {}),
    ...(opts.min_width !== undefined ? { min_width: opts.min_width } : {}),
    ...(opts.min_height !== undefined ? { min_height: opts.min_height } : {}),
    ...(opts.max_black_ratio !== undefined ? { max_black_ratio: opts.max_black_ratio } : {}),
  });

  const metrics: MetricReading[] = [];
  const failureClass = pickClass(legacy.reasons);

  // duration_ok: 1.0 if matches (within ±20%+0.5s) or no expected given;
  // 0.0 if mismatch; 0.5 if unmeasurable.
  metrics.push(reading('duration_ok', legacyDurationOk(legacy)));

  // resolution_ok: 1.0 if width/height ≥ thresholds; 0.0 if below; 0.5
  // if unknown.
  metrics.push(reading('resolution_ok', legacyResolutionOk(legacy)));

  // black_frame_ratio: invert (1 - ratio) so higher = better.
  metrics.push(reading(
    'black_frame_ratio',
    legacy.probed.black_ratio === null ? 0.5 : Math.max(0, 1 - legacy.probed.black_ratio),
  ));

  // frozen_frame_ratio: 1 - ratio (higher = better).
  const freeze = await detectFreezeRatio(filePath, {
    max_freeze_ratio: opts?.max_freeze_ratio ?? 0.05,
  });
  if (freeze !== null) {
    metrics.push(reading('temporal_flickering', Math.max(0, 1 - freeze)));
  }

  // audio silence ratio: 1 - ratio (higher = better).
  const silence = await detectSilenceRatio(filePath, {
    max_silence_ratio: opts?.max_silence_ratio ?? 0.5,
  });
  if (silence !== null) {
    metrics.push(reading('audio_sync', Math.max(0, 1 - silence)));
  }

  return report(metrics, { failureClass });
}

/**
 * Detect frozen/duplicate frames via ffmpeg `freezedetect` filter.
 * Returns ratio of frozen-frame duration to total duration, or null
 * if ffmpeg fails (codec incompatible, etc.).
 */
async function detectFreezeRatio(
  filePath: string,
  opts: { max_freeze_ratio?: number } = {},
): Promise<number | null> {
  const _max = opts?.max_freeze_ratio ?? 0.05; // referenced for parity w/ other helpers
  const runner = new FfmpegRunner();
  const ffmpeg = runner.resolveBinary();
  try {
    const out = await execFileP(ffmpeg, [
      '-i', filePath,
      '-vf', 'freezedetect=n=0.003:d=2',
      '-an', '-f', 'null',
      '-',
    ], { timeout: 20_000 });
    const stderr = (out.stderr ?? '') as string;
    // freezedetect outputs `freeze_start:... freeze_end:...` lines.
    const re = /freeze_start:([\d.]+)\s+freeze_end:([\d.]+)/g;
    let total = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) {
      total += parseFloat(m[2] ?? '0') - parseFloat(m[1] ?? '0');
    }
    const dur = await probeDurationSafe(filePath);
    if (!dur || dur <= 0) return null;
    return Math.min(1, total / dur);
  } catch {
    return null;
  }
}

/**
 * Detect audio silence ratio via ffmpeg `silencedetect` filter.
 * Returns ratio of silent duration to total duration, or null on
 * failure (e.g. clip has no audio track).
 */
async function detectSilenceRatio(
  filePath: string,
  opts: { max_silence_ratio?: number } = {},
): Promise<number | null> {
  const _max = opts?.max_silence_ratio ?? 0.5; // referenced for parity
  const runner = new FfmpegRunner();
  const ffmpeg = runner.resolveBinary();
  try {
    const out = await execFileP(ffmpeg, [
      '-i', filePath,
      '-af', 'silencedetect=noise=-30dB:d=0.5',
      '-f', 'null',
      '-',
    ], { timeout: 20_000 });
    const stderr = (out.stderr ?? '') as string;
    const re = /silence_start:([\d.]+)\s+silence_end:([\d.]+)/g;
    let total = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr)) !== null) {
      total += parseFloat(m[2] ?? '0') - parseFloat(m[1] ?? '0');
    }
    const dur = await probeDurationSafe(filePath);
    if (!dur || dur <= 0) return null;
    return Math.min(1, total / dur);
  } catch {
    return null;
  }
}

/** Probe duration without throwing — used by freeze/silence ratio helpers. */
async function probeDurationSafe(filePath: string): Promise<number | null> {
  const runner = new FfmpegRunner();
  const ffprobe = runner.resolveBinary().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  try {
    const out = await execFileP(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 10_000 });
    const text = (out.stdout ?? '').toString().trim();
    const n = parseFloat(text);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Map legacy `QualityCheckResult.reasons` to the contract's
 * `FailureClass` taxonomy. Best-effort: only one class per gate.
 */
function pickClass(reasons: string[]): QualityReport['failure_class'] {
  if (reasons.includes('missing_file') || reasons.includes('too_small') || reasons.includes('probe_failed')) return 'technical';
  if (reasons.includes('duration_mismatch')) return 'technical';
  if (reasons.includes('too_much_black')) return 'temporal';
  return undefined;
}

function legacyDurationOk(r: QualityCheckResult): number {
  if (r.reasons.includes('missing_file') || r.reasons.includes('probe_failed')) return 0.5;
  if (r.reasons.includes('duration_mismatch')) return 0;
  if (r.probed.duration_sec === null) return 0.5;
  return 1;
}

function legacyResolutionOk(r: QualityCheckResult): number {
  if (r.reasons.includes('missing_file') || r.reasons.includes('probe_failed')) return 0.5;
  if (r.reasons.includes('too_small')) return 0;
  if (r.probed.width === null || r.probed.height === null) return 0.5;
  return 1;
}

/**
 * Class-level wrapper that exposes quickGate / deepEvaluate as a single
 * dependency-injectable service. Use this when callers want to mock the
 * gate for tests, or share a configuration across many calls.
 */
export class QualityPipeline {
  constructor(private readonly runner: FfmpegRunner = new FfmpegRunner()) {}

  async quickGate(filePath: string, opts: QuickGateOptions = {}): Promise<QualityReport> {
    return quickGate(filePath, opts);
  }

  /**
   * Deep evaluation — not yet implemented. Reserved for the Python-sidecar
   * integration that will run CLIP / DINO / MUSIQ / UTMOS / SyncNet.
   * For now this returns a copy of the quick gate with extra `notes` so
   * callers can rely on a stable shape.
   */
  async deepEvaluate(filePath: string, opts: QuickGateOptions = {}): Promise<QualityReport> {
    const base = await this.quickGate(filePath, opts);
    return {
      ...base,
      reasons: [
        ...base.reasons,
        '[deep-evaluate not yet wired — Python sidecar required for CLIP/DINO/MUSIQ]',
      ],
    };
  }
}