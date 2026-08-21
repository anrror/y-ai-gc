/**
 * End-to-end composite quality gate (F in the Quality Engineering roadmap).
 *
 * Combines:
 *   1. Per-shot `qualityAwareGenerate` (Decision + Variation + Retry) —
 *      each video clip is generated through the retry-with-quality loop.
 *   2. End-stage composite gate on `final.mp4` — verifies the muxed
 *      output passes a final QualityReport before declaring success.
 *
 * The wrappers expose `generateShot` / `generateFinal` so the e2e
 * pipeline can be unit-tested with stub providers (no real ffmpeg /
 * Hailuo calls).
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { VideoProvider } from '../providers/types.js';
import { qualityAwareGenerate } from './retry.js';
import { report, reading, type QualityReport } from './contract.js';
import { quickGate } from './pipeline.js';
import { checkSubjectConsistency } from './subject_consistency.js';
import type { RunEstimate } from '../cost/estimator.js';

/** Per-shot gate options. */
export interface ShotGateOptions {
  /** Subject / character reference image (improves identity metric). */
  reference_image?: string;
  /** Expected duration for `duration_ok` metric (default 6). */
  expected_sec?: number;
  /** Max retries before escalation (default 2 — respects quota). */
  max_retries?: number;
  /** Concurrency for prompt-variation batches (default 2). */
  concurrency?: number;
}

/**
 * Generate a single shot with quality-aware retry. The `videoProvider`
 * is the same interface `CreativePipeline` uses; the `gate` function
 * takes the downloaded clip path + expected duration and returns a
 * QualityReport (or null if the gate is unavailable).
 */
export async function generateShot(
  video: VideoProvider,
  prompt: string,
  clipPath: string,
  opts: ShotGateOptions & { signal?: AbortSignal } = {},
): Promise<{ quality: QualityReport | null; history: unknown[]; decision: unknown }> {
  // Ensure parent dir exists.
  mkdirSync(join(clipPath, '..'), { recursive: true });
  const expectedSec = opts.expected_sec ?? 6;

  const result = await qualityAwareGenerate<string>(
    prompt,
    async (p, _id) => {
      // Submit the prompt. We rely on the caller to wire the actual
      // provider; this hook receives the (possibly varied) prompt and
      // returns a placeholder URL when generation succeeds.
      const taskId = await video.submit({
        model: 'MiniMax-Hailuo-2.3',
        prompt: p,
        duration: expectedSec,
        resolution: '768P',
        ratio: '16:9',
      });
      // We don't poll here — that's the caller's responsibility (the
      // creative_pipeline already implements this loop). For the gate
      // interface we return the URL the caller will eventually
      // download to `clipPath`.
      return taskId;
    },
    async (taskId) => {
      // Poll until success (mocked for unit tests via injected video).
      const result = await video.poll(taskId);
      if (result.status !== 'succeeded' || !result.videoUrl) {
        return report([reading('duration_ok', 0)], { failureClass: 'technical' });
      }
      // Quick gate on the file at clipPath. The caller must have
      // downloaded the URL to that path before invoking `gate`.
      if (!safeExists(clipPath)) {
        return report([reading('duration_ok', 0)], { failureClass: 'technical' });
      }
      const qg = await quickGate(clipPath, { expected_sec: expectedSec });
      // Optionally augment with subject_consistency (ArcFace / CLIP fallback).
      if (opts.reference_image) {
        const sc = await checkSubjectConsistency(clipPath, {
          reference_path: opts.reference_image,
        });
        if (sc !== null) {
          qg.metrics.push(reading('subject_consistency', sc));
        }
      }
      // Recompute composite (mutating metrics list is OK since we
      // re-aggregate via report()'s compositeScore helper).
      return report(qg.metrics);
    },
    {
      has_reference_image: Boolean(opts.reference_image),
      max_retries: opts.max_retries ?? 2,
      concurrency: opts.concurrency ?? 2,
      signal: opts.signal,
    },
  );

  return {
    quality: result.winner?.quality ?? null,
    history: result.history,
    decision: result.decision,
  };
}

/**
 * Final-mp4 composite gate. Runs the same quickGate over the muxed
 * output and aggregates an end-to-end QualityReport. Returns the
 * report and a boolean `passed` flag.
 */
export async function finalCompositeGate(
  finalMp4Path: string,
  opts: { reference_image?: string } = {},
): Promise<QualityReport> {
  const metrics = await quickGate(finalMp4Path).then((r) => r.metrics);
  if (opts.reference_image) {
    const sc = await checkSubjectConsistency(finalMp4Path, {
      reference_path: opts.reference_image,
    });
    if (sc !== null) metrics.push(reading('subject_consistency', sc));
  }
  return report(metrics);
}

function safeExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Aggregate per-shot qualities into a session-level report. */
export function aggregateShotReports(reports: QualityReport[]): QualityReport {
  if (reports.length === 0) {
    return {
      composite: 0,
      metrics: [],
      passed: false,
      reasons: ['no shots'],
      failure_class: 'technical',
    };
  }
  const passedCount = reports.filter((r) => r.passed).length;
  const passRatio = passedCount / reports.length;
  const meanComposite = reports.reduce((s, r) => s + r.composite, 0) / reports.length;
  const meanSubjectCons = reports.reduce(
    (s, r) => s + (r.metrics.find((m) => m.name === 'subject_consistency')?.value ?? 0),
    0,
  ) / reports.length;

  const metrics = [
    reading('subject_consistency', meanSubjectCons),
    reading('prompt_alignment', meanComposite),
  ];
  const baseReport = report(metrics);
  // Override the passed flag with our session-level threshold (≥80% shots pass).
  const passed = passRatio >= 0.8;
  const reasons: string[] = [];
  if (!passed) reasons.push(`only ${passedCount}/${reports.length} shots passed`);
  reasons.push(...baseReport.reasons);
  const out: QualityReport = {
    ...baseReport,
    passed,
    reasons,
  };
  if (!passed) out.failure_class = 'aesthetic';
  return out;
}

/** Append-only quality audit log writer. */
export interface AuditEntry {
  ts: string;
  session_id?: string;
  shot_index?: number;
  decision: string;
  attempt: number;
  composite: number;
  passed: boolean;
  reasons: string[];
}

export function appendAuditLine(
  logPath: string,
  entry: AuditEntry,
): void {
  mkdirSync(join(logPath, '..'), { recursive: true });
  writeFileSync(logPath, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf-8' });
}