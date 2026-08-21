/**
 * BaseAgent — every concrete stage agent implements this.
 * Mirrors the Python backend's `framework/core/base_agent.py`.
 *
 * Phase 5.5: accept optional `llm` / `image` / `video` / `tts` providers
 * via `AgentDeps`. The 7 pipeline agents need:
 *   - script_writer, character_designer, storyboard, editor       → LLM only
 *   - reference_generator                                          → Image only
 *   - video_director                                               → Video only
 *   - voice_director                                               → TTS only
 */

import type { ChatMessage, ChatResponse } from '../providers/types.js';
import { OpenAICompatibleLLM } from '../providers/llm/index.js';
import type { ImageProvider, LLMProvider, TtsProvider, VideoProvider } from '../providers/types.js';

export interface AgentInput {
  session_id: string;
  project_name: string;
  user_prompt: string;
  /** Stage-specific payload (story, script, shots, …) — keys depend on stage. */
  meta: Record<string, unknown>;
  /** When true, the agent should persist artefacts and update state. */
  is_final_attempt: boolean;
  /** Cancellation signal for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface AgentOutput {
  payload: Record<string, unknown>;
  /** Human-readable summary for the DSH agent to surface to the user. */
  hint: string;
  /** Persisted under `state.artifacts[stage]`. */
  artifacts: Record<string, unknown>;
  /** When true, the orchestrator advances the state machine. */
  completed: boolean;
  /** When true, the agent needs a user intervention before continuing. */
  requires_intervention: boolean;
  /** Free-form error message; orchestrator records it and stops. */
  error?: string;
}

/** Optional dependencies an agent may need. */
export interface AgentDeps {
  llm?: LLMProvider;
  image?: ImageProvider;
  video?: VideoProvider;
  tts?: TtsProvider;
}

export abstract class BaseAgent<S extends string = string> {
  abstract readonly stage: S;
  protected readonly llm: LLMProvider | undefined;
  protected readonly image: ImageProvider | undefined;
  protected readonly video: VideoProvider | undefined;
  protected readonly tts: TtsProvider | undefined;

  constructor(deps: AgentDeps = {}) {
    this.llm = deps.llm;
    this.image = deps.image;
    this.video = deps.video;
    this.tts = deps.tts;
  }

  abstract run(input: AgentInput): Promise<AgentOutput>;

  /** Convenience: ask the LLM provider for a chat completion. Throws if no LLM configured. */
  protected async chat(
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
  ): Promise<ChatResponse> {
    if (!this.llm) throw new Error(`agent ${this.stage} requires an LLM provider but none was configured`);
    const model = this.llm instanceof OpenAICompatibleLLM ? 'openai-compatible' : this.llm.providerName;
    return this.llm.chat({ model, messages, ...opts });
  }
}