/**
 * LLM provider base — OpenAI-compatible chat completions.
 *
 * Most LLM providers (DeepSeek, Qwen, GLM, Kimi, iSigning) expose an
 * OpenAI-compatible `/v1/chat/completions` endpoint. We model the base
 * on that contract and let concrete providers override routing + auth.
 */

import { BaseProvider } from '../base.js';
import type { ChatRequest, ChatResponse, LLMProvider } from '../types.js';

interface OpenAIChatReq {
  model: string;
  messages: Array<{ role: string; content: string; name?: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: false;
}

interface OpenAIChatResp {
  choices: Array<{
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export abstract class OpenAICompatibleLLM extends BaseProvider implements LLMProvider {
  abstract readonly providerName: string;
  /** Path to chat completions endpoint (default `/v1/chat/completions`). */
  protected chatPath(): string {
    return '/v1/chat/completions';
  }
  /** Some providers want a different model id at the wire level. */
  protected wireModel(model: string): string {
    return model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: OpenAIChatReq = {
      model: this.wireModel(req.model),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content, name: m.name })),
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
      stream: false,
    };
    const url = `${this.baseUrl}${this.chatPath()}`;
    const resp = await this.http.request<OpenAIChatResp>({
      method: 'POST',
      url,
      body,
      signal: req.signal,
      timeoutMs: 120_000,
    });
    const choice = resp.choices[0];
    return {
      content: choice?.message?.content ?? '',
      model: resp.model,
      usage: resp.usage
        ? {
            promptTokens: resp.usage.prompt_tokens,
            completionTokens: resp.usage.completion_tokens,
            totalTokens: resp.usage.total_tokens,
          }
        : undefined,
      finishReason: choice?.finish_reason,
    };
  }
}

// ── Concrete provider stubs (Phase 2 sub-tasks) ──────────────────────────

export class DeepSeekLLM extends OpenAICompatibleLLM {
  readonly providerName = 'deepseek';
}
export class QwenLLM extends OpenAICompatibleLLM {
  readonly providerName = 'qwen';
}
export class GllmLLM extends OpenAICompatibleLLM {
  readonly providerName = 'glm';
}
export class KimiLLM extends OpenAICompatibleLLM {
  readonly providerName = 'kimi';
}
export class IsigningLLM extends OpenAICompatibleLLM {
  readonly providerName = 'isigning';
}
export class MinimaxLLM extends OpenAICompatibleLLM {
  readonly providerName = 'minimax';
}

export function createLLMProvider(alias: string, cfg: import('../config.js').ProviderConfig) {
  const a = alias.toLowerCase();
  if (a.includes('deepseek')) return new DeepSeekLLM(cfg);
  if (a.includes('qwen')) return new QwenLLM(cfg);
  if (a.includes('glm')) return new GllmLLM(cfg);
  if (a.includes('kimi')) return new KimiLLM(cfg);
  if (a.includes('isigning')) return new IsigningLLM(cfg);
  if (a.includes('minimax')) return new MinimaxLLM(cfg);
  throw new Error(`Unknown LLM provider alias: ${alias}`);
}