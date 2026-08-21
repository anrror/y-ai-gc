/**
 * Cost estimator unit tests (P0-3).
 */

import { describe, expect, it } from 'vitest';
import { estimateRunCost, HAILUO_2_3_USD_PER_SEC } from '../src/cost/estimator.js';

describe('estimateRunCost', () => {
  it('returns zeros for an empty run', () => {
    const e = estimateRunCost({ shots: 0, duration_per_shot_sec: 6 });
    expect(e.breakdown.video_usd).toBe(0);
    expect(e.breakdown.image_usd).toBe(0);
    expect(e.breakdown.tts_usd).toBe(0);
    expect(e.breakdown.total_usd).toBe(0);
    expect(e.breakdown_tokens.total).toBe(0);
    expect(e.notes).toEqual([]);
  });

  it('calculates video cost from shots × duration × rate', () => {
    const e = estimateRunCost({ shots: 6, duration_per_shot_sec: 6 });
    // 6 × 6 × HAILUO_2_3_USD_PER_SEC rounded to 2 decimals
    const expected = Math.round(6 * 6 * HAILUO_2_3_USD_PER_SEC * 100) / 100;
    expect(e.breakdown.video_usd).toBe(expected);
    expect(e.notes).toEqual([]);
  });

  it('snaps non-legal duration (e.g. 8s → 6s) and records note', () => {
    const e = estimateRunCost({ shots: 1, duration_per_shot_sec: 8 });
    expect(e.notes.some((n) => /snapped/.test(n))).toBe(true);
    // 1 × 6 (snapped) × rate, rounded to 2 decimals
    const expected = Math.round(6 * HAILUO_2_3_USD_PER_SEC * 100) / 100;
    expect(e.breakdown.video_usd).toBe(expected);
  });

  it('includes reference images and TTS cost', () => {
    const e = estimateRunCost({
      shots: 3, duration_per_shot_sec: 6,
      reference_images: 4, tts_chars: 1000,
    });
    expect(e.breakdown.image_usd).toBeGreaterThan(0);
    expect(e.breakdown.tts_usd).toBeGreaterThan(0);
    expect(e.breakdown.total_usd).toBeGreaterThan(e.breakdown.video_usd);
  });

  it('produces integer token counts that roughly match USD', () => {
    const e = estimateRunCost({ shots: 10, duration_per_shot_sec: 6 });
    // token = ceil(usd × 1000)
    expect(Number.isInteger(e.breakdown_tokens.total)).toBe(true);
    expect(e.breakdown_tokens.video).toBeGreaterThan(0);
  });
});