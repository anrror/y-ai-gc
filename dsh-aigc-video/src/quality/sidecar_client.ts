/**
 * TS client for the Python quality sidecar (scripts/sidecar.py).
 *
 * Contract: see `scripts/sidecar.py` for the canonical definition.
 * Both ends of the wire use the same JSON shape:
 *
 *   POST /subject_consistency
 *     body:    { clip_path: string, reference_path?: string }
 *     200 OK:  { score: 0..1, details: {...} }
 *
 *   POST /prompt_alignment
 *     body:    { prompt: string, caption: string }
 *     200 OK:  { score: 0..1, details: { method: 'f1_fallback' | 'blip_bleu' } }
 *
 *   GET /health
 *     200 OK:  { status: 'ok', ml: { dinov2: bool, arcface: bool } }
 *
 * The client is intentionally thin: it posts JSON and returns the score.
 * All fallback behaviour (pHash, etc.) lives in `subject_consistency.ts`
 * and is used automatically when `sidecar_url` is empty.
 */

import type { QualityConfig } from '../providers/config.js';

export interface SubjectConsistencyResult {
  score: number;
  details?: {
    frame_count?: number;
    mean_cosine?: number;
    reference_cosine?: number | null;
    method?: string;
  };
}

export interface PromptAlignmentResult {
  score: number;
  details?: { method?: string };
}

export class SidecarClient {
  constructor(private readonly cfg: QualityConfig) {}

  get enabled(): boolean {
    return Boolean(this.cfg.sidecarUrl);
  }

  /** GET /health — returns capability report. */
  async health(): Promise<{ status: string; ml: { dinov2: boolean; arcface: boolean } } | null> {
    if (!this.enabled) return null;
    try {
      const resp = await fetch(`${this.cfg.sidecarUrl}/health`, {
        signal: AbortSignal.timeout(this.cfg.sidecarTimeoutMs),
      });
      if (!resp.ok) return null;
      return await resp.json() as { status: string; ml: { dinov2: boolean; arcface: boolean } };
    } catch {
      return null;
    }
  }

  /** POST /subject_consistency. Returns null on any failure. */
  async subjectConsistency(
    clipPath: string,
    referencePath?: string,
  ): Promise<SubjectConsistencyResult | null> {
    if (!this.enabled) return null;
    try {
      const resp = await fetch(`${this.cfg.sidecarUrl}/subject_consistency`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clip_path: clipPath,
          ...(referencePath !== undefined ? { reference_path: referencePath } : {}),
        }),
        signal: AbortSignal.timeout(this.cfg.sidecarTimeoutMs),
      });
      if (!resp.ok) return null;
      return await resp.json() as SubjectConsistencyResult;
    } catch {
      return null;
    }
  }

  /** POST /prompt_alignment. Returns null on any failure. */
  async promptAlignment(prompt: string, caption: string): Promise<PromptAlignmentResult | null> {
    if (!this.enabled || !this.cfg.enablePromptAlignment) return null;
    try {
      const resp = await fetch(`${this.cfg.sidecarUrl}/prompt_alignment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, caption }),
        signal: AbortSignal.timeout(this.cfg.sidecarTimeoutMs),
      });
      if (!resp.ok) return null;
      return await resp.json() as PromptAlignmentResult;
    } catch {
      return null;
    }
  }
}

/**
 * Construct a SidecarClient from an AppConfig. When `quality` is absent,
 * the returned client is disabled (`enabled === false`) and the TS layer
 * falls back to its local pHash implementation.
 */
export function sidecarFromConfig(cfg: { quality?: QualityConfig }): SidecarClient {
  return new SidecarClient(cfg.quality ?? {
    sidecarUrl: '',
    sidecarTimeoutMs: 30000,
    retryBudget: 2,
    enableSubjectConsistency: true,
    enablePromptAlignment: false,
  });
}