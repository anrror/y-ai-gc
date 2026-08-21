/**
 * Tests for qualityAwareGenerate (Phase D).
 */

import { describe, expect, it, vi } from 'vitest';
import { qualityAwareGenerate } from '../src/quality/retry.js';
import { report, reading, type QualityReport } from '../src/quality/contract.js';

describe('qualityAwareGenerate (Phase D)', () => {
  it('returns immediately when first attempt passes', async () => {
    let calls = 0;
    const r = await qualityAwareGenerate<string>(
      'base',
      async () => { calls++; return 'clip-A'; },
      async () => report([reading('subject_consistency', 0.9)]),
      { has_reference_image: true },
    );
    expect(calls).toBe(1);
    expect(r.winner?.result).toBe('clip-A');
    expect(r.attempts).toBe(1);
  });

  it('retries with prompt variation when first attempt fails subject_consistency', async () => {
    const calls: string[] = [];
    let callIdx = 0;
    const r = await qualityAwareGenerate<string>(
      'base',
      async (prompt) => {
        calls.push(prompt);
        // First call returns original prompt + failing quality. Variation
        // calls include strategy prefix, so we make those pass.
        if (prompt.includes('Reference identity') || prompt.includes('Camera direction')) {
          return `clip-${++callIdx}`;
        }
        return `clip-${++callIdx}`;
      },
      async (result) => {
        // First call (original prompt) fails; anything with prefix passes.
        if (result === 'clip-1') {
          return report([reading('subject_consistency', 0.4)], { failureClass: 'identity' });
        }
        return report([reading('subject_consistency', 0.9)]);
      },
      { has_reference_image: true, max_retries: 2 },
    );
    expect(r.winner?.result).toBeTruthy();
    expect(r.winner?.result).not.toBe('clip-1');
    expect(r.attempts).toBeGreaterThan(1);
  });

  it('escalates to human after retry budget exhausted', async () => {
    const r = await qualityAwareGenerate<string>(
      'base',
      async () => 'always-fails',
      async () => report([reading('subject_consistency', 0.2)], { failureClass: 'identity' }),
      { has_reference_image: false, max_retries: 1 },
    );
    expect(r.decision.action).toBe('escalate-to-human');
  });

  it('falls back on technical failure (no retry)', async () => {
    const r = await qualityAwareGenerate<string>(
      'base',
      async () => 'clip',
      async () => report([reading('duration_ok', 0)], { failureClass: 'technical' }),
      { max_retries: 2 },
    );
    expect(r.decision.action).toBe('fallback');
    expect(r.attempts).toBe(1);
  });

  it('returns best-so-far even when all attempts fail (escalation candidate)', async () => {
    const r = await qualityAwareGenerate<string>(
      'base',
      async () => 'clip',
      async () => report([reading('aesthetic_quality', 0.4)]), // never passes
      { max_retries: 1 },
    );
    expect(r.winner?.result).toBe('clip'); // best-so-far kept
    expect(r.decision.action).toBe('escalate-to-human');
  });

  it('aborts when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await qualityAwareGenerate<string>(
      'base',
      async () => 'clip',
      async () => report([reading('subject_consistency', 0.4)]),
      { signal: ctrl.signal },
    );
    expect(r.attempts).toBeLessThanOrEqual(2); // initial + maybe aborted before retry
  });

  it('catches generator exceptions and treats as failed attempt', async () => {
    const r = await qualityAwareGenerate<string>(
      'base',
      async () => { throw new Error('provider-down'); },
      async () => report([reading('subject_consistency', 0.9)]),
      { max_retries: 2 },
    );
    expect(r.winner).toBeNull();
    expect(r.decision.action).toBe('escalate-to-human');
  });

  it('handles retry-seed action (calls generate again with same prompt)', async () => {
    const calls: string[] = [];
    const r = await qualityAwareGenerate<string>(
      'base',
      async (prompt, id) => { calls.push(`${id}:${prompt}`); return 'clip'; },
      async (result, _prompt) => {
        // First call (initial): flicker fails → retry-seed.
        // Second call (retry-seed): passes.
        if (calls.length === 1) return report([reading('temporal_flickering', 0.5)]);
        return report([reading('temporal_flickering', 0.95)]);
      },
      { max_retries: 2 },
    );
    expect(r.winner?.result).toBe('clip');
    expect(calls.length).toBe(2);
  });

  it('history preserves every attempt for audit', async () => {
    const r = await qualityAwareGenerate<string>(
      'base',
      async () => 'clip',
      async () => report([reading('subject_consistency', 0.3)], { failureClass: 'identity' }),
      { has_reference_image: false, max_retries: 1 },
    );
    expect(r.history.length).toBeGreaterThan(1);
    for (const h of r.history) {
      expect(h.attempt).toBeDefined();
      expect(h.decision).toBeDefined();
    }
  });
});