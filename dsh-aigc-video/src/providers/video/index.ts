/**
 * Video provider entry — currently only Hailuo (full). Stub registries for the
 * remaining models (Kling, Wan, SelfHost) until Phase 2 sub-tasks fill them
 * in.
 */

import type { ProviderConfig } from '../config.js';
import { BaseProvider } from '../base.js';
import type { VideoGenerationRequest, VideoResult, VideoProvider } from '../types.js';
import { HailuoVideoProvider } from './hailuo.js';

export { HailuoVideoProvider };

// ── Stubs (Phase 2 sub-tasks) ────────────────────────────────────────────

export class KlingVideoProvider extends BaseProvider implements VideoProvider {
  readonly providerName = 'kling';
  async submit(_req: VideoGenerationRequest): Promise<string> {
    throw new Error('KlingVideoProvider: Phase 2 stub — not implemented yet');
  }
  async poll(_taskId: string): Promise<VideoResult> {
    throw new Error('KlingVideoProvider: Phase 2 stub');
  }
}

export class WanVideoProvider extends BaseProvider implements VideoProvider {
  readonly providerName = 'wan';
  async submit(_req: VideoGenerationRequest): Promise<string> {
    throw new Error('WanVideoProvider: Phase 2 stub — not implemented yet');
  }
  async poll(_taskId: string): Promise<VideoResult> {
    throw new Error('WanVideoProvider: Phase 2 stub');
  }
}

export class SelfHostVideoProvider extends BaseProvider implements VideoProvider {
  readonly providerName = 'selfhost';
  async submit(_req: VideoGenerationRequest): Promise<string> {
    throw new Error('SelfHostVideoProvider: Phase 2 stub — not implemented yet');
  }
  async poll(_taskId: string): Promise<VideoResult> {
    throw new Error('SelfHostVideoProvider: Phase 2 stub');
  }
}

/** Factory: resolve model alias to a concrete VideoProvider. */
export function createVideoProvider(alias: string, cfg: ProviderConfig) {
  const a = alias.toLowerCase();
  if (a.includes('hailuo') || a === 'minimax-h3') return new HailuoVideoProvider(cfg);
  if (a.includes('kling')) return new KlingVideoProvider(cfg);
  if (a.includes('wan')) return new WanVideoProvider(cfg);
  if (a.includes('selfhost')) return new SelfHostVideoProvider(cfg);
  throw new Error(`Unknown video provider alias: ${alias}`);
}