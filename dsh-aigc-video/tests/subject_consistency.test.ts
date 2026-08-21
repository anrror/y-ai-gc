/**
 * Tests for subject_consistency gate (E).
 *
 * Verifies shape (returns number | null) and hammingSimilarity math.
 * Real video frame extraction needs an ffmpeg-available environment;
 * we test the pure-math helpers here.
 */

import { describe, expect, it } from 'vitest';
import { hammingSimilarity, pHash } from '../src/quality/subject_consistency.js';

describe('subject_consistency helpers (Phase E)', () => {
  it('pHash returns 64-bit hash for input buffer', () => {
    const buf = Buffer.alloc(1024, 0xaa);
    const h = pHash(buf);
    expect(typeof h).toBe('bigint');
    expect(h.toString(2).length).toBeLessThanOrEqual(64);
  });

  it('pHash is deterministic for identical input', () => {
    const buf = Buffer.alloc(1024, 0xab);
    expect(pHash(buf)).toBe(pHash(buf));
  });

  it('pHash differs for different input patterns', () => {
    const a = Buffer.alloc(1024, 0x00);
    const b = Buffer.alloc(1024, 0xff);
    expect(pHash(a)).not.toBe(pHash(b));
  });

  it('hammingSimilarity returns 1.0 for identical hashes', () => {
    const h = pHash(Buffer.alloc(256, 0x55));
    expect(hammingSimilarity(h, h)).toBe(1);
  });

  it('hammingSimilarity returns < 1.0 for different hashes', () => {
    const a = pHash(Buffer.alloc(256, 0x55));
    const b = pHash(Buffer.alloc(256, 0xaa));
    expect(hammingSimilarity(a, b)).toBeLessThan(1);
  });

  it('hammingSimilarity returns 0 for maximally-different hashes', () => {
    const a = 0n;
    const b = (1n << 64n) - 1n;
    expect(hammingSimilarity(a, b)).toBe(0);
  });
});