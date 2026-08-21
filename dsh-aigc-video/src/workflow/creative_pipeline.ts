/**
 * End-to-end creative pipeline: parse markdown script → decompose into
 * shots → assign camera moves → build Hailuo prompts → submit → poll →
 * download MP4s → compose final.mp4.
 *
 * Designed to be invoked without an LLM (script is provided directly).
 * For the LLM-driven variant (brief → script → video), wrap this with a
 * script-generation stage in `tools/creative_to_video.ts`.
 *
 * v3.4 architecture notes (PM/architect review):
 *   - Shot submission is PARALLEL with a `concurrency` semaphore (default
 *     3, overridable). 4 shots × 60s serial → 4 shots ≈ 80s with
 *     concurrency=3. The original serial loop wasted 50%+ wall-clock.
 *   - Video provider model is read from input (NOT hardcoded). Caller
 *     passes `input.model` (default `'MiniMax-Hailuo-2.3'`); future
 *     providers (Kling / Veo / Seedance) plug in via the same surface.
 *   - Composition (final.mp4 + manifest.json) is delegated to
 *     `./composer.ts`. CreativePipeline stays focused on "produce shots";
 *     the dub path (`EndToEndCreativePipeline`) reuses the same composer.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parseScript } from './script_parser.js';
import { decomposeIntoShots } from './shot_decomposer.js';
import { buildHailuoPrompt } from './prompt_builder.js';
import type { HailuoPrompt } from './prompt_builder.js';
import type { DecomposedShot } from './shot_decomposer.js';
import type { ParsedScript } from './script_parser.js';

import type { VideoProvider } from '../providers/types.js';
import { FfmpegRunner } from '../video/ffmpeg.js';
import { ProviderError, withProviderRetry } from '../providers/base.js';
import { estimateRunCost, type RunEstimate } from '../cost/estimator.js';
import { checkClipQuality } from '../video/quality_gate.js';
import { composeFinalMp4 } from './composer.js';
import {
  logWithTs,
  logPhase,
  formatProgressBar,
  progressEta,
  shouldBeat,
  formatDuration,
} from '../util/progress.js';

export interface CreativePipelineInput {
  /** Markdown script (the format used in D:\down\自作聪明的傻狐狸.md). */
  script_markdown: string;
  /** Optional: restrict total number of shots (default 12, hard cap 30). */
  max_shots?: number;
  /** Output directory for downloaded MP4s (default code/result/creative). */
  output_dir?: string;
  /** Project name (used for subdirectory naming). */
  project_name?: string;
  /**
   * Reference image URLs (data URLs or http(s) URLs) for subject consistency.
   * - First entry (if any) is sent as `first_frame` so every shot anchors on it.
   * - All entries are sent as `reference_image` so Hailuo v2 keeps the subject
   *   consistent across shots.
   * Callers that have local file paths should convert them via
   * `src/util/image_to_dataurl.ts` before passing them in.
   */
  references?: string[];
  /**
   * Video provider model id. Default `'MiniMax-Hailuo-2.3'` (Hailuo v1 API).
   * Switch to e.g. `'MiniMax-H3'` (Hailuo v2) or any future provider's id.
   * Previously hardcoded — now caller-controlled for future-proofing.
   */
  model?: string;
  /**
   * Concurrency for shot submission (parallel Hailuo API calls).
   * Default 3 (matches `config.yaml providers.hailuo-2.3.concurrency`).
   * Setting this to 1 restores the previous serial behaviour.
   */
  concurrency?: number;
  /**
   * Skip the final.mp4 + manifest.json composition step.
   * Default false (always compose). Useful for callers that only want the
   * raw shot clips, e.g. when running inside a larger pipeline that
   * handles composition externally.
   */
  no_compose?: boolean;
}

export interface ShotResult {
  shot_index: number;
  act: number;
  description: string;
  camera_move: string;
  duration: number;
  characters: string[];
  prompt: string;
  video_url: string;
  video_path: string;
  error?: string;
}

export interface CreativePipelineResult {
  script: { title: string; characters: string[]; acts: number };
  shots_total: number;
  shots_succeeded: number;
  shots_failed: number;
  shots: ShotResult[];
  /** P0-3: pre-submit cost estimate (USD + Token Plan credits). */
  estimate?: RunEstimate;
  /**
   * Path to the concatenated `final.mp4` (no voice / BGM / SRT). Set when
   * `shots_succeeded >= 1` AND ffmpeg is installed. `undefined` when the
   * concat step couldn't run (no clips succeeded, ffmpeg missing, etc.).
   */
  final_mp4_path?: string;
  /**
   * Path to `manifest.json` — written whenever `final_mp4_path` is set,
   * AND also as a fallback when ffmpeg is unavailable. The manifest lists
   * each shot's path + duration so external tools (ffmpeg CLI, daVinci,
   * Premiere) can re-concat with custom transitions / audio.
   */
  manifest_path?: string;
}

const DEFAULT_MAX_SHOTS = 12;
const HARD_MAX_SHOTS = 30;
const PER_SHOT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_MODEL = 'MiniMax-Hailuo-2.3';
const DEFAULT_CONCURRENCY = 3;

export class CreativePipeline {
  private readonly pollIntervalMs: number;
  private readonly ffmpeg: FfmpegRunner | { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> };
  constructor(
    private readonly video: VideoProvider,
    opts: { pollIntervalMs?: number; ffmpeg?: { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> } } = {}
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.ffmpeg = opts.ffmpeg ?? new FfmpegRunner();
  }

  async run(input: CreativePipelineInput, signal?: AbortSignal): Promise<CreativePipelineResult> {
    const runStartedAt = Date.now();

    // ── Phase 1: parse + decompose + build prompts ───────────────────────
    logPhase('Parsing script + decomposing into shots', 1, 4);
    const parsed = parseScript(input.script_markdown);
    const maxShots = Math.min(HARD_MAX_SHOTS, input.max_shots ?? DEFAULT_MAX_SHOTS);
    const shots = decomposeIntoShots(parsed, { maxShots });
    const prompts = shots.map((s) => buildHailuoPrompt(s, parsed));
    logWithTs(
      `parsed: title="${parsed.title}" characters=${parsed.characters.length} acts=${parsed.acts.length} → shots=${shots.length}`,
    );

    const projectName = input.project_name ?? `creative_${Date.now()}`;
    const outDir = resolve(input.output_dir ?? 'code/result/creative', projectName, 'clips');
    mkdirSync(outDir, { recursive: true });

    // P0-3: cost pre-estimate (USD + Token Plan credits). Surfaced to CLI / HTTP
    // before any API call lands so the user can decide whether to proceed.
    const estimate = estimateRunCost({
      shots: shots.length,
      duration_per_shot_sec: prompts[0]?.duration ?? 6,
    });

    // ── Phase 2: generate clips (parallel) ─────────────────────────────────
    // v3.4: shots are submitted in chunks of `concurrency` (default 3) so a
    // 4-shot run that used to take 240 s (serial) now takes ~80 s.
    // Per-shot logging / ETA / quality-gate logic is preserved verbatim —
    // just lifted into `_generateOneShot()` so it can run concurrently.
    const model = input.model ?? DEFAULT_MODEL;
    const concurrency = Math.max(1, Math.min(10, input.concurrency ?? DEFAULT_CONCURRENCY));
    logPhase(
      `Generating ${shots.length} clip(s) via ${model} (concurrency=${concurrency})`,
      2, 4,
    );

    // v3.3 (subject-consistency hardening): only the FIRST reference image
    // is used as a `first_frame` anchor. Additional references are DROPPED
    // because Hailuo v2's `reference_image` is a SOFT constraint — passing
    // multiple images makes the model "average" them, producing drifting
    // identities across shots. For HARD identity lock, callers should switch
    // to a provider with character-library support (Kling Element Library,
    // Seedance 12-file multi-modal). See `docs/quality-engineering.md`.
    const refs = input.references ?? [];
    const firstFrameUrl = refs[0];
    if (refs.length > 1) {
      console.warn(
        `[creative_pipeline] ${refs.length} reference images supplied — using only the first as first_frame. ` +
        `Hailuo v2 reference_image is a soft signal; multiple refs cause identity drift. ` +
        `Drop extras or switch to a provider with hard identity lock (Kling Element Library).`,
      );
    }

    // Inner AbortController — when any shot hits quota_exceeded we abort
    // the remaining in-flight shots instead of waiting them out.
    const innerAc = new AbortController();
    const innerSignal = combineSignals(signal, innerAc.signal);

    const results: ShotResult[] = new Array(shots.length);
    let completedShots = 0;
    let quotaAborted = false;

    for (let chunkStart = 0; chunkStart < shots.length; chunkStart += concurrency) {
      if (signal?.aborted) break;
      const chunkLen = Math.min(concurrency, shots.length - chunkStart);
      const chunkIndices = Array.from({ length: chunkLen }, (_, k) => chunkStart + k);

      // Pre-submit progress log for each shot in this chunk (per-shot label).
      for (const j of chunkIndices) {
        const shot = shots[j]!;
        const prompt = prompts[j]!;
        const progressBar = formatProgressBar(j / shots.length);
        logWithTs(
          `[shot ${shot.index}/${shots.length}] ${progressBar} 📤 submitting to ${model} ` +
          `(${prompt.duration}s, refs=${refs.length})`,
        );
      }

      const settled = await Promise.allSettled(
        chunkIndices.map((j) =>
          this._generateOneShot(shots[j]!, prompts[j]!, model, firstFrameUrl, outDir, innerSignal)
            .then((r) => ({ j, r }))
        ),
      );

      for (let k = 0; k < chunkIndices.length; k++) {
        const j = chunkIndices[k]!;
        const shot = shots[j]!;
        const prompt = prompts[j]!;
        const settledItem = settled[k]!;

        let result: ShotResult;
        if (settledItem.status === 'fulfilled') {
          result = settledItem.value.r;
        } else {
          // The inner generator should never reject — but guard anyway.
          const msg = settledItem.reason instanceof Error ? settledItem.reason.message : String(settledItem.reason);
          result = emptyResult(shot, prompt, msg);
        }

        results[j] = result;

        // Quota detection: any quota error → cancel remaining in-flight shots.
        if (result.error && /quota/i.test(result.error)) {
          innerAc.abort();
          quotaAborted = true;
        }

        // Per-shot completion log + ETA (skip the "skipped" sentinels).
        const isSkip = result.error?.startsWith('skipped ');
        if (!isSkip) {
          completedShots++;
          const overallProgress = formatProgressBar(completedShots / shots.length);
          const eta = progressEta(completedShots, shots.length, Date.now() - runStartedAt);
          logWithTs(
            `[shot ${shot.index}/${shots.length}] ${overallProgress} ` +
            (result.error ? `❌ ${result.error}` : `✅ done`) +
            ` (eta=${eta}, total elapsed ${formatDuration(Date.now() - runStartedAt)})`,
          );
        }
      }

      // If quota hit, stop launching new chunks.
      if (quotaAborted) break;
    }

    // Fill any remaining slots with skipped-sentinels when quota aborted.
    if (quotaAborted) {
      for (let j = 0; j < shots.length; j++) {
        if (!results[j]) {
          results[j] = emptyResult(shots[j]!, prompts[j]!, 'skipped (run aborted: quota exceeded)');
        }
      }
    }

    // ── Phase 3+4: compose `final.mp4` + write manifest.json ────────────
    // Delegated to `composer.ts` (extracted in v3.4 review refactor).
    // The dub path (`EndToEndCreativePipeline`) re-runs this with voice +
    // BGM + SRT to overwrite the bare-bones concat.
    let finalMp4: string | undefined;
    let manifest: string | undefined;
    if (!input.no_compose) {
      const composed = await composeFinalMp4({
        shots: results,
        out_dir: dirname(outDir), // composer writes at project root, not clips/
        project_name: projectName,
      });
      finalMp4 = composed.final_mp4_path;
      manifest = composed.manifest_path;
    }

    // Final summary line — single line the user can scan.
    const totalElapsed = Date.now() - runStartedAt;
    const succeeded = results.filter((r) => !r.error).length;
    logWithTs(
      `=== run complete: ${succeeded}/${shots.length} succeeded, ` +
      `total=${formatDuration(totalElapsed)}, ` +
      `final.mp4=${finalMp4 ? 'yes' : 'no'}, manifest=${manifest ? 'yes' : 'no'} ===`,
    );

    return {
      script: {
        title: parsed.title,
        characters: parsed.characters.map((c) => c.name),
        acts: parsed.acts.length,
      },
      shots_total: shots.length,
      shots_succeeded: succeeded,
      shots_failed: results.filter((r) => r.error).length,
      shots: results,
      estimate,
      ...(finalMp4 ? { final_mp4_path: finalMp4 } : {}),
      ...(manifest ? { manifest_path: manifest } : {}),
    };
  }

  /**
   * Generate a single shot. Extracted from the serial loop so v3.4 can
   * run shots concurrently via `Promise.allSettled`. Behaviour is
   * preserved verbatim from the previous inline implementation.
   */
  private async _generateOneShot(
    shot: DecomposedShot,
    prompt: HailuoPrompt,
    model: string,
    firstFrameUrl: string | undefined,
    outDir: string,
    signal: AbortSignal | undefined,
  ): Promise<ShotResult> {
    const shotLabel = `[shot ${shot.index}]`;
    const shotStarted = Date.now();

    if (signal?.aborted) {
      return emptyResult(shot, prompt, 'cancelled');
    }

    try {
      const taskId = await withProviderRetry(
        () => this.video.submit({
          model,
          prompt: prompt.prompt,
          duration: prompt.duration,
          resolution: '768P',
          ratio: '16:9',
          ...(firstFrameUrl ? { firstFrameImageUrl: firstFrameUrl } : {}),
          signal,
        }),
        { signal, maxRetries: 2 },
      );
      logWithTs(`${shotLabel} ⏳ task_id=${taskId} polling every ${this.pollIntervalMs / 1000}s`);
      const videoUrl = await pollUntilSucceeded(this.video, taskId, signal, this.pollIntervalMs, shotLabel);
      const ext = videoUrl.includes('.mov') ? '.mov' : '.mp4';
      const filePath = join(outDir, `shot_${String(shot.index).padStart(3, '0')}${ext}`);
      logWithTs(`${shotLabel} ⬇ downloading → ${filePath}`);
      await withProviderRetry(
        () => Promise.resolve(this.ffmpeg.download(videoUrl, filePath, signal)).then(() => filePath),
        { signal, maxRetries: 2 },
      );
      // P0-4: quality gate — probe the downloaded file. Failed clips
      // stay on disk (so the user can inspect) but are marked failed
      // and excluded from `shots_succeeded`.
      // IMPORTANT: probe_unavailable (ffprobe missing) is a SOFT skip —
      // the clip is treated as succeeded because we have no evidence it
      // is broken. Only hard probe failures mark the shot as failed.
      const qc = await checkClipQuality(filePath, { expected_sec: prompt.duration }).catch((e) => {
        console.warn(`${shotLabel} quality probe threw: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (qc && !qc.ok && !qc.reasons.includes('probe_unavailable')) {
        logWithTs(`${shotLabel} ❌ quality gate FAILED (${qc.reasons.join(', ')}) — file kept on disk`);
        return {
          ...emptyResult(shot, prompt, `quality gate failed: ${qc.reasons.join(', ')}`),
          video_path: filePath,
        };
      }
      const qcNote = qc?.reasons.includes('probe_unavailable')
        ? ' (probe skipped: ffprobe not installed)'
        : (qc && qc.reasons.length > 0 ? ` (warnings: ${qc.reasons.join(', ')})` : '');
      const shotElapsedMs = Date.now() - shotStarted;
      logWithTs(
        `${shotLabel} ✅ done in ${formatDuration(shotElapsedMs)}${qcNote}`,
      );
      return {
        shot_index: shot.index,
        act: shot.act,
        description: shot.description,
        camera_move: shot.camera_move,
        duration: shot.duration,
        characters: shot.characters,
        prompt: prompt.prompt,
        video_url: videoUrl,
        video_path: filePath,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ProviderError && e.kind === 'quota_exceeded') {
        // Bubble up quota exhaustion as a recognisable string so the
        // outer loop can detect it via `/quota/i` regex and abort.
        return emptyResult(shot, prompt, `provider quota exhausted: ${msg}`);
      }
      return emptyResult(shot, prompt, msg);
    }
  }
}

/**
 * Combine two AbortSignals into one. The returned signal aborts when
 * EITHER input aborts. Used so a quota-exceeded in one in-flight shot
 * propagates to all other in-flight shots.
 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return ac.signal;
}

async function pollUntilSucceeded(
  provider: VideoProvider,
  taskId: string,
  signal: AbortSignal | undefined,
  intervalMs: number,
  shotLabel = '[poll]'
): Promise<string> {
  const started = Date.now();
  let lastBeat = started;
  while (true) {
    if (signal?.aborted) throw new Error('cancelled');
    if (Date.now() - started > PER_SHOT_TIMEOUT_MS) throw new Error('per-shot timeout (5 min)');
    await new Promise((r) => setTimeout(r, intervalMs));
    const r = await provider.poll(taskId, signal);
    if (r.status === 'succeeded' && r.videoUrl) return r.videoUrl;
    // Time-based heartbeat: log every ~5s so the user knows the run is
    // alive without flooding stdout. `shouldBeat` returns true once at
    // least HEARTBEAT_MS has elapsed since the last beat.
    if (shouldBeat(lastBeat, 5000)) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      logWithTs(`${shotLabel} ⏳ still polling... ${elapsed}s elapsed, status=${r.status}`);
      lastBeat = Date.now();
    }
    if (['failed', 'cancelled', 'expired'].includes(r.status)) {
      throw new Error(`hailuo ${r.status}${r.error ? `: ${r.error}` : ''}`);
    }
  }
}

function emptyResult(shot: DecomposedShot, prompt: HailuoPrompt, error: string): ShotResult {
  return {
    shot_index: shot.index,
    act: shot.act,
    description: shot.description,
    camera_move: shot.camera_move,
    duration: shot.duration,
    characters: shot.characters,
    prompt: prompt.prompt,
    video_url: '',
    video_path: '',
    error,
  };
}

/** Helper: dump pipeline result to a JSON file (for inspection / resume). */
export function writePipelineReport(result: CreativePipelineResult, path: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2), 'utf-8');
}
