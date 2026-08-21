/**
 * Composer — assemble N shot clips into a single playable `final.mp4`.
 *
 * Extracted from `creative_pipeline.ts` so the generation path no longer
 * carries composition concerns (DDD layering). Also gives us a single
 * place to add: parallel ffmpeg invocation, GPU-accelerated mux,
 * per-shot transition metadata, etc.
 *
 * Failure matrix (mirrors the old behaviour):
 *   successfulClips.length = 0   → skip everything
 *   ffmpeg missing               → write manifest.json only
 *   ffmpeg present               → VideoMixer.mix(cut transitions) + manifest.json
 *
 * The dub path (`EndToEndCreativePipeline`) also calls this for the
 * bare-bones concat, then re-runs `VideoMixer.mix()` with voice + BGM +
 * SRT to produce the dub-enhanced `final.mp4`. Composer's manifest is
 * always written so external tools (daVinci / Premiere / ffmpeg CLI) can
 * re-concat with custom settings.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { FfmpegRunner } from '../video/ffmpeg.js';
import { VideoMixer, type MixClip } from '../video/mixer.js';
import { logWithTs, logPhase } from '../util/progress.js';

export interface ComposeInput {
  /** All shot results from `CreativePipeline.run()`. */
  shots: ReadonlyArray<{ shot_index: number; video_path?: string; duration?: number; error?: string }>;
  /** Where to write `final.mp4` + `manifest.json`. */
  out_dir: string;
  /** Project name for the manifest. */
  project_name: string;
}

export interface ComposeResult {
  /** Path to the concatenated `final.mp4`. Undefined when no clips or no ffmpeg. */
  final_mp4_path?: string;
  /** Path to the always-written `manifest.json`. Undefined when no clips. */
  manifest_path?: string;
  /** Number of clips actually composed. */
  composed: number;
}

/**
 * Compose `final.mp4` from the given shots. Returns paths only — the
 * caller decides what to do with the result (log, include in report,
 * overwrite with dub-enhanced version, etc.).
 */
export async function composeFinalMp4(input: ComposeInput): Promise<ComposeResult> {
  const successfulClips: MixClip[] = input.shots
    .filter((s) => !s.error && s.video_path)
    .map((s) => ({ path: s.video_path! }));

  if (successfulClips.length < 1) {
    return { composed: 0 };
  }

  logPhase(`Composing final.mp4 from ${successfulClips.length} clip(s)`, 3, 4);

  const finalMp4Path = join(input.out_dir, 'final.mp4');
  const manifestPath = join(input.out_dir, 'manifest.json');
  mkdirSync(dirname(finalMp4Path), { recursive: true });

  let finalMp4: string | undefined;
  if (ffmpegAvailable()) {
    try {
      const mixer = new VideoMixer(new FfmpegRunner());
      // N-1 cut transitions = hard concat, cheapest path that still
      // produces a single MP4. For dub mode the mixer is re-invoked
      // with voice + BGM + SRT in EndToEndCreativePipeline.
      const transitions = Array.from(
        { length: Math.max(0, successfulClips.length - 1) },
        () => ({ kind: 'cut' as const, duration: 0 }),
      );
      await mixer.mix({ clips: successfulClips, transitions, output_path: finalMp4Path });
      finalMp4 = finalMp4Path;
      logWithTs(`[Phase 3/4] ✅ composed ${finalMp4Path} (${successfulClips.length} clips, cut transitions)`);
    } catch (e) {
      logWithTs(
        `[Phase 3/4] ⚠️  final.mp4 concat failed: ${e instanceof Error ? e.message : String(e)} ` +
        `— writing manifest.json only`,
      );
    }
  } else {
    logWithTs(
      `[Phase 3/4] ⚠️  ffmpeg not installed — skipping final.mp4; writing manifest.json only. ` +
      `Install ffmpeg (winget install ffmpeg) and re-run.`,
    );
  }

  // Always write manifest.json so external tools can re-compose.
  logPhase('Writing manifest.json', 4, 4);
  const manifestPayload = {
    project: input.project_name,
    shots: successfulClips.map((c, i) => ({
      index: i + 1,
      path: c.path,
      duration: input.shots.find((s) => s.video_path === c.path)?.duration ?? null,
    })),
    final_mp4: finalMp4 ?? null,
    composed_at: new Date().toISOString(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifestPayload, null, 2), 'utf-8');
  logWithTs(`[Phase 4/4] ✅ manifest written (${successfulClips.length} shot(s))`);

  return {
    ...(finalMp4 ? { final_mp4_path: finalMp4 } : {}),
    manifest_path: manifestPath,
    composed: successfulClips.length,
  };
}

/**
 * Check whether an ffmpeg binary is reachable. Used by `composeFinalMp4`
 * to decide whether to attempt the actual mux or fall back to manifest-
 * only output.
 *
 * Implementation note: we resolve the binary path lazily inside a try/catch
 * because `FfmpegRunner.resolveBinary()` throws when ffmpeg isn't on
 * PATH (which is the case on most dev machines until `winget install`).
 */
export function ffmpegAvailable(): boolean {
  try {
    const runner = new FfmpegRunner();
    const bin = runner.resolveBinary();
    return Boolean(bin) && existsSync(bin);
  } catch {
    return false;
  }
}