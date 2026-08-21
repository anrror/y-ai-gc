/**
 * VLM (vision-language model) provider stubs.
 *
 * Qwen-VL and Gemini-VL use multipart / accept patterns similar to their
 * LLM counterparts but with image inputs. Phase 2 sub-task.
 */

import { BaseProvider } from '../base.js';
import type { VlmProvider, VlmRequest, ChatResponse } from '../types.js';

export abstract class BaseVlmProvider extends BaseProvider implements VlmProvider {
  abstract readonly providerName: string;
  abstract chatWithImages(req: VlmRequest): Promise<ChatResponse>;
}

export class QwenVlProvider extends BaseVlmProvider {
  readonly providerName = 'qwen-vl';
  async chatWithImages(_req: VlmRequest): Promise<ChatResponse> {
    throw new Error('QwenVlProvider: Phase 2 stub — not implemented yet');
  }
}
export class GeminiVlProvider extends BaseVlmProvider {
  readonly providerName = 'gemini-vl';
  async chatWithImages(_req: VlmRequest): Promise<ChatResponse> {
    throw new Error('GeminiVlProvider: Phase 2 stub — not implemented yet');
  }
}

export function createVlmProvider(alias: string, cfg: import('../config.js').ProviderConfig) {
  const a = alias.toLowerCase();
  if (a.includes('qwen')) return new QwenVlProvider(cfg);
  if (a.includes('gemini')) return new GeminiVlProvider(cfg);
  throw new Error(`Unknown VLM provider alias: ${alias}`);
}