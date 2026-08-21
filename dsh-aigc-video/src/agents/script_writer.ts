/**
 * ScriptWriterAgent (real implementation, Phase 4 first deliverable).
 *
 * Drives an LLM through the script-generation stage. Reads the user's idea
 * from `meta.story` and emits a structured script payload (logline, beat
 * sheet, full_script). Falls back to a deterministic stub when no LLM is
 * configured (so the rest of the pipeline can be tested offline).
 */

import { BaseAgent } from '../pipeline/base_agent.js';
import type { AgentInput, AgentOutput } from '../pipeline/base_agent.js';

const SCRIPT_PROMPT = `你是专业影视编剧。请根据用户的创意生成结构化剧本，包括：
1. 一句话概要 (logline)
2. 情节点 (beat sheet) — 4-6 个关键节拍
3. 完整剧本 (full_script)

输出 JSON 格式：
{
  "logline": "...",
  "beat_sheet": ["..."],
  "full_script": "..."
}`;

export class ScriptWriterAgent extends BaseAgent<'script_generation'> {
  readonly stage = 'script_generation' as const;

  async run(input: AgentInput): Promise<AgentOutput> {
    const idea = (input.meta.story as string | undefined) ?? input.user_prompt;
    if (!idea?.trim()) {
      return {
        payload: {},
        hint: '缺少创意描述',
        artifacts: {},
        completed: false,
        requires_intervention: true,
        error: 'meta.story or user_prompt required',
      };
    }
    try {
      const resp = await this.chat(
        [
          { role: 'system', content: '你是一位专业的中文影视编剧，输出严格 JSON。' },
          { role: 'user', content: `${SCRIPT_PROMPT}\n\n用户创意：${idea}` },
        ],
        { temperature: 0.7, maxTokens: 2048, signal: input.signal },
      );
      // Best-effort JSON parse; the LLM may emit code-fenced JSON.
      const text = resp.content.trim();
      const parsed = extractJson(text);
      const payload = (parsed ?? {}) as Record<string, unknown>;
      return {
        payload,
        hint: '剧本已生成，进入角色/场景设计阶段。',
        artifacts: { script_generation: payload },
        completed: true,
        requires_intervention: false,
      };
    } catch (e) {
      return {
        payload: {},
        hint: '剧本生成失败',
        artifacts: {},
        completed: false,
        requires_intervention: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  // Strip optional ```json ... ``` fences.
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}