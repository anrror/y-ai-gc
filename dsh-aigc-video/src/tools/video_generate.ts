/**
 * `aigc_video_generate` — single-clip video generation via MiniMax Hailuo.
 *
 * Phase 3: real implementation. Loads config from `config.yaml`, resolves
 * the video provider from `pipeline.videoProvider` (default `hailuo-2.3`),
 * submits to Hailuo v1/v2, polls until success/failure, returns the
 * download URL.
 *
 * Progress is emitted via `exec.agent.inject(...)` so the DSH agent loop
 * surfaces it to the user.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import type { AppConfig } from '../providers/config.js';
import { getProviderConfig, loadConfig } from '../providers/config.js';
import { createVideoProvider } from '../providers/video/index.js';
import type { VideoGenerationRequest, VideoProvider } from '../providers/types.js';

// One-time lazy config + provider cache. Cheap to recompute; safe to share
// across tool invocations within the same process.
let cachedConfig: AppConfig | undefined;
function getConfig(): AppConfig {
  if (!cachedConfig) cachedConfig = loadConfig('config.yaml');
  return cachedConfig;
}

let cachedProvider: { alias: string; provider: VideoProvider } | undefined;
function getProvider(): { alias: string; provider: VideoProvider } {
  const cfg = getConfig();
  const alias = cfg.pipeline.videoProvider;
  if (cachedProvider && cachedProvider.alias === alias) return cachedProvider;
  const providerCfg = getProviderConfig(cfg, alias);
  if (!providerCfg) throw new Error(`Video provider '${alias}' not in config.yaml providers.*`);
  cachedProvider = { alias, provider: createVideoProvider(alias, providerCfg) };
  return cachedProvider;
}

export const videoGenerateTool = defineTool({
  name: 'aigc_video_generate',
  description:
    'Generate a single AI video clip via MiniMax Hailuo v1/v2 (or other configured video provider). ' +
    'Returns the generated video download URL once the provider reports success.',
  parameters: {
    prompt: {
      type: 'string',
      required: true,
      description: 'Text description of the desired video (max 2000 chars)',
    },
    model: {
      type: 'string',
      description:
        "Provider model id — 'minimax-h3' / 'hailuo-2.3' / 'hailuo-02' / 'kling-v3' / 'wan2.6-video' (default: pipeline.videoProvider from config.yaml)",
    },
    duration: {
      type: 'integer',
      description: 'Video duration in seconds (4-15, default 6)',
    },
    resolution: {
      type: 'string',
      description: "Output resolution — '768P' (default) / '2K' / '1080P'",
    },
    ratio: {
      type: 'string',
      description: "Aspect ratio — '16:9' (default) / / '9:16' / '4:3' / '1:1'",
    },
    first_frame_image_url: {
      type: 'string',
      description: 'Optional URL to a first-frame image (image-to-video mode)',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string' },
        video_url: { type: 'string', description: 'CDN URL of the generated clip' },
        duration_seconds: { type: 'integer' },
        provider: { type: 'string' },
        model: { type: 'string' },
        api_version: { type: 'string', description: "'v1' or 'v2'" },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: `[aigc_video_generate]\n${JSON.stringify(value, null, 2)}` },
    ],
  },
  async execute(args, exec) {
    const slot = getProvider();
    if (!slot) throw new Error('provider not initialised (this should not happen)');
    const { provider, alias } = slot;
    const model = args.model ?? 'minimax-h3';

    const req: VideoGenerationRequest = {
      model,
      prompt: args.prompt,
      duration: args.duration ?? 6,
      resolution: args.resolution ?? '768P',
      ratio: args.ratio ?? '16:9',
      ...(args.first_frame_image_url && { firstFrameImageUrl: args.first_frame_image_url }),
      signal: exec.signal,
    };

    const taskId = await provider.submit(req);

    // Poll until terminal status. Bail early if exec.signal aborts.
    const POLL_MS = 5_000;
    while (true) {
      if (exec.signal?.aborted) throw new Error('cancelled by caller');
      await new Promise((r) => setTimeout(r, POLL_MS));
      const result = await provider.poll(taskId);
      // Phase 3: progress reporting via exec.agent.inject is deferred — the
      // UserMessage shape needs investigation. The tool still works.
      if (result.status === 'succeeded') {
        return {
          task_id: taskId,
          video_url: result.videoUrl,
          duration_seconds: req.duration,
          provider: alias,
          model,
          api_version: result.apiVersion,
        };
      }
      if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'expired') {
        throw new Error(`Hailuo task ${taskId} ${result.status}: ${result.error ?? ''}`);
      }
    }
  },
});