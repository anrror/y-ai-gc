/**
 * Tests for the end-to-end composite gate (F in the Quality Engineering
 * roadmap). Verifies shape + helper math; uses a stub video provider
 * so no real ffmpeg / Hailuo API is hit.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mockQuality: ReturnType<typeof vi.fn>;
vi.mock('../src/quality/pipeline.js', () => ({
  quickGate: (...args: unknown[]) => mockQuality(...args),
}));
vi.mock('../src/quality/subject_consistency.js', () => ({
  checkSubjectConsistency: vi.fn(async () => 0.85),
}));

beforeEach(() => {
  vi.resetModules();
  mockQuality = vi.fn(async () => ({
    composite: 0.85,
    metrics: [
      { name: 'duration_ok', value: 1, threshold: 0.5, passed: true },
      { name: 'subject_consistency', value: 0.85, threshold: 0.65, passed: true },
    ],
    passed: true,
    reasons: [],
  }));
});

describe('end-to-end composite gate (Phase F)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'e2e-gate-'));

  it('finalCompositeGate aggregates quickGate metrics into QualityReport', async () => {
    const final = join(tmp, 'final.mp4');
    writeFileSync(final, '');
    const { finalCompositeGate } = await import('../src/quality/end_to_end_gate.js');
    const r = await finalCompositeGate(final);
    expect(r.composite).toBeGreaterThan(0);
    expect(r.passed).toBe(true);
  });

  it('aggregateShotReports: empty → fails (technical)', async () => {
    const { aggregateShotReports } = await import('../src/quality/end_to_end_gate.js');
    const r = aggregateShotReports([]);
    expect(r.passed).toBe(false);
    expect(r.failure_class).toBe('technical');
  });

  it('aggregateShotReports: all pass → passes', async () => {
    const { aggregateShotReports } = await import('../src/quality/end_to_end_gate.js');
    const r = aggregateShotReports([
      { composite: 0.9, metrics: [], passed: true, reasons: [] },
      { composite: 0.85, metrics: [], passed: true, reasons: [] },
    ]);
    expect(r.passed).toBe(true);
  });

  it('aggregateShotReports: ≥80% pass → passes', async () => {
    const { aggregateShotReports } = await import('../src/quality/end_to_end_gate.js');
    const r = aggregateShotReports([
      { composite: 0.9, metrics: [], passed: true, reasons: [] },
      { composite: 0.5, metrics: [], passed: false, reasons: ['x'] },
      { composite: 0.9, metrics: [], passed: true, reasons: [] },
      { composite: 0.9, metrics: [], passed: true, reasons: [] },
      { composite: 0.9, metrics: [], passed: true, reasons: [] },
    ]);
    expect(r.passed).toBe(true);
  });

  it('aggregateShotReports: <80% pass → fails with reason', async () => {
    const { aggregateShotReports } = await import('../src/quality/end_to_end_gate.js');
    const r = aggregateShotReports([
      { composite: 0.5, metrics: [], passed: false, reasons: ['x'] },
      { composite: 0.5, metrics: [], passed: false, reasons: ['y'] },
      { composite: 0.5, metrics: [], passed: false, reasons: ['z'] },
    ]);
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toMatch(/only.*shots passed/);
  });

  it('appendAuditLine writes JSONL entry', async () => {
    const { appendAuditLine } = await import('../src/quality/end_to_end_gate.js');
    const log = join(tmp, 'audit', 'quality.jsonl');
    appendAuditLine(log, {
      ts: '2026-08-20T00:00:00Z',
      session_id: 's1',
      shot_index: 1,
      decision: 'continue',
      attempt: 0,
      composite: 0.9,
      passed: true,
      reasons: [],
    });
    const lines = (await import('node:fs')).readFileSync(log, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]);
    expect(obj.session_id).toBe('s1');
    expect(obj.decision).toBe('continue');
  });

  it('cleanup', () => {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* */ }
    expect(true).toBe(true);
  });
});