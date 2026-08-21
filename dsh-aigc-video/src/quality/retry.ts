/**
 * Quality-aware retry loop (D in the Quality Engineering roadmap).
 *
 * Wraps a generation function with the Decision Agent + Variation
 * Engine. Given a generator + gate, it:
 *
 *   1. Tries `generator(originalPrompt)` once.
 *   2. Calls `gate()` on the result; if passed → return immediately.
 *   3. If failed, asks the Decision Agent for the next action.
 *   4. If next_action is `retry-prompt-variation` / `retry-seed` /
 *      `retry-provider` → invoke the right strategy, up to budget.
 *   5. If budget exhausted → return the best-so-far with `escalate-to-human`.
 *
 * This is the high-level glue that lets `creative_pipeline.ts` /
 * `video_director.ts` stay simple: they just call
 * `qualityAwareGenerate(...)` and get back a StageOutput.
 */

import { decide, type Decision, type DecisionContext } from './decision.js';
import type { QualityReport } from './contract.js';
import { variationLoop, type VariantCandidate, type VariationLoopOptions, type VariantHint } from './variation.js';

export interface QualityAwareOptions {
  /** Max retries before escalating to human (default 2 — respect quota). */
  max_retries?: number;
  /** Concurrency for prompt-variation batch (default 2). */
  concurrency?: number;
  /** Has a reference image been attached? (affects subject_consistency decisions). */
  has_reference_image?: boolean;
  /** Is there an alternative provider to route to? (P1; default false). */
  has_alternative_provider?: boolean;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface QualityAwareResult<R> {
  /** The chosen result (highest composite so far). */
  winner: { result: R; quality: QualityReport } | null;
  /** All attempts (for audit / debugging). */
  history: Array<{ prompt: string; result: R | null; quality: QualityReport | null; decision: Decision; attempt: number }>;
  /** Final decision (continue / retry / escalate). */
  decision: Decision;
  /** Total attempts made. */
  attempts: number;
}

/**
 * High-level retry-with-quality wrapper.
 *
 *   generate: (prompt, id) → R | null  (returns null on failure)
 *   gate: (result) → Promise<QualityReport>
 */
export async function qualityAwareGenerate<R>(
  originalPrompt: string,
  generate: (prompt: string, id: string) => Promise<R | null>,
  gate: (result: R) => Promise<QualityReport>,
  opts: QualityAwareOptions = {},
): Promise<QualityAwareResult<R>> {
  const maxRetries = opts.max_retries ?? 2;
  const history: QualityAwareResult<R>['history'] = [];
  let bestResult: { result: R; quality: QualityReport } | null = null;

  // Attempt 0: original prompt, no variation.
  let attempt = 0;
  const id0 = `attempt-0-${Date.now()}`;
  let lastDecision: Decision = { action: 'retry-prompt-variation', reason: 'initial', variant_count: 1 };
  let lastResult: R | null = null;
  let lastQuality: QualityReport | null = null;

  try {
    lastResult = await generate(originalPrompt, id0);
    if (lastResult !== null) {
      lastQuality = await gate(lastResult);
      if (lastQuality.passed) {
        bestResult = { result: lastResult, quality: lastQuality };
      }
    }
  } catch {
    // generation threw — leave as null quality, fall through to retry
  }
  history.push({
    prompt: originalPrompt,
    result: lastResult,
    quality: lastQuality,
    decision: lastDecision,
    attempt: 0,
  });

  for (let retry = 1; retry <= maxRetries; retry++) {
    if (bestResult !== null && bestResult.quality.passed) break;
    if (opts.signal?.aborted) break;
    const ctx: DecisionContext = {
      quality: lastQuality ?? makeEmptyReport(),
      retry_count: retry - 1,
      max_retries: maxRetries,
      has_reference_image: opts.has_reference_image,
      has_alternative_provider: opts.has_alternative_provider,
    };
    lastDecision = decide(ctx);

    if (lastDecision.action === 'escalate-to-human') {
      break;
    }
    if (lastDecision.action === 'fallback') {
      // Caller's responsibility to handle; we just stop.
      break;
    }
    if (lastDecision.action === 'continue') {
      break;
    }

    if (lastDecision.action === 'retry-seed' || lastDecision.action === 'retry-provider') {
      // Caller provides a new attempt via generate(); pass through but
      // tweak the id with retry/seed info so the caller can vary params.
      const id = `${lastDecision.action}-${retry}-${Date.now()}`;
      try {
        const result = await generate(originalPrompt, id);
        if (result === null) {
          history.push({ prompt: originalPrompt, result: null, quality: null, decision: lastDecision, attempt: retry });
          continue;
        }
        const quality = await gate(result);
        history.push({ prompt: originalPrompt, result, quality, decision: lastDecision, attempt: retry });
        if (quality.passed) {
          bestResult = { result, quality };
        } else {
          lastQuality = quality;
          lastResult = result;
        }
      } catch {
        history.push({ prompt: originalPrompt, result: null, quality: null, decision: lastDecision, attempt: retry });
      }
      continue;
    }

    if (lastDecision.action === 'retry-prompt-variation') {
      const vOpts: VariationLoopOptions = {
        variant_count: lastDecision.variant_count,
        hint: lastDecision.variant_hint as VariantHint | undefined,
        concurrency: opts.concurrency ?? 2,
        signal: opts.signal,
      };
      const vResult = await variationLoop<R>(
        originalPrompt,
        async (prompt, id) => generate(prompt, id),
        async (result) => gate(result),
        vOpts,
      );
      // Record each variant in history.
      for (let i = 0; i < vResult.candidates.length; i++) {
        const c = vResult.candidates[i] as VariantCandidate<R>;
        history.push({
          prompt: c.prompt,
          result: c.result,
          quality: c.quality,
          decision: lastDecision,
          attempt: retry + i / 100, // sub-attempt index for ordering
        });
      }
      const w = vResult.winner;
      if (w !== null) {
        const wq = w.quality;
        if (wq !== null) {
          // Local helper avoids TS narrowing issues with generic R in
          // the outer bestResult variable across nested blocks.
          const updateBest = (newResult: R, newQuality: QualityReport): void => {
            if (bestResult === null) {
              bestResult = { result: newResult, quality: newQuality };
            } else if (bestResult.quality.composite < newQuality.composite) {
              bestResult = { result: newResult, quality: newQuality };
            }
          };
          updateBest(w.result as R, wq);
          lastQuality = wq;
        }
      }
      if (bestResult !== null && bestResult.quality.passed) break;
    }
    attempt = retry;
  }

  // Final decision: derive from end state.
  //   - bestResult.passed → lastDecision (typically 'continue' / 'retry-prompt-variation' that succeeded)
  //   - lastDecision was 'fallback' → keep 'fallback' (caller takes over)
  //   - bestResult is null OR didn't pass → escalate-to-human
  let finalDecision: Decision;
  if (bestResult !== null && bestResult.quality.passed) {
    finalDecision = lastDecision; // succeeded — action was correct
  } else if (lastDecision.action === 'fallback') {
    finalDecision = lastDecision;
  } else {
    finalDecision = {
      action: 'escalate-to-human',
      reason: bestResult === null
        ? 'all retries exhausted without any candidate'
        : 'all retries exhausted; best candidate did not pass the gate',
      variant_count: 0,
    };
  }

  return {
    winner: bestResult,
    history,
    decision: finalDecision,
    attempts: history.length,
  };
}

/** Fallback empty report when generation never produced a result. */
function makeEmptyReport(): QualityReport {
  return {
    composite: 0,
    metrics: [],
    passed: false,
    reasons: ['generation failed'],
    failure_class: 'technical',
  };
}