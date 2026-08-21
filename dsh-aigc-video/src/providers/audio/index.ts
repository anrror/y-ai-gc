/**
 * TTS provider factory — currently only MiniMax (speech-2.8-hd / turbo).
 * Add a `case` here when wiring a new TTS vendor.
 */

import type { ProviderConfig } from '../config.js';
import { MiniMaxTtsProvider } from './tts.js';
import type { TtsProvider } from '../types.js';

export function createTtsProvider(alias: string, cfg: ProviderConfig): TtsProvider {
  const a = alias.toLowerCase();
  if (a.includes('minimax') || a.includes('hailuo') || a.includes('speech')) {
    return new MiniMaxTtsProvider({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.modelName,
    });
  }
  throw new Error(`Unknown TTS provider alias: ${alias}`);
}
