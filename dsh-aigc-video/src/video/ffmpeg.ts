/**
 * ffmpeg subprocess wrapper — spawn a long-running ffmpeg job and
 * stream progress / errors back via async iterators.
 *
 * Phase 5: the lowest-level video module. All mixing / smart-edit /
 * beat-sync work in higher phases uses this.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// createRequire lets the ESM-imported module synchronously load the
// optional `@ffmpeg-installer/ffmpeg` or `ffmpeg-static` package
// (which are CommonJS-only). Cached per-process.
const _localRequire = createRequire(import.meta.url);

export interface FfmpegOptions {
  /** Path to ffmpeg binary; defaults to 'ffmpeg' on PATH. */
  ffmpegPath?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Hard wall-clock timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
}

export interface ProgressEvent {
  /** Wall-clock seconds since process start. */
  elapsedSec: number;
  /** Last parsed `time=HH:MM:SS.MS` from stderr. */
  time?: string;
  /** Last parsed `bitrate=` line, if any. */
  bitrate?: string;
  /** Last parsed `speed=` (e.g. '1.07x'). */
  speed?: string;
  /** ffmpeg progress as a fraction, 0..1. */
  fraction?: number;
  /** Last stderr line (truncated). */
  lastLine: string;
}

export class FfmpegError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;
  constructor(exitCode: number | null, stderrTail: string) {
    super(`ffmpeg exited with code ${exitCode}: ${stderrTail.slice(0, 500)}`);
    this.name = 'FfmpegError';
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

export class FfmpegRunner {
  constructor(private readonly opts: FfmpegOptions = {}) {}

  /**
   * Resolve the ffmpeg binary. Order:
   *   1. Explicit `opts.ffmpegPath` if it exists.
   *   2. `process.env.FFMPEG_PATH` / `FFMPEG_BIN` if set.
   *   3. `@ffmpeg-installer/ffmpeg` (if installed) — ships a Windows-friendly binary.
   *   4. `ffmpeg-static` (if installed).
   *   5. `'ffmpeg'` on PATH.
   *
   * Resolved path is cached so we don't repeatedly try require().
   */
  private static cachedBinary?: string;

  resolveBinary(): string {
    if (this.opts.ffmpegPath && existsSync(this.opts.ffmpegPath)) {
      return this.opts.ffmpegPath;
    }
    if (FfmpegRunner.cachedBinary && existsSync(FfmpegRunner.cachedBinary)) {
      return FfmpegRunner.cachedBinary;
    }
    const fromEnv = process.env.FFMPEG_PATH ?? process.env.FFMPEG_BIN;
    if (fromEnv && existsSync(fromEnv)) {
      FfmpegRunner.cachedBinary = fromEnv;
      return fromEnv;
    }
    // Try common npm packages that bundle an ffmpeg binary.
    for (const pkg of ['@ffmpeg-installer/ffmpeg', 'ffmpeg-static']) {
      try {
        const m = _localRequire(pkg);
        const p: string | undefined = m?.path ?? m?.default?.path;
        if (p && existsSync(p)) {
          FfmpegRunner.cachedBinary = p;
          return p;
        }
      } catch {
        // package not installed; fall through
      }
    }
    return this.opts.ffmpegPath ?? 'ffmpeg';
  }

  /**
   * Probe whether this ffmpeg binary supports the `xfade` filter (added
   * in ffmpeg 4.3 / 2020). The result is cached on the instance so the
   * `ffmpeg -filters` subprocess runs at most once per runner.
   *
   * The mixer uses this to decide whether to use the modern xfade chain
   * (smooth crossfades) or fall back to plain `concat` (hard cuts) so the
   * tool still works on legacy ffmpeg builds.
   */
  private _hasXfade?: boolean;

  hasXfade(): boolean {
    if (this._hasXfade !== undefined) return this._hasXfade;
    try {
      const out = execFileSync(this.resolveBinary(), ['-hide_banner', '-filters'])
        .toString();
      // Filter list lines look like ` ... xfade   V->V       Cross fade one video to another.`
      this._hasXfade = /\bxfade\b/.test(out);
    } catch {
      this._hasXfade = false;
    }
    return this._hasXfade;
  }

  /** Download a file URL to disk (used by agents to fetch generated assets). */
  async download(url: string, destAbsPath: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 5 * 60_000);
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(destAbsPath), { recursive: true });
      writeFileSync(destAbsPath, buf);
      return destAbsPath;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run ffmpeg with the given argv (after the binary), returning a
   * `ProgressEvent` async iterable that yields as ffmpeg emits lines
   * to stderr. Throws `FfmpegError` on non-zero exit.
   */
  run(args: string[]): AsyncIterable<ProgressEvent> {
    const binary = this.resolveBinary();
    const started = Date.now();
    const timeoutMs = this.opts.timeoutMs ?? 5 * 60_000;
    const child = spawn(binary, args, {
      cwd: this.opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderrChunks: string[] = [];
    return (async function* (this: FfmpegRunner) {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, timeoutMs);
      try {
        let lastLine = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          stderrChunks.push(text);
          // Parse the most recent line for progress metrics.
          const lines = text.split(/\r?\n/);
          for (const line of lines) {
            if (!line) continue;
            lastLine = line;
          }
        });
        const code: number | null = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => resolve(code));
        });
        if (code !== 0) {
          throw new FfmpegError(code, stderrChunks.join('').slice(-4096));
        }
        // Final yield so callers see a last event after success.
        yield {
          elapsedSec: (Date.now() - started) / 1000,
          lastLine,
        };
      } finally {
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }
    }).call(this) as AsyncIterable<ProgressEvent>;
  }
}

/** Probe a media file's duration (seconds) using ffprobe. */
export async function ffprobeDuration(file: string, ffprobePath = 'ffprobe'): Promise<number> {
  if (!existsSync(file)) throw new Error(`ffprobe: file not found: ${file}`);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    child.stderr?.on('data', (c: Buffer) => errs.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed (${code}): ${Buffer.concat(errs).toString('utf-8')}`));
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      const seconds = parseFloat(text);
      if (Number.isFinite(seconds)) resolve(seconds);
      else reject(new Error(`ffprobe: cannot parse duration from '${text}'`));
    });
  });
}