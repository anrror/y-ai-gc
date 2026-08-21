/**
 * `aigc_voice_dub` — generate per-shot voice tracks for a script.
 *
 * Phase 5.5: end-to-end voice generation. Reads a storyboard + script
 * (with character voices assigned), runs the VoiceDirectorAgent to
 * decide per-line voice_id + emotion + text, then submits each line
 * to the configured TTS provider. Returns the list of generated audio
 * tracks and per-shot duration. Post-production stage will mux these
 * tracks with the corresponding video clips.
 *
 * Usage:
 *   aigc_voice_dub { script: "...", characters: [{name, voice_id, ...}], shots: [...] }
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { VoiceDirectorAgent } from '../agents/voice_director.js';
import type { AgentInput } from '../pipeline/base_agent.js';
import { createTtsProvider } from '../providers/audio/index.js';
import { loadConfig, getProviderConfig } from '../providers/config.js';

export const voiceDubTool = defineTool({
  name: 'aigc_voice_dub',
  description:
    'Generate per-shot voice tracks for a Chinese script using MiniMax Speech 2.8 (HD/Turbo). ' +
    'Reads characters (with voice_id assignments) + a storyboard of shots, then calls TTS ' +
    'for each line. Returns audio paths + durations for downstream muxing with video clips.',
  parameters: {
    session_id: {
      type: 'string',
      description: 'Optional session id; defaults to a random uuid.',
    },
    script: {
      type: 'string',
      required: true,
      description: 'Full script text the LLM uses to assign voices per line.',
    },
    characters: {
      type: 'array',
      required: true,
      description: 'Characters with optional voice_id. voice_id is a MiniMax voice id (system / cloned / designed).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          description: { type: 'string' },
          voice_id: { type: 'string', description: 'MiniMax voice id; default female-shaonv if omitted.' },
        },
      },
    },
    shots: {
      type: 'array',
      required: true,
      description: 'Storyboard shots (index/description/characters).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          description: { type: 'string' },
          characters: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    tts_provider: {
      type: 'string',
      description: 'Override the TTS provider alias (default: hailuo-tts / MiniMax).',
    },
    tts_model: {
      type: 'string',
      description: 'Override the TTS model id (e.g. speech-2.8-hd, speech-2.8-turbo, speech-2.6-hd).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              shot_index: { type: 'integer' },
              character: { type: 'string' },
              voice_id: { type: 'string' },
              emotion: { type: 'string' },
              text: { type: 'string' },
              audio_path: { type: 'string' },
            },
          },
        },
        errors: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: `[aigc_voice_dub]\n${JSON.stringify(value, null, 2)}` },
    ],
  },
  async execute(args, exec) {
    const cfg = loadConfig('config.yaml');
    const ttsAlias = args.tts_provider ?? cfg.pipeline.ttsProvider ?? 'hailuo-tts';
    const ttsCfg = getProviderConfig(cfg, ttsAlias);
    if (!ttsCfg) {
      throw new Error(`tts provider '${ttsAlias}' not configured in config.yaml`);
    }
    const tts = createTtsProvider(ttsAlias, ttsCfg);
    if (args.tts_model && ttsCfg.modelName !== args.tts_model) {
      // Allow per-call override by patching provider config (best-effort).
      (ttsCfg as { modelName?: string }).modelName = args.tts_model;
    }

    const llmAlias = cfg.pipeline.plannerModel || 'isigning-llm';
    const { createLLMProvider } = await import('../providers/llm/index.js');
    const llmCfg = getProviderConfig(cfg, llmAlias);
    const llm = llmCfg ? createLLMProvider(llmAlias, llmCfg) : undefined;

    const agent = new VoiceDirectorAgent({ llm, tts });
    const input: AgentInput = {
      session_id: args.session_id ?? `vd_${Date.now()}`,
      project_name: args.session_id ?? 'voice-dub',
      user_prompt: args.script,
      meta: {
        script_generation: { characters: args.characters },
        storyboard: { shots: args.shots },
      },
      is_final_attempt: true,
      signal: exec.signal,
    };
    const out = await agent.run(input);
    if (!out.completed) {
      throw new Error(`voice_dub: ${out.error ?? out.hint}`);
    }
    return {
      session_id: input.session_id,
      lines: (out.artifacts.voice_generation as { lines: Array<{ shot_index: number; character: string; voice_id: string; emotion?: string; text: string; audio_path?: string }> }).lines,
      errors: (out.artifacts.voice_generation as { errors: string[] }).errors,
    };
  },
});
