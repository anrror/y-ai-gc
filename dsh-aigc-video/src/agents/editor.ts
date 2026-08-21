/**
 * EditorAgent (Phase 4.5).
 *
 * Combines script + characters + shots + generated videos → SRT captions
 * + final edit decisions. LLM-only (no provider cost).
 */

import { BaseAgent } from '../pipeline/base_agent.js';
import type { AgentInput, AgentOutput } from '../pipeline/base_agent.js';

const EDIT_PROMPT = `你是后期编辑。根据剧本和分镜生成 SRT 字幕和最终剪辑决策。

输出 JSON：
{
  "captions": [
    { "start": 0, "end": 5, "text": "..." }
  ],
  "edit_decisions": {
    "transitions": [{"after_shot": 1, "kind": "crossfade", "duration": 0.5}],
    "bgm_recommendation": "ambient piano with subtle tension, 60-80 BPM"
  },
  "summary": "一句话总览"
}

只输出 JSON。`;

interface Caption {
  start: number;
  end: number;
  text: string;
}

interface EditDecisions {
  transitions?: Array<{ after_shot: number; kind: string; duration: number }>;
  bgm_recommendation?: string;
}

export class EditorAgent extends BaseAgent<'post_production'> {
  readonly stage = 'post_production' as const;

  async run(input: AgentInput): Promise<AgentOutput> {
    const arts = input.meta.artifacts as {
      script_generation?: { full_script?: string; beat_sheet?: string[] };
      character_design?: { characters?: { name: string }[] };
      storyboard?: { shots?: { index: number; description: string; duration: number }[] };
      video_generation?: { clips?: { shot_index: number; video_url: string }[] };
    } | undefined;
    const shots = arts?.storyboard?.shots ?? [];
    const context = {
      script: arts?.script_generation?.full_script?.slice(0, 3000) ?? '',
      characters: arts?.character_design?.characters ?? [],
      shots: shots.map((s) => ({ index: s.index, description: s.description, duration: s.duration })),
      video_urls: arts?.video_generation?.clips ?? [],
    };
    if (!shots.length) {
      return {
        payload: {},
        hint: '缺少分镜',
        artifacts: {},
        completed: false,
        requires_intervention: true,
        error: 'storyboard artifact required',
      };
    }
    try {
      const resp = await this.chat(
        [
          { role: 'system', content: '你是一位专业影视后期编辑，输出严格 JSON。' },
          { role: 'user', content: `${EDIT_PROMPT}\n\n素材：${JSON.stringify(context).slice(0, 6000)}` },
        ],
        { temperature: 0.6, maxTokens: 2048, signal: input.signal },
      );
      const parsed = extractJson(resp.content) as {
        captions?: Caption[];
        edit_decisions?: EditDecisions;
        summary?: string;
      };
      const captions = parsed.captions ?? [];
      const editDecisions = parsed.edit_decisions ?? { transitions: [] };
      const summary = parsed.summary ?? '编辑完成';
      // Build SRT string
      const srt = captionsToSrt(captions);
      return {
        payload: { captions, edit_decisions: editDecisions, summary, srt },
        hint: '后期编辑完成，输出 SRT 字幕。',
        artifacts: { post_production: { captions, edit_decisions: editDecisions, summary, srt } },
        completed: true,
        requires_intervention: false,
      };
    } catch (e) {
      return {
        payload: {},
        hint: '后期编辑失败',
        artifacts: {},
        completed: false,
        requires_intervention: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(stripped) as Record<string, unknown>; }
  catch {
    const a = stripped.indexOf('{');
    const b = stripped.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(stripped.slice(a, b + 1)) as Record<string, unknown>; }
      catch { return null; }
    }
    return null;
  }
}

function captionsToSrt(captions: Caption[]): string {
  const fmt = (s: number): string => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return captions.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
}