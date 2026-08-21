/**
 * Provider Router — wraps several video providers behind a single
 * `VideoProvider` interface with pluggable strategies.
 *
 * Why this exists:
 *   Hailuo v2's `reference_image` is a SOFT signal that drifts identities
 *   across distant shots. The only path to HARD subject-consistency lock
 *   today is switching providers (Kling Element Library, Seedance
 *   12-file multi-modal, …). Without a router, swapping providers means
 *   rewriting CreativePipeline. With it, callers just configure the chain.
 *
 * Strategies:
 *   - 'priority'        — try providers in order, fall back on quota/network
 *   - 'round-robin'     — distribute load evenly (good for quota splitting)
 *   - 'first-success'   — race all providers, return whoever succeeds first
 *
 * The router is transparent: any `VideoProvider` works as a backend. The
 * task-id returned to the caller is namespaced (`hailuo:abc123`,
 * `kling:xyz789`) so `poll()` can route back to the right backend.
 *
 * Future provider (Kling/Veo/Seedance) = add to `cfg.providers`, no code
 * changes needed.
 */

import type { VideoGenerationRequest, VideoProvider, VideoResult } from './types.js';
import { ProviderError } from './base.js';

export type RoutingStrategy = 'priority' | 'round-robin' | 'first-success';

export interface ProviderRouterConfig {
  /** Providers in priority order (index 0 = first attempt). */
  providers: VideoProvider[];
  /** Default 'priority'. */
  strategy?: RoutingStrategy;
  /**
   * Max retries per provider before the router gives up on that backend.
   * Default 1 — i.e. each provider is tried once.
   */
  maxAttemptsPerProvider?: number;
}

export interface RouterAttemptLog {
  provider: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export class ProviderRouter implements VideoProvider {
  readonly providerName: string;
  private readonly strategy: RoutingStrategy;
  private readonly providers: VideoProvider[];
  private readonly maxAttempts: number;
  private readonly attemptsByProvider: Map<string, number> = new Map();
  private readonly attemptLog: RouterAttemptLog[] = [];
  private roundRobinIdx = 0;

  constructor(cfg: ProviderRouterConfig) {
    if (cfg.providers.length < 1) {
      throw new Error('ProviderRouter: at least one provider is required');
    }
    this.providers = cfg.providers;
    this.strategy = cfg.strategy ?? 'priority';
    this.maxAttempts = cfg.maxAttemptsPerProvider ?? 1;
    this.providerName = `router(${this.providers.map((p) => p.providerName).join('|')})`;
    // Validate strategy at construction time (fail fast).
    if (!['priority', 'round-robin', 'first-success'].includes(this.strategy)) {
      throw new Error(`ProviderRouter: unknown strategy '${this.strategy}'`);
    }
  }

  /**
   * Read-only access to the per-run attempt log. Useful for the
   * quality report CLI and for debugging "why did it pick provider X?".
   */
  getAttemptLog(): ReadonlyArray<RouterAttemptLog> {
    return this.attemptLog;
  }

  async submit(req: VideoGenerationRequest): Promise<string> {
    const start = Date.now();
    if (this.strategy === 'first-success') {
      return this.submitFirstSuccess(req, start);
    }
    return this.submitSequential(req, start);
  }

  async poll(taskId: string, signal?: AbortSignal): Promise<VideoResult> {
    const [providerName, realTaskId] = this.splitTaskId(taskId);
    if (!providerName || !realTaskId) {
      throw new Error(`ProviderRouter.poll: taskId '${taskId}' is not namespaced`);
    }
    const provider = this.providers.find((p) => p.providerName === providerName);
    if (!provider) {
      throw new Error(`ProviderRouter.poll: no provider named '${providerName}'`);
    }
    return provider.poll(realTaskId, signal);
  }

  // ── private helpers ────────────────────────────────────────────────────

  private async submitSequential(
    req: VideoGenerationRequest,
    startedAt: number,
  ): Promise<string> {
    const ordered = this.orderedProviders();
    const errors: Error[] = [];
    for (const provider of ordered) {
      if ((this.attemptsByProvider.get(provider.providerName) ?? 0) >= this.maxAttempts) {
        continue;
      }
      const attemptStart = Date.now();
      try {
        const taskId = await provider.submit(req);
        this.attemptsByProvider.set(provider.providerName, 0);
        this.attemptLog.push({
          provider: provider.providerName,
          ok: true,
          durationMs: Date.now() - attemptStart,
        });
        return this.makeTaskId(provider.providerName, taskId);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.attemptsByProvider.set(
          provider.providerName,
          (this.attemptsByProvider.get(provider.providerName) ?? 0) + 1,
        );
        this.attemptLog.push({
          provider: provider.providerName,
          ok: false,
          error: err.message,
          durationMs: Date.now() - attemptStart,
        });
        errors.push(err);
        // Only fall through on recoverable errors; non-recoverable throws
        // immediately so callers don't wait through dead providers.
        if (!this.isRecoverable(err)) throw err;
      }
    }
    throw new Error(
      `ProviderRouter: all ${ordered.length} provider(s) exhausted ` +
      `(total ${Date.now() - startedAt}ms): ` +
      errors.map((e) => e.message).join(' | '),
    );
  }

  private async submitFirstSuccess(
    req: VideoGenerationRequest,
    startedAt: number,
  ): Promise<string> {
    // Race all providers in parallel; pick the one that resolved first by
    // timestamp. Note we cannot cancel the losers at this layer (no
    // shared cancellation channel), but they continue in the background;
    // the user pays the quota for whichever providers actually submitted.
    const settled = await Promise.allSettled(
      this.providers.map(async (p) => {
        const attemptStart = Date.now();
        try {
          const taskId = await p.submit(req);
          const resolvedAt = Date.now();
          this.attemptLog.push({
            provider: p.providerName,
            ok: true,
            durationMs: resolvedAt - attemptStart,
          });
          return { provider: p.providerName, taskId, resolvedAt };
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          this.attemptLog.push({
            provider: p.providerName,
            ok: false,
            error: err.message,
            durationMs: Date.now() - attemptStart,
          });
          throw err;
        }
      }),
    );

    // Walk the settled array and pick the EARLIEST successful resolution
    // (by resolvedAt timestamp). This is the semantic of "first-success"
    // — fastest backend wins, not the first one in the array.
    let best: { provider: string; taskId: string; resolvedAt: number } | null = null;
    const errors: string[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if (!best || r.value.resolvedAt < best.resolvedAt) {
          best = r.value;
        }
      } else {
        errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }
    if (best) {
      return this.makeTaskId(best.provider, best.taskId);
    }
    throw new Error(
      `ProviderRouter (first-success): all ${this.providers.length} failed ` +
      `(${Date.now() - startedAt}ms): ${errors.join(' | ')}`,
    );
  }

  private orderedProviders(): VideoProvider[] {
    if (this.strategy !== 'round-robin') return this.providers;
    const start = this.roundRobinIdx;
    this.roundRobinIdx = (this.roundRobinIdx + 1) % this.providers.length;
    return [...this.providers.slice(start), ...this.providers.slice(0, start)];
  }

  /** Encode the provider name into the returned taskId so `poll()` can route back. */
  private makeTaskId(providerName: string, realTaskId: string): string {
    return `${providerName}:${realTaskId}`;
  }

  /** Inverse of makeTaskId. Returns [providerName, realTaskId] or [null, null] on bad input. */
  private splitTaskId(taskId: string): [string | null, string | null] {
    const idx = taskId.indexOf(':');
    if (idx < 1 || idx === taskId.length - 1) return [null, null];
    return [taskId.slice(0, idx), taskId.slice(idx + 1)];
  }

  /**
   * Decide whether an error is worth falling through to the next
   * provider. Quota exhaustion and network errors fall through;
   * bad requests / cancelled / unknown abort immediately.
   */
  private isRecoverable(e: Error): boolean {
    if (e instanceof ProviderError) {
      return e.kind === 'quota_exceeded' || e.kind === 'network';
    }
    // Unwrapped errors (raw fetch failures, ENOENT, etc.) are treated as
    // recoverable so a single broken provider doesn't poison the chain.
    return true;
  }

  /**
   * Reset attempt counters (call between independent runs so a run that
   * exhausted Hailuo's quota doesn't carry over to the next).
   */
  reset(): void {
    this.attemptsByProvider.clear();
    this.roundRobinIdx = 0;
    this.attemptLog.length = 0;
  }
}