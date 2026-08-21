/**
 * aigc_smart_edit mock test — mocks the ffmpeg-backed audio modules so
 * the tool's pure decide() pipeline can be verified without a real ffmpeg.
 *
 * Run:  npx vitest run tests/smart_edit.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the ffmpeg-backed audio modules BEFORE importing the tool so the
// mocks are in place when the tool's module-level imports resolve.
vi.mock('../src/audio/scene_detect.js', () => ({
  detectScenes: vi.fn(async () => [
    { t: 1.2, score: 0.6 },
    { t: 3.8, score: 0.5 },
  ]),
}));
vi.mock('../src/audio/vad.js', () => ({
  detectSpeech: vi.fn(async () => [
    { kind: 'speech', start: 0.5, end: 2.5 },
    { kind: 'silence', start: 2.5, end: 3.0 },
  ]),
}));
vi.mock('../src/audio/beats.js', () => ({
  detectBeats: vi.fn(async () => [1.0, 2.0, 3.0, 4.0]),
}));
// Phase 6.5: mock Whisper transcribe so the smart_edit test doesn't try
// to download the Whisper model from HuggingFace during CI. Return a
// canned transcript with non-trivial overlap so the Jaccard alignment
// produces a measurable confidence bump.
vi.mock('../src/audio/transcribe.js', () => ({
  tryTranscribeAudio: vi.fn(async () => [
    { start: 0.0, end: 2.5, text: 'a hero rises at dawn walks into the unknown' },
    { start: 2.5, end: 5.0, text: 'continues the journey onward into the unknown' },
  ]),
}));

import { smartEditTool } from '../src/tools/smart_edit.js';

let tmpDir: string;
let clipA: string;
let clipB: string;
let clipC: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'smart-edit-test-'));
  clipA = join(tmpDir, 'a.mp4');
  clipB = join(tmpDir, 'b.mp4');
  clipC = join(tmpDir, 'c.mp4');
  for (const p of [clipA, clipB, clipC]) writeFileSync(p, '');
});

afterAll(() => {
  // chdir away first on Windows to avoid EPERM on locked files.
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* best-effort */
  }
});

describe('aigc_smart_edit (mocked audio)', () => {
  it('emits a sequence entry for each clip with score + transition', async () => {
    const result = (await smartEditTool.execute(
      {
        clips: [
          { path: clipA, duration_hint: 5 },
          { path: clipB, duration_hint: 5 },
          { path: clipC, duration_hint: 5 },
        ],
        script: 'A hero rises at dawn and walks into the unknown.',
      },
      { signal: undefined } as never,
    )) as {
      decisions: Array<{ clip_path: string; in_point: number; out_point: number; transition: string; score: number }>;
      total_duration: number;
      confidence: number;
    };

    expect(result.decisions.length).toBe(3);
    expect(result.decisions[0]?.clip_path).toBe(clipA);
    expect(result.decisions[0]?.in_point).toBe(0);
    expect(result.decisions[0]?.out_point).toBe(5);
    // First clip transitions with a 'cut'; subsequent clips with crossfade.
    expect(result.decisions[0]?.transition).toBe('cut');
    expect(result.decisions[1]?.transition).toBe('crossfade');
    // Scores must be 0..1.
    for (const d of result.decisions) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(1);
    }
    // total_duration is the sum of clip durations minus per-transition overlap.
    expect(result.total_duration).toBeGreaterThan(0);
    // Confidence is the average per-item score, in [0, 1].
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('respects target_duration and drops lowest-scored tail items', async () => {
    const result = (await smartEditTool.execute(
      {
        clips: [
          { path: clipA, duration_hint: 10 },
          { path: clipB, duration_hint: 10 },
          { path: clipC, duration_hint: 10 },
        ],
        script: 'A short promo cut.',
        target_duration: 15,
      },
      { signal: undefined } as never,
    )) as { decisions: Array<{ clip_path: string; out_point: number }>; total_duration: number };

    // 3 clips × 10s = 30s; target = 15s → 2 clips dropped, 1 remains.
    expect(result.decisions.length).toBeLessThanOrEqual(2);
    expect(result.total_duration).toBeLessThanOrEqual(15);
  });

  it('handles empty clips gracefully', async () => {
    const result = (await smartEditTool.execute(
      { clips: [], script: 'nothing to cut' },
      { signal: undefined } as never,
    )) as { decisions: unknown[]; total_duration: number; confidence: number };

    expect(result.decisions).toEqual([]);
    expect(result.total_duration).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it('Phase 7: aligns cuts to BGM beats when bgm_path is set', async () => {
    const bgmPath = join(tmpDir, 'bgm.mp3');
    writeFileSync(bgmPath, '');
    const result = (await smartEditTool.execute(
      {
        clips: [
          { path: clipA, duration_hint: 5 },
          { path: clipB, duration_hint: 5 },
        ],
        script: 'Two shots with music behind them.',
        bgm_path: bgmPath,
      },
      { signal: undefined } as never,
    )) as {
      decisions: Array<{ clip_path: string; beat_aligned: boolean }>;
      beats: number[];
    };

    // detectBeats mock returns [1,2,3,4]; scenes at t=1.2 / 3.8 snap to
    // nearest beats within ±0.3s → 1.2→1.0 and 3.8→4.0 are aligned.
    expect(result.beats).toEqual([1.0, 2.0, 3.0, 4.0]);
    // First clip's scene (1.2) aligns to beat 1.0.
    expect(result.decisions[0]?.beat_aligned).toBe(true);
  });

  it('Phase 7: no bgm_path → no beats, no beat-aligned flags', async () => {
    const result = (await smartEditTool.execute(
      {
        clips: [{ path: clipA, duration_hint: 5 }],
        script: 'Single shot, no music.',
      },
      { signal: undefined } as never,
    )) as { decisions: Array<{ beat_aligned: boolean }>; beats: number[] };

    expect(result.beats).toEqual([]);
    for (const d of result.decisions) expect(d.beat_aligned).toBe(false);
  });

  it('Phase 6.5: Whisper transcript improves decision confidence', async () => {
    const result = (await smartEditTool.execute(
      {
        clips: [
          { path: clipA, duration_hint: 5 },
          { path: clipB, duration_hint: 5 },
        ],
        script: 'a hero rises at dawn and walks into the unknown',
      },
      { signal: undefined } as never,
    )) as { decisions: Array<{ score: number }>; confidence: number; transcript_segments: number };

    // Mocked Whisper produces 2 segments per clip = 4 total (flattened).
    expect(result.transcript_segments).toBeGreaterThan(0);
    // Confidence should be non-zero (transcript fed into alignment).
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('Phase 6.5: transcribe:false skips Whisper entirely', async () => {
    const result = (await smartEditTool.execute(
      {
        clips: [{ path: clipA, duration_hint: 5 }],
        script: 'anything',
        transcribe: false,
      },
      { signal: undefined } as never,
    )) as { transcript_segments: number };

    expect(result.transcript_segments).toBe(0);
  });
});