/**
 * Decision Agent — given a QualityReport, decide what to do next.
 *
 * The decision table is rule-based (deterministic). The plan is to
 * eventually upgrade it to a learned policy (RLHF on user feedback),
 * but for v1 we start with a hand-tuned lookup that's easy to reason
 * about and debug.
 *
 * Decision priority (highest first):
 *   1. If retry budget exhausted → escalate-to-human
 *   2. subject_consistency < 0.5 → retry-prompt-variation
 *      (with reference image emphasis)
 *   3. temporal_flickering > 0.20 → retry-seed
 *   4. aesthetic_quality < 0.30 && budget > 0 → retry-provider
 *   5. prompt_alignment < 0.15 → retry-prompt-variation
 *   6. technical failures (duration/resolution/black) → fallback
 *   7. passed = true → continue
 *   8. default → continue (let downstream catch it)
 */

import type { StageAction, QualityReport, MetricReading } from './contract.js';

export interface DecisionContext {
  quality: QualityReport;
  retry_count: number;
  max_retries: number;
  has_reference_image?: boolean;
  has_alternative_provider?: boolean;
}

export interface Decision {
  action: StageAction;
  reason: string;
  /** Variant count to try (1 means no variation, just retry). */
  variant_count: number;
  /** Optional hint to bias the prompt variation strategy. */
  variant_hint?: 'reference-emphasis' | 'simpler' | 'longer' | 'add-style' | 'add-camera';
}

const MAX_VARIANTS = 5;
const MIN_VARIANTS = 2;

export function decide(ctx: DecisionContext): Decision {
  const { quality, retry_count, max_retries, has_reference_image, has_alternative_provider } = ctx;

  // Rule 1: budget exhausted → escalate to human.
  if (retry_count >= max_retries) {
    return {
      action: 'escalate-to-human',
      reason: `retry budget exhausted (${retry_count}/${max_retries})`,
      variant_count: 0,
    };
  }

  // Find the metric with the lowest value (relative to its threshold).
  // That metric drives the decision.
  const failed = quality.metrics.filter((m) => !m.passed);
  if (failed.length === 0) {
    return { action: 'continue', reason: 'all metrics passed', variant_count: 0 };
  }

  // Sort by gap = (threshold - value) descending.
  failed.sort((a, b) => (b.threshold - b.value) - (a.threshold - a.value));
  const worst = failed[0] as MetricReading;

  // Rule 2-6: map failure class to action.
  switch (worst.name) {
    case 'subject_consistency': {
      // Identity drift. Strongest fix: re-generate with reference image
      // emphasis (or add reference if missing).
      const variantHint: Decision['variant_hint'] = has_reference_image
        ? 'reference-emphasis'
        : 'add-camera';
      return {
        action: 'retry-prompt-variation',
        reason: `subject_consistency=${worst.value.toFixed(3)} < ${worst.threshold}`,
        variant_count: has_reference_image ? MAX_VARIANTS : MIN_VARIANTS,
        variant_hint: variantHint,
      };
    }
    case 'temporal_flickering':
    case 'temporal_consistency':
    case 'motion_smoothness': {
      // Temporal artifacts usually benefit from a different seed.
      return {
        action: 'retry-seed',
        reason: `${worst.name}=${worst.value.toFixed(3)} < ${worst.threshold}`,
        variant_count: 1,
      };
    }
    case 'aesthetic_quality': {
      if (has_alternative_provider && retry_count < 2) {
        return {
          action: 'retry-provider',
          reason: `aesthetic=${worst.value.toFixed(3)}; routing to alternative provider`,
          variant_count: 1,
        };
      }
      return {
        action: 'retry-prompt-variation',
        reason: `aesthetic=${worst.value.toFixed(3)}; trying style/add-camera variants`,
        variant_count: MIN_VARIANTS,
        variant_hint: 'add-style',
      };
    }
    case 'prompt_alignment': {
      // The model didn't follow the prompt. Try rephrased variations.
      return {
        action: 'retry-prompt-variation',
        reason: `prompt_alignment=${worst.value.toFixed(3)}; rephrasing prompt`,
        variant_count: MIN_VARIANTS,
        variant_hint: 'longer',
      };
    }
    case 'duration_ok':
    case 'resolution_ok':
    case 'black_frame_ratio': {
      // Technical — usually the model produced the wrong format.
      // Fallback (skip the clip rather than retry forever).
      return {
        action: 'fallback',
        reason: `technical failure: ${worst.name}=${worst.value.toFixed(3)}`,
        variant_count: 0,
      };
    }
    case 'script_completeness':
    case 'audio_sync': {
      // Structural / sync — escalate to human (no easy auto-fix).
      return {
        action: 'escalate-to-human',
        reason: `${worst.name}=${worst.value.toFixed(3)}; auto-fix unavailable`,
        variant_count: 0,
      };
    }
    default: {
      // Unknown metric → conservative: try one retry with variation.
      return {
        action: 'retry-prompt-variation',
        reason: `unknown failure: ${worst.name}=${worst.value.toFixed(3)}`,
        variant_count: MIN_VARIANTS,
      };
    }
  }
}

/** Convenience: get a Decision from a bare QualityReport (no budget tracking). */
export function decideFromReport(
  quality: QualityReport,
  opts: { retry_count?: number; max_retries?: number; has_reference_image?: boolean; has_alternative_provider?: boolean } = {},
): Decision {
  return decide({
    quality,
    retry_count: opts.retry_count ?? 0,
    max_retries: opts.max_retries ?? 3,
    ...(opts.has_reference_image !== undefined && { has_reference_image: opts.has_reference_image }),
    ...(opts.has_alternative_provider !== undefined && { has_alternative_provider: opts.has_alternative_provider }),
  });
}