/**
 * VoiceDirectorAgent (Phase 5.5).
 *
 * 6-stage pipeline → 7-stage with voice generation. After video clips
 * are produced, this agent:
 *   1. Reads the storyboard (shots with characters + actions + dialog)
 *   2. Walks the script and segments dialog by character
 *   3. For each line, calls the TTS provider with the assigned voice_id
 *      (system voice, cloned voice, or designed voice)
 *   4. Emits per-shot audio tracks that the post-production stage will
 *      mux with the corresponding video clip
 *
 * Provider-agnostic — works with any `TtsProvider` (currently
 * `MiniMaxTtsProvider` for speech-2.8-hd / speech-2.8-turbo, but the
 * interface supports 01/02/2.6/2.8 models).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BaseAgent } from '../pipeline/base_agent.js';
import type { AgentInput, AgentOutput } from '../pipeline/base_agent.js';
import { ProviderError, withProviderRetry } from '../providers/base.js';

const VOICE_PROMPT = `你是配音导演 (Voice Director)。请根据剧本和角色列表，为每一句台词：
- 角色映射：分析该句台词是谁说的
- 音色选择：基于角色性格选择合适的 voice_id（系统/复刻/设计）
- 情感标注：识别台词情感（happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper）
- 停顿控制：在适当位置插入 <#x#> 停顿标记（秒）
- 语气词：在适当位置插入 (laughs)/(sighs) 等语气词

输出 JSON 数组，每条对应一句台词：
[
  { "shot_index": 1, "character": "狐小机灵", "voice_id": "female-shaonv", "emotion": "happy", "text": "各位森林街坊注意了！", "speed": 1.0, "pause_after": 0.5 }
]
仅输出 JSON。`;

interface Shot {
  index: number;
  description: string;
  visual_prompt: string;
  characters?: string[];
}

interface ScriptActs {
  title: string;
  characters: Array<{ name: string; description: string; voice_id?: string }>;
  shots: Shot[];
}

interface VoiceLine {
  shot_index: number;
  character: string;
  voice_id: string;
  emotion?: string;
  text: string;
  speed?: number;
  pause_after?: number;
  audio_path?: string;
  audio_length_ms?: number;
}

export class VoiceDirectorAgent extends BaseAgent<'voice_generation'> {
  readonly stage = 'voice_generation' as const;

  async run(input: AgentInput): Promise<AgentOutput> {
    if (!this.tts) {
      return {
        payload: {},
        hint: '需要 TTS provider (configure providers.tts in config.yaml)',
        artifacts: {},
        completed: false,
        requires_intervention: false,
        error: 'VoiceDirectorAgent requires a TTS provider; configure providers.tts in config.yaml',
      };
    }
    const meta = input.meta as {
      storyboard?: { shots?: Shot[] };
      script_generation?: { characters?: Array<{ name: string; description: string; voice_id?: string }>; title?: string };
    };
    const shots = meta.storyboard?.shots ?? [];
    const characters = meta.script_generation?.characters ?? [];
    if (shots.length === 0) {
      return {
        payload: {},
        hint: '缺少分镜 (storyboard artifact required)',
        artifacts: {},
        completed: false,
        requires_intervention: true,
        error: 'storyboard artifact required',
      };
    }

    // Step 1: ask LLM to assign voices (or use pre-assigned voice_id from
    // character_design stage if present).
    const voiceAssignments = await this.assignVoices(input.user_prompt, characters, shots);

    // Step 2: TTS each line via the configured provider.
    const outDir = `code/result/voice/${input.session_id}`;
    mkdirSync(outDir, { recursive: true });

    const tts = this.tts; // capture for closure narrowing (TS strict)
    const lines: VoiceLine[] = [];
    const errors: string[] = [];
    let quotaAborted = false;
    for (const line of voiceAssignments) {
      if (quotaAborted) {
        errors.push(`shot ${line.shot_index} (${line.character}): skipped (run aborted: quota exceeded)`);
        continue;
      }
      try {
        const path = `${outDir}/shot_${String(line.shot_index).padStart(3, '0')}_${line.character}.mp3`;
        const out = await withProviderRetry(
          () => tts.submit({
            text: line.text,
            voiceId: line.voice_id,
            outputPath: path,
            ...(line.emotion ? { emotion: line.emotion as never } : {}),
            ...(line.speed ? { speed: line.speed } : {}),
            format: 'mp3',
          }),
          { signal: input.signal, maxRetries: 2 },
        );
        lines.push({ ...line, audio_path: out });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`shot ${line.shot_index} (${line.character}): ${msg}`);
        if (e instanceof ProviderError && e.kind === 'quota_exceeded') {
          quotaAborted = true;
        }
      }
    }

    return {
      payload: { lines, errors },
      hint: `已为 ${lines.length}/${voiceAssignments.length} 句台词配音${errors.length ? `, 失败 ${errors.length}` : ''}`,
      artifacts: { voice_generation: { lines, errors } },
      completed: errors.length === 0,
      requires_intervention: errors.length > 0 && lines.length === 0,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    };
  }

  /** Ask the LLM to map dialog lines → (character, voice_id, emotion, text). */
  private async assignVoices(
    script: string,
    characters: Array<{ name: string; description: string; voice_id?: string }>,
    shots: Shot[]
  ): Promise<VoiceLine[]> {
    if (!this.llm) {
      // No LLM: fall back to a heuristic — distribute dialog evenly across
      // characters. This is a degenerate path; LLM is strongly recommended.
      return shots
        .filter((s) => s.characters?.length)
        .map((s) => ({
          shot_index: s.index,
          character: s.characters![0]!,
          voice_id: characters.find((c) => c.name === s.characters![0])?.voice_id ?? 'female-shaonv',
          text: s.description,
        }));
    }
    const resp = await this.chat(
      [
        { role: 'system', content: '你是一位专业的中文配音导演，输出严格 JSON。' },
        { role: 'user', content: `${VOICE_PROMPT}\n\n剧本：${script.slice(0, 4000)}\n\n角色：${JSON.stringify(characters).slice(0, 1500)}` },
      ],
      { temperature: 0.7, maxTokens: 4000 },
    );
    try {
      const cleaned = resp.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      const parsed = JSON.parse(cleaned) as VoiceLine[];
      return parsed;
    } catch {
      return [];
    }
  }
}