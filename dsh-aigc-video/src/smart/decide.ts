/**
 * Edit-decision assembly.
 *
 * Given a script + transcript + scene changes + speech intervals, build
 * an `EditDecision` JSON: the recommended clip sequence, in/out points,
 * per-segment scores, and chosen transition kinds. This is the payload
 * that `aigc_mix` consumes downstream.
 */

import { alignScriptToTranscript } from './align.js';
import type { TranscriptSegment } from './align.js';
import { scoreCandidate } from './score.js';
import type { CutCandidate } from './score.js';
import type { VadInterval } from '../audio/vad.js';
import type { SceneChange } from '../audio/scene_detect.js';
import type { TransitionKind } from '../video/transitions.js';

export interface SequenceItem {
  clip_path: string;
  in_point: number;
  out_point: number;
  transition: TransitionKind;
  transition_duration: number;
  score: number;
  reason: string;
  /** Phase 7: true if this cut point was aligned to a BGM beat. */
  beat_aligned?: boolean;
}

export interface EditDecision {
  sequence: SequenceItem[];
  total_duration: number;
  confidence: number;
  captions: Array<{ start: number; end: number; text: string }>;
  /** Phase 7: BGM beat times (seconds) used for cut alignment. */
  beats?: number[];
}

export interface DecideInput {
  clips: Array<{ path: string; duration_hint?: number }>;
  script: string;
  transcript?: TranscriptSegment[];
  scenes?: SceneChange[];
  speech?: VadInterval[];
  /** Phase 7: BGM beat times in seconds. If non-empty, cut points snap to nearest beat. */
  beats?: number[];
  target_duration?: number;
}

const DEFAULT_TARGET_DURATION = 30; // seconds, when caller doesn't specify

export function decide(input: DecideInput): EditDecision {
  const matches = input.transcript
    ? alignScriptToTranscript(input.script, input.transcript)
    : [];

  const items: SequenceItem[] = [];
  let total = 0;
  let confidenceSum = 0;

  for (let i = 0; i < input.clips.length; i++) {
    const clip = input.clips[i];
    if (!clip) continue;
    const dur = clip.duration_hint ?? 5;
    // Pull the script match with the highest confidence that fits within
    // this clip. Heuristic: matches come back in script order; if i < matches.length
    // we use matches[i], else fall back to no script alignment.
    const m = matches[i];
    const scriptScore = m?.confidence ?? 0;

    // Find the best scene change inside the clip (or fall back to mid-clip).
    const sceneInside = (input.scenes ?? []).filter(
      (s) => s.t >= 0 && s.t <= dur,
    );
    const bestSceneT = sceneInside.length > 0 ? (sceneInside[0]?.t ?? dur / 2) : dur / 2;

    // Audio energy: simple presence flag (1 if any speech interval overlaps).
    const speechInside = (input.speech ?? []).filter(
      (s) => s.kind === 'speech' && s.end > 0 && s.start < dur,
    );
    const audioScore = speechInside.length > 0 ? 0.7 : 0.3;

    const candidate: CutCandidate = {
      t: bestSceneT,
      sceneScore: sceneInside.length > 0 ? 0.8 : 0.4,
      audioScore,
      scriptScore,
      duration: dur,
    };
    const { score, reason } = scoreCandidate(candidate);

    const inP = 0;
    const outP = dur;

    // Phase 7: snap cut time to nearest BGM beat if available and the
    // current bestSceneT isn't already at one. Boosts the score slightly
    // so downstream aigc_mix prefers beat-aligned cuts.
    let bestSceneTAligned = bestSceneT;
    let beatAligned = false;
    if (input.beats && input.beats.length > 0) {
      // Find the beat closest to bestSceneT within ±0.3s window.
      let bestBeat = -1;
      let bestDist = Infinity;
      for (const b of input.beats) {
        if (b < 0 || b > dur) continue;
        const d = Math.abs(b - bestSceneT);
        if (d < bestDist) { bestDist = d; bestBeat = b; }
      }
      if (bestBeat >= 0 && bestDist < 0.3) {
        bestSceneTAligned = bestBeat;
        beatAligned = true;
      }
    }

    const transition: TransitionKind = i === 0 ? 'cut' : 'crossfade';
    const transitionDuration = 0.5;

    items.push({
      clip_path: clip.path,
      in_point: inP,
      out_point: outP,
      transition,
      transition_duration: transitionDuration,
      score: beatAligned ? Math.min(1, score + 0.05) : score,
      reason: beatAligned ? `${reason}; beat-aligned to ${bestSceneTAligned.toFixed(2)}s` : reason,
      beat_aligned: beatAligned,
    });
    total += dur - (i > 0 ? transitionDuration : 0);
    confidenceSum += score;
  }

  const totalTarget = input.target_duration ?? DEFAULT_TARGET_DURATION;
  // Naive trim: drop the lowest-scored tail until ≤ target (if over).
  let dropped = 0;
  while (total > totalTarget && items.length > 1) {
    // Find the lowest-scored non-first item, drop it.
    let minIdx = -1;
    let minScore = Infinity;
    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (it.score < minScore) {
        minScore = it.score;
        minIdx = i;
      }
    }
    if (minIdx <= 0) break;
    const removed = items.splice(minIdx, 1)[0];
    if (removed) {
      total -= removed.out_point - removed.in_point - removed.transition_duration;
      dropped += 1;
    }
  }

  // Captions: pass through transcript segments.
  const captions = (input.transcript ?? []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
  }));

  return {
    sequence: items,
    total_duration: total,
    confidence: items.length === 0 ? 0 : confidenceSum / items.length,
    captions,
    ...(input.beats && input.beats.length > 0 && { beats: input.beats }),
  };
}