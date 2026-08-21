/**
 * End-to-end creative pipeline (Phase 5.5+ → v3.1).
 *
 * Chains the existing pieces into one call:
 *   parseScript → decomposeIntoShots → buildHailuoPrompt
 *     → CreativePipeline.run (Hailuo video clips)
 *     → rule-based voice assignment + MiniMax T2A v2 TTS per line
 *     → assemble SRT from TTS lines
 *     → VideoMixer (concat + xfade + per-shot voice tracks + BGM + SRT burn-in)
 *     → final.mp4
 *
 * Zero-LLM: voice_id is assigned by `voice_rules.ts` (Chinese-name
 * heuristic), emotion is derived from shot context, no script-LLM call.
 * This preserves the creative workflow's "pure rule-based" promise.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseScript } from './script_parser.js';
import type { ParsedScript } from './script_parser.js';
import { decomposeIntoShots } from './shot_decomposer.js';
import type { DecomposedShot } from './shot_decomposer.js';
import { CreativePipeline } from './creative_pipeline.js';
import type { ShotResult } from './creative_pipeline.js';
import { assignVoicesByRule } from './voice_rules.js';
import type { CharacterVoice } from './voice_rules.js';
import { writeSrt, buildSrt } from './srt.js';
import type { SrtLine } from './srt.js';

import type { VideoProvider, TtsProvider } from '../providers/types.js';
import { VideoMixer } from '../video/mixer.js';
import type { MixRequest } from '../video/mixer.js';
import type { TransitionKind } from '../video/transitions.js';

export interface EndToEndInput {
  /** Markdown script (same format CreativePipeline accepts). */
  script_markdown: string;
  /** Cap number of shots (default 12, hard cap 30). */
  max_shots?: number;
  /** Optional BGM track — layered under voice at ~25% volume. */
  bgm_path?: string;
  /** Optional project name (used as subdirectory). */
  project_name?: string;
  /** Optional output dir override (default code/result/e2e/<project>). */
  output_dir?: string;
  /** Skip TTS + SRT + voice-mix (default false). */
  no_dub?: boolean;
  /** Skip BGM (default false). */
  no_bgm?: boolean;
  /**
   * Reference image URLs (data URLs or http(s) URLs) for subject consistency.
   * Forwarded to CreativePipeline.run so every shot anchors on the first
   * reference and keeps the subject consistent across the dub-mixed final.mp4.
   */
  references?: string[];
  /**
   * Subtitle generation strategy.
   *   - `'dialog'`    — only emit SRT cues from `**character**: text` blocks
   *                     (requires TTS; empty SRT if no dialog).
   *   - `'act-title'` — emit one SRT cue per `**【act】**` heading, spanning the
   *                     cumulative duration of all shots in that act. Works
   *                     for action-only / voice-less scripts (martial arts,
   *                     scenery, documentary cuts).
   *   - `'auto'`      — default. Pick `dialog` when the script has dialog,
   *                     otherwise fall back to `act-title`.
   */
  subtitle_mode?: 'dialog' | 'act-title' | 'auto';
}

export interface EndToEndLine {
  shot_index: number;
  character: string;
  voice_id: string;
  text: string;
  audio_path: string;
}

export interface EndToEndResult {
  project: string;
  script: { title: string; characters: string[]; acts: number };
  shots_total: number;
  shots_succeeded: number;
  shots_failed: number;
  shots: ShotResult[];
  /** Per-line voice-over results. */
  lines: EndToEndLine[];
  /** Path of the generated SRT (always written, may be empty if no_dub). */
  srt_path: string;
  /** Path of the final mixed MP4. */
  final_mp4_path: string;
  /** When the run aborted due to quota, this is set. */
  aborted_reason?: string;
}

const DEFAULT_MAX_SHOTS = 12;
const HARD_MAX_SHOTS = 30;

/**
 * Walk the parsed script's acts and pick the first dialog line per
 * shot whose `characters` array matches the dialog speaker. Returns
 * `{ shot_index, character, text }` triples; shots without dialog
 * (action-only) are skipped — those shots have no TTS.
 *
 * The dialog extraction is intentionally simple: line starts with
 * `**Name**：` (Chinese colon) is treated as `Name: text`.
 */
function extractDialog(parsed: ParsedScript, shots: DecomposedShot[]): Array<{ shot_index: number; character: string; text: string }> {
  const out: Array<{ shot_index: number; character: string; text: string }> = [];
  for (const shot of shots) {
    const chars = shot.characters;
    if (!chars.length) continue;
    // Look through all acts for the first dialog line whose speaker
    // is in this shot's characters.
    let matched = false;
    for (const act of parsed.acts) {
      for (const block of act.blocks) {
        if (block.kind !== 'dialog') continue;
        if (!chars.includes(block.character)) continue;
        out.push({
          shot_index: shot.index,
          character: block.character,
          text: block.text,
        });
        matched = true;
        break;
      }
      if (matched) break;
    }
  }
  return out;
}

/**
 * Run the full pipeline: md → N videos → TTS → SRT → mux → final.mp4.
 */
export class EndToEndCreativePipeline {
  constructor(
    private readonly video: VideoProvider,
    private readonly tts: TtsProvider,
    private readonly opts: {
      outputDir?: string;
      ffmpegRunner?: unknown;
    } = {},
  ) {}

  async run(input: EndToEndInput, signal?: AbortSignal): Promise<EndToEndResult> {
    const parsed = parseScript(input.script_markdown);
    const maxShots = Math.min(HARD_MAX_SHOTS, input.max_shots ?? DEFAULT_MAX_SHOTS);
    const shots = decomposeIntoShots(parsed, { maxShots });

    const projectName = input.project_name ?? `e2e_${Date.now()}`;
    const baseDir = resolve(input.output_dir ?? 'code/result/e2e', projectName);
    const outDir = baseDir;
    mkdirSync(outDir, { recursive: true });

    // ── Step 1: video clips via CreativePipeline ─────────────────────────
    const cp = new CreativePipeline(this.video, {
      pollIntervalMs: 0, // tests / CLI use 4s default; override-able via opts
      ...(this.opts.ffmpegRunner
        ? { ffmpeg: this.opts.ffmpegRunner as { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> } }
        : {}),
    });
    const cpResult = await cp.run({
      script_markdown: input.script_markdown,
      max_shots: maxShots,
      project_name: projectName,
      output_dir: outDir,
      ...(input.references ? { references: input.references } : {}),
    }, signal);

    const abortedReason = cpResult.shots_failed > 0 && cpResult.shots_succeeded === 0
      ? 'all video clips failed (likely quota exceeded or provider auth error)'
      : undefined;

    // ── Step 2: voice assignment + TTS (when --dub) ──────────────────────
    const lines: EndToEndLine[] = [];
    if (!input.no_dub) {
      // Build CharacterVoice[] with `voice_id` left blank — the rule
      // will assign it.
      const characters: CharacterVoice[] = parsed.characters.map((c) => ({
        name: c.name,
        description: c.description,
      }));
      const voiceByChar = new Map(
        assignVoicesByRule(characters).map((c) => [c.name, c.resolved_voice_id]),
      );

      const dialog = extractDialog(parsed, shots);
      const audioDir = join(baseDir, 'voice');
      mkdirSync(audioDir, { recursive: true });

      for (const d of dialog) {
        if (signal?.aborted) break;
        const voiceId = voiceByChar.get(d.character) ?? 'female-shaonv';
        const safe = slugify(d.character);
        const audioPath = join(audioDir, `shot_${String(d.shot_index).padStart(3, '0')}_${safe}.mp3`);
        try {
          const out = await this.tts.submit({
            text: d.text,
            voiceId,
            outputPath: audioPath,
            format: 'mp3',
          });
          lines.push({
            shot_index: d.shot_index,
            character: d.character,
            voice_id: voiceId,
            text: d.text,
            audio_path: out,
          });
        } catch (e) {
          console.warn(`[e2e] TTS failed for shot ${d.shot_index} (${d.character}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // ── Step 3: SRT generation (always — act-title works without TTS) ────
    // Resolve the subtitle mode once we know whether dialog actually exists.
    const subtitleMode = resolveSubtitleMode(input.subtitle_mode ?? 'auto', lines.length > 0);
    const srtLines: SrtLine[] = buildSrtForMode(
      subtitleMode,
      cpResult.shots,
      parsed,
      lines,
    );
    const srtPath = join(outDir, 'captions.srt');
    writeSrt(srtPath, srtLines);
    if (srtLines.length > 0) {
      console.log(`[e2e] subtitles: ${srtLines.length} cue(s) (mode=${subtitleMode})`);
    }

    // ── Step 4: mux video + voice + BGM + SRT → final.mp4 ───────────────
    const finalPath = join(outDir, 'final.mp4');
    const clipResults = cpResult.shots.filter((s) => !s.error && s.video_path);
    if (clipResults.length === 0) {
      // No clips succeeded — write a placeholder final.mp4 with a note.
      writeFileSync(finalPath + '.README.txt',
        'end-to-end run produced no usable video clips; see report.json for details.\n',
        'utf-8');
      return {
        project: projectName,
        script: {
          title: parsed.title,
          characters: parsed.characters.map((c) => c.name),
          acts: parsed.acts.length,
        },
        shots_total: cpResult.shots_total,
        shots_succeeded: cpResult.shots_succeeded,
        shots_failed: cpResult.shots_failed,
        shots: cpResult.shots,
        lines,
        srt_path: srtPath,
        final_mp4_path: finalPath + '.README.txt',
        ...(abortedReason ? { aborted_reason: abortedReason } : {}),
      };
    }

    // Build per-clip in/out points and matching transitions.
    const transitions: TransitionKind[] = clipResults.map((_, i) => i === 0 ? 'cut' : 'crossfade');
    const mixerReq: MixRequest = {
      clips: clipResults.map((s) => ({
        path: s.video_path,
        in_point: 0,
        out_point: 0, // 0 = use full file (mixer handles)
      })),
      transitions: transitions.map((kind) => ({ kind, duration: 0.5 })),
      output_path: finalPath,
      ...(!input.no_bgm && input.bgm_path ? { bgm_path: input.bgm_path } : {}),
      ...(lines.length > 0 ? { captions_srt: srtPath } : {}),
      // Per-clip voice tracks — VideoMixer accepts `voice_tracks` array
      // parallel to `clips`; absent → silent.
      voice_tracks: clipResults.map((s) => {
        const ln = lines.find((l) => l.shot_index === s.shot_index);
        return ln ? { clip_index: clipResults.indexOf(s), audio_path: ln.audio_path, volume: 1.0 } : null;
      }).filter((v): v is { clip_index: number; audio_path: string; volume: number } => v !== null),
    };

    try {
      const mixer = new VideoMixer();
      await mixer.mix(mixerReq);
    } catch (e) {
      console.warn(`[e2e] final mux failed: ${e instanceof Error ? e.message : String(e)} — clips kept on disk, final.mp4 not produced`);
    }

    return {
      project: projectName,
      script: {
        title: parsed.title,
        characters: parsed.characters.map((c) => c.name),
        acts: parsed.acts.length,
      },
      shots_total: cpResult.shots_total,
      shots_succeeded: cpResult.shots_succeeded,
      shots_failed: cpResult.shots_failed,
      shots: cpResult.shots,
      lines,
      srt_path: srtPath,
      final_mp4_path: finalPath,
      ...(abortedReason ? { aborted_reason: abortedReason } : {}),
    };
  }
}

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || 'char';
}

/**
 * Resolve the requested subtitle mode against actual content availability.
 * - `'auto'`      → use `'dialog'` if the script has dialog, else `'act-title'`
 * - `'dialog'`    → keep; caller must verify hasDialog or accept empty SRT
 * - `'act-title'` → keep unconditionally; works for voice-less scripts
 */
export function resolveSubtitleMode(
  requested: 'dialog' | 'act-title' | 'auto',
  hasDialog: boolean,
): 'dialog' | 'act-title' {
  if (requested === 'auto') return hasDialog ? 'dialog' : 'act-title';
  return requested;
}

/**
 * Build SRT cues for one of the supported modes.
 *   - `'dialog'`:    one cue per TTS line, evenly distributed across its shot
 *   - `'act-title'`: one cue per `**【act】**` heading, spanning cumulative
 *                    duration of all shots in that act
 * Returns [] when no content applies (e.g. `'dialog'` mode but no TTS lines).
 */
export function buildSrtForMode(
  mode: 'dialog' | 'act-title',
  shots: ReadonlyArray<{ shot_index: number; act: number; duration: number }>,
  parsed: ParsedScript,
  lines: ReadonlyArray<{ shot_index: number; character: string; text: string }>,
): SrtLine[] {
  if (mode === 'dialog') {
    const out: SrtLine[] = [];
    let cursor = 0;
    for (const s of shots) {
      const start = cursor;
      const end = cursor + (s.duration ?? 6);
      const inShot = lines.filter((l) => l.shot_index === s.shot_index);
      if (inShot.length > 0) {
        const per = (end - start) / inShot.length;
        inShot.forEach((l, i) => {
          out.push({
            start: start + per * i,
            end: start + per * (i + 1),
            text: `${l.character}：${l.text}`,
          });
        });
      }
      cursor = end;
    }
    return out;
  }

  // 'act-title': one cue per act, spanning all shots in that act.
  const out: SrtLine[] = [];
  let cursor = 0;
  // Build a map from act index → heading. parsed.acts is ordered.
  const actHeadings: string[] = parsed.acts.map((a) => a.heading);

  let currentActIdx: number | undefined;
  let actStart = 0;
  let actEnd = 0;
  for (const s of shots) {
    const segStart = cursor;
    const segEnd = cursor + (s.duration ?? 6);

    if (currentActIdx === undefined) {
      currentActIdx = s.act;
      actStart = segStart;
      actEnd = segEnd;
    } else if (s.act !== currentActIdx) {
      // Flush previous act's cue.
      const heading = actHeadings[currentActIdx] ?? `Act ${currentActIdx + 1}`;
      if (actEnd > actStart) {
        out.push({ start: actStart, end: actEnd, text: heading });
      }
      currentActIdx = s.act;
      actStart = segStart;
      actEnd = segEnd;
    } else {
      actEnd = segEnd;
    }
    cursor = segEnd;
  }
  // Flush the last act.
  if (currentActIdx !== undefined && actEnd > actStart) {
    const heading = actHeadings[currentActIdx] ?? `Act ${currentActIdx + 1}`;
    out.push({ start: actStart, end: actEnd, text: heading });
  }

  return out;
}

// Re-export SRT builder for tests.
export { buildSrt };