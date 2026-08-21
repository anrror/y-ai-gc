/**
 * `aigc_pipeline_run` — end-to-end 6-stage AIGC pipeline.
 *
 * Phase 4.5: real wiring to PipelineOrchestrator. All 6 agents
 * (script_writer, character_designer, storyboard, reference_generator,
 * video_director, editor) are registered via `registerAllAgents`.
 * Stages whose required provider is missing (e.g. no `video` provider)
 * are simply skipped — the pipeline completes what it can.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { loadConfig, getProviderConfig } from '../providers/config.js';
import { createTtsProvider } from '../providers/audio/index.js';
import { createImageProvider } from '../providers/image/index.js';
import { createLLMProvider } from '../providers/llm/index.js';
import { createVideoProvider } from '../providers/video/index.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { SessionManager } from '../pipeline/session.js';
import { STAGES } from '../pipeline/types.js';

let cachedOrch: PipelineOrchestrator | undefined;

function getOrchestrator(): PipelineOrchestrator {
  if (cachedOrch) return cachedOrch;
  const cfg = loadConfig('config.yaml');
  const sessionMgr = SessionManager.fromDataDir(cfg.session.dataDir);

  // Resolve each provider from config.yaml. Missing providers just mean
  // the matching stages will be skipped during runAll().
  const llmAlias = cfg.pipeline.plannerModel || 'isigning-llm';
  const llmCfg = getProviderConfig(cfg, llmAlias);
  const llmProvider = llmCfg
    ? createLLMProvider(llmAlias, llmCfg)
    : undefined;

  const imageAlias = 'wan';
  const imageCfg = getProviderConfig(cfg, imageAlias);
  const imageProvider = imageCfg && imageCfg.baseUrl ? createImageProvider(imageAlias, imageCfg) : undefined;

  const videoAlias = cfg.pipeline.videoProvider;
  const videoCfg = getProviderConfig(cfg, videoAlias);
  const videoProvider = videoCfg && videoCfg.baseUrl ? createVideoProvider(videoAlias, videoCfg) : undefined;

  const ttsAlias = cfg.pipeline.ttsProvider ?? 'hailuo-tts';
  const ttsCfg = getProviderConfig(cfg, ttsAlias);
  const ttsProvider = ttsCfg ? createTtsProvider(ttsAlias, ttsCfg) : undefined;

  const orch = new PipelineOrchestrator(cfg, sessionMgr);
  orch.registerAllAgents({ llm: llmProvider, image: imageProvider, video: videoProvider, tts: ttsProvider });
  cachedOrch = orch;
  return orch;
}

export const pipelineTool = defineTool({
  name: 'aigc_pipeline_run',
  description:
    'Run the full 7-stage AIGC pipeline (script → character → storyboard → reference → ' +
    'video → voice → edit) from a user idea. Pauses at each of the 9 intervention points; returns ' +
    'artifacts + final video URL when complete.',
  parameters: {
    idea: {
      type: 'string',
      required: true,
      description: 'User-provided creative brief',
    },
    story_style: {
      type: 'string',
      description: 'Optional visual style hint (e.g. "cinematic", "anime")',
    },
    models: {
      type: 'object',
      additionalProperties: false,
      description: 'Override per-stage provider/model. Falls back to bundle config.',
      properties: {
        llm: { type: 'string' },
        image: { type: 'string' },
        video: { type: 'string' },
        vlm: { type: 'string' },
      },
    },
    dry_run: {
      type: 'boolean',
      description: 'If true, return the stage list without executing (default false)',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string' },
        final_video_url: { type: 'string' },
        stages_completed: { type: 'array', items: { type: 'string' } },
        artifacts: { type: 'object', additionalProperties: true },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: `[aigc_pipeline_run]\n${JSON.stringify(value, null, 2)}` },
    ],
  },
  async execute(args, exec) {
    if (args.dry_run) {
      return {
        session_id: '',
        final_video_url: '',
        stages_completed: [...STAGES],
        artifacts: {},
        _note: 'Phase 4.5 dry-run: enumerated all 6 stages. Real run requires providers in config.yaml.',
      };
    }

    const orch = getOrchestrator();
    const sessionMgr = orch.getSessionManager();
    const state = sessionMgr.create({ story: args.idea, story_style: args.story_style ?? '' });
    orch.loadSession(state.session_id);

    // Run stage-by-stage. Bail if a stage fails or no agent is registered.
    for (const stage of STAGES) {
      if (exec.signal?.aborted) throw new Error('cancelled by caller');
      try {
        const out = await orch.runStage(state.session_id, stage);
        if (!out.completed) break;
        orch.continueSession(state.session_id);
      } catch {
        break;
      }
    }

    const final = sessionMgr.get(state.session_id);
    const lastArtifact = final.artifacts.video_generation as { output?: { video_url?: string } } | undefined;
    return {
      session_id: final.session_id,
      final_video_url: lastArtifact?.output?.video_url ?? '',
      stages_completed: final.completed_stages,
      artifacts: final.artifacts as unknown as Record<string, never>,
    };
  },
});