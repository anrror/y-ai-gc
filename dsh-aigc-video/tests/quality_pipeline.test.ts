/**
 * Tests for QualityPipeline (B in the Quality Engineering roadmap).
 *
 * Verifies shape + freeze/silence metrics are wired. Real ffmpeg probe
 * values are out of scope for unit tests; we mock the legacy
 * checkClipQuality and use a per-suite helper for fresh module loads.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

let mockLegacy: ReturnType<typeof vi.fn>;

vi.mock('../src/video/quality_gate.js', () => ({
  checkClipQuality: (...args: unknown[]) => mockLegacy(...args),
}));

beforeEach(() => {
  // Reset modules so each test gets a fresh pipeline instance bound to
  // the current mock.
  vi.resetModules();
  mockLegacy = vi.fn(async () => ({
    ok: true,
    probed: { duration_sec: 6.0, width: 1280, height: 720, black_ratio: 0.05 },
    reasons: [],
  }));
});

describe('QualityPipeline.quickGate (Phase B)', () => {
  it('returns a structured QualityReport', async () => {
    const { QualityPipeline } = await import('../src/quality/pipeline.js');
    const pipe = new QualityPipeline();
    const report = await pipe.quickGate('/tmp/fake.mp4', { expected_sec: 6 });
    expect(report.composite).toBeGreaterThan(0);
    expect(report.metrics.length).toBeGreaterThanOrEqual(3);
    expect(report.passed).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it('marks duration_mismatch → duration_ok=0, passed=false', async () => {
    mockLegacy = vi.fn(async () => ({
      ok: false,
      probed: { duration_sec: 12.0, width: 1280, height: 720, black_ratio: 0.05 },
      reasons: ['duration_mismatch'],
    }));
    const { QualityPipeline } = await import('../src/quality/pipeline.js');
    const pipe = new QualityPipeline();
    const report = await pipe.quickGate('/tmp/fake.mp4', { expected_sec: 6 });
    expect(report.passed).toBe(false);
    const dur = report.metrics.find((m) => m.name === 'duration_ok');
    expect(dur?.value).toBe(0);
    expect(dur?.passed).toBe(false);
  });

  it('marks too_much_black → failure_class="temporal"', async () => {
    mockLegacy = vi.fn(async () => ({
      ok: false,
      probed: { duration_sec: 6.0, width: 1280, height: 720, black_ratio: 0.7 },
      reasons: ['too_much_black'],
    }));
    const { QualityPipeline } = await import('../src/quality/pipeline.js');
    const pipe = new QualityPipeline();
    const report = await pipe.quickGate('/tmp/fake.mp4');
    expect(report.passed).toBe(false);
    expect(report.failure_class).toBe('temporal');
  });

  it('deepEvaluate returns quickGate + caveat (no Python sidecar yet)', async () => {
    const { QualityPipeline } = await import('../src/quality/pipeline.js');
    const pipe = new QualityPipeline();
    const report = await pipe.deepEvaluate('/tmp/fake.mp4');
    expect(report.reasons.some((r) => r.includes('deep-evaluate'))).toBe(true);
  });
});