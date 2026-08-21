/**
 * Tests for the quality contract and decision agent (Phase: Quality Engineering).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  type QualityReport,
  type MetricReading,
  reading,
  report,
  compositeScore,
  passedOnly,
  type StageAction,
} from '../src/quality/contract.js';
import { decide, decideFromReport } from '../src/quality/decision.js';

describe('quality contract (Phase: Quality Engineering)', () => {
  it('DEFAULT_THRESHOLDS covers all 11 metrics', () => {
    expect(Object.keys(DEFAULT_THRESHOLDS).length).toBe(11);
  });

  it('DEFAULT_WEIGHTS covers all important metrics', () => {
    // Note: raw weights may sum > 1; compositeScore() normalises by totalWeight().
    // We just verify the structure here.
    expect(DEFAULT_WEIGHTS.subject_consistency).toBeGreaterThan(0.15);
    expect(DEFAULT_WEIGHTS.prompt_alignment).toBeGreaterThan(0.10);
    const nonZero = Object.values(DEFAULT_WEIGHTS).filter((w) => (w ?? 0) > 0).length;
    expect(nonZero).toBeGreaterThanOrEqual(8);
  });

  it('reading() checks against threshold', () => {
    const r = reading('subject_consistency', 0.7);
    expect(r.passed).toBe(true);
    const bad = reading('subject_consistency', 0.5);
    expect(bad.passed).toBe(false);
  });

  it('report() aggregates metrics and computes composite', () => {
    const r = report([
      reading('duration_ok', 1),
      reading('subject_consistency', 0.8),
      reading('prompt_alignment', 0.5),
    ]);
    expect(r.metrics.length).toBe(3);
    expect(r.passed).toBe(true);
    expect(r.composite).toBeGreaterThan(0.5);
    expect(r.reasons).toEqual([]);
  });

  it('report() includes failure reasons for failed metrics', () => {
    const r = report([
      reading('subject_consistency', 0.4),  // failed
      reading('prompt_alignment', 0.5),
    ]);
    expect(r.passed).toBe(false);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toContain('subject_consistency');
  });

  it('report() sets failure_class when provided', () => {
    const r = report([reading('subject_consistency', 0.4)], { failureClass: 'identity' });
    expect(r.failure_class).toBe('identity');
  });

  it('compositeScore() is 0 for empty metric list', () => {
    expect(compositeScore([])).toBe(0);
  });

  it('compositeScore() weights by DEFAULT_WEIGHTS', () => {
    // All metrics at 1.0 → composite ≈ 1.0 (regardless of weights).
    const allOnes: MetricReading[] = Object.keys(DEFAULT_THRESHOLDS).map(
      (n) => reading(n as never, 1.0),
    );
    expect(compositeScore(allOnes)).toBeGreaterThan(0.99);
  });

  it('passedOnly() matches passed()', () => {
    const metrics = [reading('aesthetic_quality', 0.5), reading('prompt_alignment', 0.5)];
    expect(passedOnly(metrics)).toBe(report(metrics).passed);
  });
});

describe('decision agent (Phase: Quality Engineering)', () => {
  const passReport: QualityReport = report([
    reading('subject_consistency', 0.9),
    reading('temporal_consistency', 0.9),
    reading('aesthetic_quality', 0.6),
  ]);

  it('continue when all passed', () => {
    const d = decideFromReport(passReport);
    expect(d.action).toBe('continue');
  });

  it('escalate-to-human when retry budget exhausted', () => {
    const failReport = report([reading('subject_consistency', 0.3)]);
    const d = decideFromReport(failReport, { retry_count: 3, max_retries: 3 });
    expect(d.action).toBe('escalate-to-human');
  });

  it('subject_consistency failure → retry-prompt-variation (with reference emphasis)', () => {
    const failReport = report([reading('subject_consistency', 0.4)]);
    const d = decideFromReport(failReport, { has_reference_image: true });
    expect(d.action).toBe('retry-prompt-variation');
    expect(d.variant_count).toBeGreaterThanOrEqual(2);
    expect(d.variant_hint).toBe('reference-emphasis');
  });

  it('subject_consistency failure without reference → add-camera hint', () => {
    const failReport = report([reading('subject_consistency', 0.4)]);
    const d = decideFromReport(failReport, { has_reference_image: false });
    expect(d.variant_hint).toBe('add-camera');
  });

  it('temporal_flickering failure → retry-seed', () => {
    const failReport = report([reading('temporal_flickering', 0.5)]);
    const d = decideFromReport(failReport);
    expect(d.action).toBe('retry-seed');
  });

  it('aesthetic_quality with alternative provider → retry-provider (early)', () => {
    const failReport = report([reading('aesthetic_quality', 0.2)]);
    const d = decideFromReport(failReport, {
      has_alternative_provider: true,
      retry_count: 0,
    });
    expect(d.action).toBe('retry-provider');
  });

  it('aesthetic_quality without alt provider → retry-prompt-variation', () => {
    const failReport = report([reading('aesthetic_quality', 0.2)]);
    const d = decideFromReport(failReport, { has_alternative_provider: false });
    expect(d.action).toBe('retry-prompt-variation');
    expect(d.variant_hint).toBe('add-style');
  });

  it('prompt_alignment failure → retry-prompt-variation with longer hint', () => {
    const failReport = report([reading('prompt_alignment', 0.1)]);
    const d = decideFromReport(failReport);
    expect(d.action).toBe('retry-prompt-variation');
    expect(d.variant_hint).toBe('longer');
  });

  it('technical failure (duration_ok) → fallback', () => {
    const failReport = report([reading('duration_ok', 0)]);
    const d = decideFromReport(failReport);
    expect(d.action).toBe('fallback');
  });

  it('structural failure (script_completeness) → escalate-to-human', () => {
    const failReport = report([reading('script_completeness', 0.2)]);
    const d = decideFromReport(failReport);
    expect(d.action).toBe('escalate-to-human');
  });

  it('decision() picks worst failed metric (lowest gap) when multiple fail', () => {
    const failReport = report([
      reading('subject_consistency', 0.6),  // gap = 0.05, mild
      reading('temporal_flickering', 0.5),  // gap = 0.35, worst
    ]);
    const d = decideFromReport(failReport);
    expect(d.action).toBe('retry-seed'); // because temporal_flickering wins
  });
});