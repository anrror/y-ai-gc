/**
 * Per-provider token-budget tracker.
 *
 * Every `submit()` to a video provider consumes quota. This module gives
 * us a single in-memory place to:
 *   - track total estimated credits used per provider per run
 *   - project when quota will reset (when `reset_at` is reported by API)
 *   - expose a structured status for the `/quota` CLI and the
 *     quality-report CLI
 *
 * For real provider APIs we don't currently pull quota state (Hailuo
 * doesn't return headers we can introspect), so the tracker is
 * ESTIMATED from the shot count + duration via `estimateRunCost`. The
 * shape is API-stable so swapping in a real provider introspection is a
 * non-breaking change later.
 */

import type { RunEstimate } from '../cost/estimator.js';

export interface ProviderQuotaRecord {
  provider: string;
  shots_submitted: number;
  shots_succeeded: number;
  shots_failed: number;
  estimated_credits_used: number;
  estimated_usd_used: number;
  /** Last error seen for this provider (None = healthy). */
  last_error?: string;
  /** Timestamp of last activity. */
  updated_at: string;
}

export interface QuotaReport {
  session_id: string;
  generated_at: string;
  providers: ProviderQuotaRecord[];
  totals: {
    shots_submitted: number;
    shots_succeeded: number;
    shots_failed: number;
    estimated_credits_used: number;
    estimated_usd_used: number;
  };
}

export class QuotaTracker {
  private records = new Map<string, ProviderQuotaRecord>();

  /** Record one successful submission to a provider. */
  recordSubmit(provider: string, success: boolean, error?: string, estimate?: RunEstimate): void {
    const existing = this.records.get(provider) ?? this.emptyRecord(provider);
    existing.shots_submitted++;
    if (success) existing.shots_succeeded++;
    else existing.shots_failed++;
    if (error) existing.last_error = error;
    if (estimate) {
      // estimate is for the WHOLE run, not a single shot — apply once on
      // first success of this provider to avoid double-counting.
      if (existing.estimated_credits_used === 0) {
        existing.estimated_credits_used = estimate.breakdown_tokens.total;
        existing.estimated_usd_used = estimate.breakdown.total_usd;
      }
    }
    existing.updated_at = new Date().toISOString();
    this.records.set(provider, existing);
  }

  /** Snapshot for the CLI / quality-report consumer. */
  report(sessionId: string): QuotaReport {
    const providers = [...this.records.values()];
    return {
      session_id: sessionId,
      generated_at: new Date().toISOString(),
      providers,
      totals: {
        shots_submitted: providers.reduce((s, p) => s + p.shots_submitted, 0),
        shots_succeeded: providers.reduce((s, p) => s + p.shots_succeeded, 0),
        shots_failed: providers.reduce((s, p) => s + p.shots_failed, 0),
        estimated_credits_used: providers.reduce((s, p) => s + p.estimated_credits_used, 0),
        estimated_usd_used: providers.reduce((s, p) => s + p.estimated_usd_used, 0),
      },
    };
  }

  private emptyRecord(provider: string): ProviderQuotaRecord {
    return {
      provider,
      shots_submitted: 0,
      shots_succeeded: 0,
      shots_failed: 0,
      estimated_credits_used: 0,
      estimated_usd_used: 0,
      updated_at: new Date().toISOString(),
    };
  }
}