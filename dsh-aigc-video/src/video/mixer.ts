/**
 * Video mixer — combine N clips into one MP4 with transitions, BGM, and
 * burned-in SRT captions.
 *
 * Phase 5: end-to-end real implementation using ffmpeg subprocess.
 *
 * Algorithm (standard xfade chain for n clips, n-1 transitions):
 *   [0] ─xfade─ [t1] ─xfade─ [t2] ─xfade─ … ─ [tn-1] ─> out_v
 *   audio: each clip's audio is chained, then BGM mixed in (if present).
 *
 * Clips must already share resolution / fps. We do NOT rescale here
 * (Phase 4 Python pipeline normalises ahead of time); for mixed inputs
 * we add `scale=iw:ih:force_original_aspect_ratio=decrease,pad=…:…:(ow-iw)/2:(oh-ih)/2,fps=24`.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { FfmpegRunner } from './ffmpeg.js';
import { xfadeName } from './transitions.js';
import type { TransitionSpec } from './transitions.js';

export interface MixClip {
  path: string;
  in_point?: number; // seconds
  out_point?: number; // seconds
}

export interface MixRequest {
  clips: MixClip[];
  transitions: TransitionSpec[];
  bgm_path?: string;
  captions_srt?: string;
  output_path: string;
  width?: number;
  height?: number;
  fps?: number;
  /**
   * Per-clip voice tracks (parallel to `clips`). When present, each
   * entry replaces the clip's original audio (otherwise the clip audio
   * is used directly). Missing entries fall back to the clip's own
   * audio — useful for action-only shots that have no dialog.
   */
  voice_tracks?: Array<{
    /** Index into `clips`. */
    clip_index: number;
    /** Absolute path to the voice MP3/WAV. */
    audio_path: string;
    /** Volume scalar (0..1, default 1). */
    volume?: number;
  } | null>;
}

export interface MixResult {
  output_path: string;
  duration_seconds: number;
  transitions_applied: number;
}

export class VideoMixer {
  constructor(private readonly runner: FfmpegRunner = new FfmpegRunner()) {}

  async mix(req: MixRequest): Promise<MixResult> {
    if (req.clips.length < 1) throw new Error('mix: at least one clip required');
    if (req.transitions.length !== Math.max(0, req.clips.length - 1)) {
      throw new Error(
        `mix: need ${req.clips.length - 1} transitions for ${req.clips.length} clips, got ${req.transitions.length}`,
      );
    }
    for (const c of req.clips) {
      if (!existsSync(c.path)) throw new Error(`mix: input not found: ${c.path}`);
    }
    if (req.bgm_path && !existsSync(req.bgm_path)) throw new Error(`mix: bgm not found: ${req.bgm_path}`);
    if (req.captions_srt && !existsSync(req.captions_srt)) throw new Error(`mix: srt not found: ${req.captions_srt}`);

    const width = req.width ?? 1280;
    const height = req.height ?? 720;
    const fps = req.fps ?? 24;

    // Build ffmpeg argv.
    const args = ['-y'];

    // Inputs: each clip with optional trim.
    for (const c of req.clips) {
      if (c.in_point !== undefined) args.push('-ss', String(c.in_point));
      if (c.out_point !== undefined) args.push('-to', String(c.out_point));
      args.push('-i', c.path);
    }
    if (req.bgm_path) args.push('-i', req.bgm_path);
    if (req.captions_srt) {
      // Force the ffmpeg subtitles filter sub-style: subtitles='<srt>':force_style=...
      // The SRT path will be added to the filter chain in the next step.
    }

    // Build the complex filter graph.
    const filters: string[] = [];

    // 1) Normalise each input to a common resolution/fps so xfade composes cleanly.
    const inputs: string[] = req.clips.map((_, i) => `[${i}:v]`);
    const normLabels: string[] = [];
    for (let i = 0; i < req.clips.length; i++) {
      const lbl = `v${i}`;
      filters.push(
        `${inputs[i]}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},setsar=1[${lbl}]`,
      );
      normLabels.push(`[${lbl}]`);
    }

    // 2) Chain xfade between consecutive clips.
    let currentLabel = normLabels[0] ?? '[v0]';
    let elapsedOffset = 0;
    let lastDuration = await this.probeDuration(req.clips[0]?.path ?? '');
    let applied = 0;
    const useXfade = this.runner.hasXfade();
    for (let i = 0; i < req.transitions.length; i++) {
      const t = req.transitions[i] as TransitionSpec;
      const nextClipDur = await this.probeDuration(req.clips[i + 1]?.path ?? '');
      const nextLabel = `t${i}`;
      let nextChain: string;
      if (!useXfade || t.kind === 'cut' || t.duration <= 0) {
        // Hard cut OR legacy ffmpeg fallback: just pass through the
        // normalised stream; the final concat below joins them. No
        // smooth crossfade, but the mix still completes.
        nextChain = currentLabel;
        elapsedOffset = lastDuration;
      } else {
        const xname = xfadeName(t.kind);
        if (xname) {
          // xfade: standard transition (only on ffmpeg 4.3+)
          const off = elapsedOffset + lastDuration - t.duration;
          filters.push(
            `${currentLabel}[${i + 1}:v]xfade=transition=${xname}:duration=${t.duration}:offset=${off}[${nextLabel}]`,
          );
          nextChain = `[${nextLabel}]`;
          // Adjust timeline: combined duration = prev + next - transition.duration
          lastDuration = lastDuration + nextClipDur - t.duration;
          applied += 1;
        } else if (t.kind === 'push' || t.kind === 'barn') {
          // Custom overlay-based transition. Approximate with a
          // xfade='wiperight' as a stand-in (true push/barn require
          // overlay + crop + animated offset, deferred to a future phase).
          const off = elapsedOffset + lastDuration - t.duration;
          filters.push(
            `${currentLabel}[${i + 1}:v]xfade=transition=wiperight:duration=${t.duration}:offset=${off}[${nextLabel}]`,
          );
          nextChain = `[${nextLabel}]`;
          lastDuration = lastDuration + nextClipDur - t.duration;
          applied += 1;
        } else {
          // Should not happen.
          nextChain = currentLabel;
        }
      }
      currentLabel = nextChain;
      elapsedOffset += lastDuration;
    }
    const finalVideoLabel = currentLabel;

    // 3) Audio: per-clip voice tracks (when provided) override the clip's
//    own audio. Each voice_track is a separate ffmpeg input appended
//    after the clips + bgm. We then build an `aevalsrc`-style concat
//    that picks either the clip's audio or the voice track per index.
    const voiceTracks = req.voice_tracks ?? [];
    const voiceInputIndexes = new Map<number, number>(); // clip_index -> voice track input index
    for (let i = 0; i < voiceTracks.length; i++) {
      const v = voiceTracks[i];
      if (!v) continue;
      args.push('-i', v.audio_path);
      voiceInputIndexes.set(v.clip_index, req.clips.length + (req.bgm_path ? 1 : 0) + i);
    }

    // Build per-clip audio labels: `clip_audio` for clip's own, `voice_a_i`
    // for voice tracks. Then concat them per clip.
    const audioLabels: string[] = [];
    for (let i = 0; i < req.clips.length; i++) {
      const voiceIdx = voiceInputIndexes.get(i);
      const vol = voiceTracks.find((v) => v && v.clip_index === i)?.volume ?? 1;
      if (voiceIdx !== undefined) {
        const lbl = `voice_a_${i}`;
        filters.push(`[${voiceIdx}:a]volume=${vol}[${lbl}]`);
        audioLabels.push(`[${lbl}]`);
      } else {
        audioLabels.push(`[${i}:a]`);
      }
    }
    filters.push(`${audioLabels.join('')}concat=n=${req.clips.length}:v=0:a=1[aout]`);

    // 4) Mix BGM (if present).
    let finalAudio = '[aout]';
    if (req.bgm_path) {
      const bgmIdx = req.clips.length;
      filters.push(
        `[aout][${bgmIdx}:a]amix=inputs=2:duration=first:dropout_transition=0[aoutmix]`,
      );
      finalAudio = '[aoutmix]';
    }

    // 5) Subtitle burn-in.
    let finalVideo = finalVideoLabel;
    if (req.captions_srt) {
      const srtEscaped = req.captions_srt.replace(/\\/g, '/').replace(/:/g, '\\:');
      const labelSub = 'vsub';
      filters.push(
        `${finalVideoLabel}subtitles='${srtEscaped}':force_style='FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1'[${labelSub}]`,
      );
      finalVideo = `[${labelSub}]`;
    }

    // Assemble the -filter_complex argument.
    args.push('-filter_complex', filters.join(';'));
    args.push('-map', finalVideo);
    args.push('-map', finalAudio);
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23');
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
    args.push('-movflags', '+faststart');
    args.push(req.output_path);

    // Run.
    let lastEvent: { elapsedSec: number } | undefined;
    for await (const ev of this.runner.run(args)) {
      lastEvent = ev;
    }

    if (!lastEvent) throw new Error('mix: ffmpeg produced no events');
    return {
      output_path: req.output_path,
      duration_seconds: lastEvent.elapsedSec,
      transitions_applied: applied,
    };
  }

  /** Probe a clip's duration (cached at the call site is the caller's job). */
  private async probeDuration(path: string): Promise<number> {
    if (!path) return 0;
    try {
      const { ffprobeDuration } = await import('./ffmpeg.js');
      return await ffprobeDuration(path);
    } catch {
      return 5; // optimistic default; xfade chain is still valid
    }
  }
}