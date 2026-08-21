/**
 * Tests for the Prompt Variation Engine (Phase C).
 */

import { describe, expect, it } from 'vitest';
import {
  buildVariants,
  selectBest,
  variationLoop,
  type VariantCandidate,
} from '../src/quality/variation.js';
import { report, reading, type QualityReport } from '../src/quality/contract.js';

function makeCandidate<R>(strategy: string, composite: number): VariantCandidate<R> {
  return {
    prompt: `prompt-${strategy}`,
    strategy: strategy as never,
    result: null,
    quality: report([reading('subject_consistency', composite)]),
    id: strategy,
  };
}

describe('Prompt Variation Engine (Phase C)', () => {
  it('buildVariants returns n variants with the original first', () => {
    const variants = buildVariants('A cat on a chair', 3, 'reference-emphasis');
    expect(variants.length).toBe(3);
    expect(variants[0]?.strategy).toBe('original');
    expect(variants[0]?.prompt).toBe('A cat on a chair');
    expect(variants[1]?.strategy).not.toBe('original');
    expect(variants[1]?.prompt).toContain('A cat on a chair'); // keeps base
  });

  it('buildVariants includes hinted strategy + a complement', () => {
    const variants = buildVariants('base', 4, 'simpler');
    const strategies = variants.map((v) => v.strategy);
    expect(strategies).toContain('simpler');
    expect(strategies).toContain('longer'); // complement of simpler
    expect(strategies[0]).toBe('original');
  });

  it('buildVariants falls back to all 5 strategies when no hint', () => {
    const variants = buildVariants('base', 6);
    const strategies = new Set(variants.map((v) => v.strategy));
    expect(strategies.size).toBeGreaterThanOrEqual(4);
  });

  it('selectBest returns null when all candidates have null quality', () => {
    const candidates: VariantCandidate[] = [
      { prompt: 'a', strategy: 'original', result: null, quality: null },
      { prompt: 'b', strategy: 'simpler', result: null, quality: null },
    ];
    expect(selectBest(candidates)).toBeNull();
  });

  it('selectBest picks the highest composite score', () => {
    const winner = selectBest([
      makeCandidate('low', 0.3),
      makeCandidate('high', 0.9),
      makeCandidate('mid', 0.6),
    ]);
    expect(winner?.strategy).toBe('high');
  });

  it('selectBest ignores candidates with null quality', () => {
    const winner = selectBest([
      { prompt: 'a', strategy: 'original', result: null, quality: null },
      makeCandidate('live', 0.7),
    ]);
    expect(winner?.strategy).toBe('live');
  });

  it('variationLoop runs generate + gate for each variant and returns best', async () => {
    const calls: Array<{ prompt: string; id: string }> = [];
    const result = await variationLoop(
      'base prompt',
      async (prompt, id) => {
        calls.push({ prompt, id });
        // Return a fake result keyed by strategy so we can verify.
        return prompt.length as unknown;
      },
      async (result, _prompt) => {
        // Higher composite for longer prompts so we can predict winner.
        const v = (result as number) > 100 ? 0.9 : 0.5;
        return report([reading('subject_consistency', v)]);
      },
      { variant_count: 3, concurrency: 1 },
    );
    expect(calls.length).toBe(3);
    expect(result.attempted).toBe(3);
    expect(result.winner).not.toBeNull();
    expect(result.candidates.length).toBe(3);
  });

  it('variationLoop returns null winner when all gates null', async () => {
    const result = await variationLoop(
      'base',
      async () => 42,
      async () => null, // every gate fails
      { variant_count: 2 },
    );
    expect(result.winner).toBeNull();
  });

  it('variationLoop respects signal abort between batches', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await variationLoop(
      'base',
      async () => 42,
      async () => report([reading('subject_consistency', 0.9)]),
      { variant_count: 3, signal: ctrl.signal },
    );
    expect(result.attempted).toBe(0);
  });

  it('variationLoop propagates generate exceptions to candidates', async () => {
    const result = await variationLoop(
      'base',
      async () => { throw new Error('provider-down'); },
      async () => report([reading('subject_consistency', 0.9)]),
      { variant_count: 2, concurrency: 1 },
    );
    expect(result.winner).toBeNull();
    expect(result.candidates.length).toBe(2);
  });
});