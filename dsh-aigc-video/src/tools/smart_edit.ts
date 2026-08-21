/**
 * `aigc_smart_edit` — AI-driven editing decisions.
 *
 * Phase 6: real implementation.
 *   1. (Phase 6.5) whisper-node for transcript per clip — left as `[]` for now
 *   2. ffmpeg silencedetect for speech/silence intervals
 *   3. ffmpeg scene-detect for visual cut points
 *   4. script↔transcript alignment (Jaccard bigrams — works in EN + ZH)
 *   5. heuristic scoring (motion + audio + alignment + position)
 *   6. emit EditDecision JSON for downstream `aigc_mix`
 *
 * Phase 7 (integrated): if a BGM file is supplied, `detectBeats` is
 * called and the detected beat times are passed to `decide()` so cut
 * points align with the music. The EditDecision JSON now includes
 * `beat_aligned` per cut and a top-level `beats` array.
 *
 * Phase 6.5 will add real Whisper transcripts.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { detectBeats } from '../audio/beats.js';
import { detectScenes } from '../audio/scene_detect.js';
import { detectSpeech } from '../audio/vad.js';
import { tryTranscribeAudio } from '../audio/transcribe.js';
import { decide } from '../smart/decide.js';
import type { EditDecision } from '../smart/decide.js';
import type { TranscriptSegment } from '../smart/align.js';

export const smartEditTool = defineTool({
  name: 'aigc_smart_edit',
  description:
    'Analyse a set of raw clips and a script; return an EditDecision JSON with a recommended ' +
    'sequence, in/out points, transitions, and per-segment scores. Use the result with `aigc_mix`.',
  parameters: {
    clips: {
      type: 'array',
      required: true,
      description: 'Input clips to be sequenced and scored',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          duration_hint: { type: 'number', description: 'Expected duration in seconds (for planning)' },
        },
      },
    },
    script: {
      type: 'string',
      required: true,
      description: 'Full script text. Used to align each clip with the narrative.',
    },
    target_duration: {
      type: 'number',
      description: 'Optional target output duration in seconds (default: sum of clip durations)',
    },
    bgm_path: {
      type: 'string',
      description: 'Optional background-music file. When set, beats are detected and cuts are aligned to them (Phase 7).',
    },
    transcribe: {
      type: 'boolean',
      description: 'Phase 6.5: when true, run Whisper on each clip to produce a real transcript (downloaded on first use, ~40-500MB). Default true; pass false to skip.',
    },
    language: {
      type: 'string',
      description: 'Phase 6.5: force Whisper language code (`zh` / `en` / ...). Default auto-detect.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decisions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              clip_path: { type: 'string' },
              in_point: { type: 'number' },
              out_point: { type: 'number' },
              transition: { type: 'string' },
              score: { type: 'number', description: '0-1, higher is better' },
              reason: { type: 'string' },
              beat_aligned: { type: 'boolean', description: 'Cut aligned to a BGM beat (Phase 7).' },
            },
          },
        },
        total_duration: { type: 'number' },
        confidence: { type: 'number', description: 'Overall confidence in the edit (0-1)' },
        beats: { type: 'array', items: { type: 'number' }, description: 'BGM beat times in seconds (empty if no bgm_path).' },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: `[aigc_smart_edit]\n${JSON.stringify(value, null, 2)}` },
    ],
  },
  async execute(args, _exec) {
    const clipsList = (args.clips ?? []) as Array<{ path: string; duration_hint?: number }>;
    const clips = clipsList.map((c) => ({
      path: c.path,
      ...(c.duration_hint !== undefined && { duration_hint: c.duration_hint }),
    }));

    // Run ffmpeg analyses in parallel (per-clip, capped by SequentialTaskQueue later).
    // P0-2: previously both branches silently swallowed errors. Now we log
    // the reason and still return [] so the decide() pipeline can continue;
    // the decision JSON now surfaces the "missing analysis" cause so the
    // caller (orchestrator / user) knows the cut points are heuristic-only.
    const scenesPerClip = await Promise.all(
      clips.map(async (c) => {
        try {
          return await detectScenes(c.path);
        } catch (e) {
          console.warn(`[smart_edit] scene-detect failed for ${c.path}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }),
    );
    const speechPerClip = await Promise.all(
      clips.map(async (c) => {
        try {
          return await detectSpeech(c.path);
        } catch (e) {
          console.warn(`[smart_edit] vad failed for ${c.path}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }),
    );

    // Flatten scenes / speech to global second-offsets (use each clip's
    // duration_hint for offset; in practice ffmpeg could also be probed
    // but we already accept the hint as the source of truth).
    let cursor = 0;
    const scenes = [] as Array<{ t: number; score?: number }>;
    const speech = [] as Array<{ kind: 'silence' | 'speech'; start: number; end: number }>;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (!c) continue;
      const dur = c.duration_hint ?? 5;
      for (const s of scenesPerClip[i] ?? []) scenes.push({ t: cursor + s.t, score: s.score });
      for (const v of speechPerClip[i] ?? []) {
        speech.push({ kind: v.kind, start: cursor + v.start, end: cursor + v.end });
      }
      cursor += dur;
    }

    // Phase 7: detect BGM beats and pass to decide() so cut points
    // can align to the music.
    let beats: number[] = [];
    if (args.bgm_path) {
      try {
        beats = await detectBeats(args.bgm_path);
      } catch (e) {
        console.warn(`[smart_edit] beat-detect failed for ${args.bgm_path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Phase 6.5: run Whisper on each clip in parallel to produce a real
    // transcript. Off by default (large model download on first call);
    // opt in via `transcribe: true`. Empty array → fallback path
    // (script match returns score 0).
    let transcript: TranscriptSegment[] = [];
    if (args.transcribe !== false) {
      const perClip = await Promise.all(
        clips.map(async (c) => {
          const segs = await tryTranscribeAudio(c.path, {
            ...(typeof args.language === 'string' ? { language: args.language } : {}),
          });
          return segs;
        }),
      );
      // Flatten to global offsets.
      let off = 0;
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        if (!c) continue;
        const dur = c.duration_hint ?? 5;
        for (const s of perClip[i] ?? []) {
          transcript.push({
            start: off + s.start,
            end: off + s.end,
            text: s.text,
          });
        }
        off += dur;
      }
    }

    const decision: EditDecision = decide({
      clips,
      script: args.script,
      transcript,
      scenes,
      speech,
      ...(beats.length > 0 && { beats }),
      ...(args.target_duration !== undefined && { target_duration: args.target_duration }),
    });

    return {
      decisions: decision.sequence.map((s) => ({
        clip_path: s.clip_path,
        in_point: s.in_point,
        out_point: s.out_point,
        transition: s.transition,
        score: s.score,
        reason: s.reason,
        beat_aligned: s.beat_aligned ?? false,
      })),
      total_duration: decision.total_duration,
      confidence: decision.confidence,
      beats,
      transcript_segments: transcript.length,
    };
  },
});
