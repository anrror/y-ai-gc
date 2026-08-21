/**
 * CharacterDesignerAgent (Phase 4.5).
 *
 * Reads the script (artifacts.script_generation) and produces a list of
 * characters with name / role / description / visual traits via LLM.
 */

import { BaseAgent } from '../pipeline/base_agent.js';
import type { AgentInput, AgentOutput } from '../pipeline/base_agent.js';

const CHARACTER_PROMPT = `你是角色设计师。请根据以下剧本，提炼出所有主要角色。

对每个角色输出：
- name: 角色名
- role: 主角/配角/反派/背景
- description: 1-2 句性格 + 背景
- visual_traits: 外貌关键词（用于生成参考图）

输出 JSON 数组：
[
  { "name": "...", "role": "...", "description": "...", "visual_traits": ["...", "..."] }
]

只输出 JSON。`;

interface Character {
  name: string;
  role?: string;
  description?: string;
  visual_traits?: string[];
}

export class CharacterDesignerAgent extends BaseAgent<'character_design'> {
  readonly stage = 'character_design' as const;

  async run(input: AgentInput): Promise<AgentOutput> {
    const scriptArtifact = input.meta.artifacts as { script_generation?: { full_script?: string; logline?: string } } | undefined;
    const script = scriptArtifact?.script_generation?.full_script
      ?? scriptArtifact?.script_generation?.logline
      ?? input.user_prompt;
    if (!script?.trim()) {
      return {
        payload: {},
        hint: '缺少剧本内容',
        artifacts: {},
        completed: false,
        requires_intervention: true,
        error: 'script_generation artifact required',
      };
    }
    try {
      const resp = await this.chat(
        [
          { role: 'system', content: '你是一位专业的角色设计师，输出严格 JSON 数组。' },
          { role: 'user', content: `${CHARACTER_PROMPT}\n\n剧本：${script.slice(0, 6000)}` },
        ],
        { temperature: 0.7, maxTokens: 2048, signal: input.signal },
      );
      const characters = extractJsonArray(resp.content) as Character[];
      return {
        payload: { characters },
        hint: `已设计 ${characters.length} 个角色，进入分镜阶段。`,
        artifacts: { character_design: { characters } },
        completed: true,
        requires_intervention: false,
      };
    } catch (e) {
      return {
        payload: {},
        hint: '角色设计失败',
        artifacts: {},
        completed: false,
        requires_intervention: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function extractJsonArray(text: string): Character[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const tryParse = (s: string): unknown => JSON.parse(s);
  try {
    const v = tryParse(stripped);
    return Array.isArray(v) ? (v as Character[]) : [];
  } catch {
    const a = stripped.indexOf('[');
    const b = stripped.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try {
        const v = tryParse(stripped.slice(a, b + 1));
        return Array.isArray(v) ? (v as Character[]) : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}