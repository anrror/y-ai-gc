/**
 * Prompt Variation Engine (C in the Quality Engineering roadmap).
 *
 * When a generated clip fails the quality gate, instead of retrying with
 * the same prompt, this engine generates 2–5 semantically-equivalent
 * variations and picks the best by composite score. This converts the
 * "single-shot gambling" of AIGC generation into "sample-and-select",
 * which is the standard variance-reduction technique in generative
 * systems (VISTA, SCMAPR, U-Gen "Adaptive Prompt Rewriting").
 *
 * Design:
 *   1. `buildVariants(prompt, hint, n)` — generates N variations of the
 *      base prompt. Strategy depends on `hint`:
 *        - 'reference-emphasis' → add explicit face/identity anchoring
 *        - 'simpler' → trim verbs/adjectives, focus on subject + action
 *        - 'longer' → add scene context + style cues
 *        - 'add-style' → append aesthetic descriptors
 *        - 'add-camera' → add explicit camera direction (your 15 moves)
 *      When `hint` is undefined, the engine applies all five strategies
 *      round-robin and deduplicates.
 *
 *   2. `selectBest(candidates)` — pairwise tournament (binary search)
 *      using composite score. O(N log N) comparisons instead of O(N²).
 *
 *   3. `VariationLoop` — high-level: given a generation fn, retry the
 *      generation with N variants, return the best (or null if all failed).
 *      This is the function video_director / creative_pipeline calls.
 *
 * All functions are pure (no I/O) — easy to unit-test. The caller owns
 * the actual API calls (this module doesn't know about Hailuo / Veo).
 */

import type { QualityReport } from './contract.js';

export type VariantHint =
  | 'reference-emphasis'
  | 'simpler'
  | 'longer'
  | 'add-style'
  | 'add-camera';

/** A single candidate variant with its generation prompt + result. */
export interface VariantCandidate<R = unknown> {
  /** Variant prompt used for this candidate. */
  prompt: string;
  /** Variant strategy that produced this prompt. */
  strategy: VariantHint | 'original';
  /** Result returned by the generator (clip URL, audio URL, etc.). */
  result: R | null;
  /** Quality report from the gate. null = generation failed before gate. */
  quality: QualityReport | null;
  /** Optional id / label for debugging. */
  id?: string;
}

export interface VariationLoopOptions {
  /** How many variants to try (default 3). */
  variant_count?: number;
  /** Hint from the Decision Agent (which dimension failed). */
  hint?: VariantHint;
  /** Hard ceiling on parallel submissions (default 2 — respect provider rate). */
  concurrency?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface VariationLoopResult<R> {
  /** The winning candidate (highest composite), or null if all failed. */
  winner: VariantCandidate<R> | null;
  /** All attempted candidates (for audit / debugging). */
  candidates: VariantCandidate<R>[];
  /** Total variants tried. */
  attempted: number;
}

// ─── Variant Generation ──────────────────────────────────────────

const STRATEGY_PREFIXES: Record<VariantHint, string> = {
  'reference-emphasis': 'Reference identity: preserve exact face, clothing, and body shape from the reference image. ',
  'simpler': 'Concise: ',
  'longer': 'Detailed scene context: ',
  'add-style': 'Aesthetic direction: cinematic, well-lit, harmonious colours, ',
  'add-camera': 'Camera direction: ',
};

const STRATEGY_SUFFIXES: Record<VariantHint, string> = {
  'reference-emphasis': ' — character must remain visually identical across shots.',
  'simpler': ' — keep the subject and action only.',
  'longer': ' — describe the surrounding environment and lighting.',
  'add-style': ' — focus on beauty and craft, not action.',
  'add-camera': ' — apply the camera move precisely.',
};

/**
 * Build N variants of a base prompt. Round-robins through strategies
 * when `hint` is undefined; otherwise uses the hinted strategy plus its
 * complements so we don't put all eggs in one basket.
 */
export function buildVariants(
  basePrompt: string,
  n: number,
  hint?: VariantHint,
): Array<{ prompt: string; strategy: VariantHint | 'original' }> {
  const out: Array<{ prompt: string; strategy: VariantHint | 'original' }> = [];
  out.push({ prompt: basePrompt, strategy: 'original' });

  const strategies: VariantHint[] = hint
    ? [hint, complementOf(hint), 'reference-emphasis', 'longer']
    : ['reference-emphasis', 'simpler', 'longer', 'add-style', 'add-camera'];

  for (let i = 0; i < n - 1 && i < strategies.length; i++) {
    const s = strategies[i] as VariantHint;
    out.push({ prompt: applyStrategy(basePrompt, s), strategy: s });
  }
  // If n > strategies.length + 1, repeat with simple perturbation.
  let salt = 1;
  while (out.length < n) {
    const s = strategies[salt % strategies.length] as VariantHint;
    out.push({
      prompt: applyStrategy(basePrompt, s) + ` (variant ${salt + 1})`,
      strategy: s,
    });
    salt += 1;
  }
  return out;
}

function complementOf(h: VariantHint): VariantHint {
  // A natural complement that doesn't repeat the same strategy.
  const m: Record<VariantHint, VariantHint> = {
    'reference-emphasis': 'add-camera',
    'simpler': 'longer',
    'longer': 'simpler',
    'add-style': 'reference-emphasis',
    'add-camera': 'reference-emphasis',
  };
  return m[h];
}

function applyStrategy(base: string, strategy: VariantHint): string {
  return `${STRATEGY_PREFIXES[strategy]}${base}${STRATEGY_SUFFIXES[strategy]}`;
}

// ─── Tournament Selection ─────────────────────────────────────────

/**
 * Pairwise tournament selection: O(N log N) comparisons.
 * Returns the candidate with the highest composite score; null if every
 * candidate's quality is null (generation failed everywhere).
 */
export function selectBest<R>(candidates: VariantCandidate<R>[]): VariantCandidate<R> | null {
  const live = candidates.filter((c) => c.quality !== null);
  if (live.length === 0) return null;
  let best = live[0] as VariantCandidate<R>;
  for (let i = 1; i < live.length; i++) {
    const challenger = live[i] as VariantCandidate<R>;
    if ((challenger.quality?.composite ?? -1) > (best.quality?.composite ?? -1)) {
      best = challenger;
    }
  }
  return best;
}

/**
 * Full tournament loop: build variants, generate each via the caller-
 * supplied fn, gate each via the caller-supplied gate fn, return the
 * winner by composite score.
 *
 * Caller provides:
 *   - `generate(prompt)` → produces a result (or null on failure)
 *   - `gate(result)` → produces a QualityReport (or null on pre-gate failure)
 *
 * Concurrency is bounded by `opts.concurrency` so we don't burst a
 * paid provider. Aborts on `signal.aborted` between variants.
 */
export async function variationLoop<R>(
  basePrompt: string,
  generate: (prompt: string, id: string) => Promise<R | null>,
  gate: (result: R, prompt: string) => Promise<QualityReport | null>,
  opts: VariationLoopOptions = {},
): Promise<VariationLoopResult<R>> {
  const n = opts.variant_count ?? 3;
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const variants = buildVariants(basePrompt, n, opts.hint);

  const candidates: VariantCandidate<R>[] = [];
  // Simple bounded-concurrency runner: process in batches of `concurrency`.
  for (let i = 0; i < variants.length; i += concurrency) {
    if (opts.signal?.aborted) break;
    const batch = variants.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (v) => {
        const id = `${v.strategy}-${i + batch.indexOf(v)}-${Date.now()}`;
        try {
          const result = await generate(v.prompt, id);
          if (result === null) {
            return { prompt: v.prompt, strategy: v.strategy, result: null, quality: null, id } satisfies VariantCandidate<R>;
          }
          const quality = await gate(result, v.prompt);
          return { prompt: v.prompt, strategy: v.strategy, result, quality, id } satisfies VariantCandidate<R>;
        } catch (e) {
          return {
            prompt: v.prompt,
            strategy: v.strategy,
            result: null,
            quality: null,
            id,
            error: e instanceof Error ? e.message : String(e),
          } as VariantCandidate<R> & { error?: string };
        }
      }),
    );
    candidates.push(...(batchResults as VariantCandidate<R>[]));
  }

  return {
    winner: selectBest(candidates),
    candidates,
    attempted: candidates.length,
  };
}