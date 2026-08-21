/**
 * StoryboardAgent (Phase 4.5).
 *
 * Reads script + characters; produces a shot list (each shot has index,
 * duration, description, visual_prompt) via LLM.
 */

import { BaseAgent } from '../pipeline/base_agent.js';
import type { AgentInput, AgentOutput } from '../pipeline/base_agent.js';

const SHOT_PROMPT = `你是分镜师。请根据剧本和角色列表生成镜头脚本（shot list）。

对每个镜头输出：
- index: 镜头序号（从1开始）
- duration: 时长（秒，4-10）
- description: 这个镜头展示什么
- visual_prompt: 用于视频生成的英文/中文 prompt（包含运镜、视角、氛围）
- characters: 该镜头涉及的角色名

输出 JSON 数组，按剧情顺序排列：
[
  { "index": 1, "duration": 5, "description": "...", "visual_prompt": "...", "characters": ["..."] }
]

只输出 JSON。`;

interface Shot {
  index: number;
  duration: number;
  description: string;
  visual_prompt: string;
  characters?: string[];
}

export class StoryboardAgent extends BaseAgent<'storyboard'> {
  readonly stage = 'storyboard' as const;

  async run(input: AgentInput): Promise<AgentOutput> {
    const arts = input.meta.artifacts as {
      script_generation?: { full_script?: string; logline?: string };
      character_design?: { characters?: { name: string }[] };
    } | undefined;
    const script = arts?.script_generation?.full_script ?? arts?.script_generation?.logline ?? input.user_prompt;
    const characters = arts?.character_design?.characters ?? [];
    if (!script?.trim()) {
      return {
        payload: {},
        hint: '缺少剧本',
        artifacts: {},
        completed: false,
        requires_intervention: true,
        error: 'script_generation artifact required',
      };
    }
    try {
      const resp = await this.chat(
        [
          { role: 'system', content: '你是一位专业的分镜师，输出严格 JSON 数组。' },
          {
            role: 'user',
            content: `${SHOT_PROMPT}\n\n剧本：${script.slice(0, 5000)}\n\n角色：${JSON.stringify(characters).slice(0, 1500)}`,
          },
        ],
        { temperature: 0.7, maxTokens: 3000, signal: input.signal },
      );
      const shots = extractJsonArray(resp.content) as Shot[];
      // Ensure indices are sequential 1..N
      const normalised = shots.map((s, i) => ({ ...s, index: i + 1 }));
      return {
        payload: { shots: normalised },
        hint: `已生成 ${normalised.length} 个镜头，进入参考图阶段。`,
        artifacts: { storyboard: { shots: normalised } },
        completed: true,
        requires_intervention: false,
      };
    } catch (e) {
      return {
        payload: {},
        hint: '分镜生成失败',
        artifacts: {},
        completed: false,
        requires_intervention: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function extractJsonArray(text: string): Shot[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const tryParse = (s: string): unknown => JSON.parse(s);
  try {
    const v = tryParse(stripped);
    return Array.isArray(v) ? (v as Shot[]) : [];
  } catch {
    const a = stripped.indexOf('[');
    const b = stripped.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try {
        const v = tryParse(stripped.slice(a, b + 1));
        return Array.isArray(v) ? (v as Shot[]) : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}