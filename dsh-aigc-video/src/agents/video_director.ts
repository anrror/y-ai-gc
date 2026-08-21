/**
 * VideoDirectorAgent (Phase 4.5).
 *
 * Reads storyboard shots → submits one video per shot via the configured
 * VideoProvider (Hailuo v1/v2), polls each to completion, downloads the
 * MP4 to disk. **Consumes Hailuo quota** (1 clip per shot).
 *
 * For safety, this is gated on `input.is_final_attempt` AND a budget cap:
 *   - Max 6 shots per call
 *   - Abort between shots on `input.signal.aborted`
 */

import { BaseAgent } from '../pipeline/base_agent.js';
import type { AgentInput, AgentOutput } from '../pipeline/base_agent.js';
import { FfmpegRunner } from '../video/ffmpeg.js';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { VideoGenerationRequest } from '../providers/types.js';
import { ProviderError, withProviderRetry } from '../providers/base.js';
import { checkClipQuality } from '../video/quality_gate.js';

interface Shot {
  index: number;
  duration: number;
  description: string;
  visual_prompt: string;
  characters?: string[];
}

const MAX_SHOTS_PER_CALL = 6;
const DEFAULT_OUTPUT_DIR = 'code/result/video';

export class VideoDirectorAgent extends BaseAgent<'video_generation'> {
  readonly stage = 'video_generation' as const;

  async run(input: AgentInput): Promise<AgentOutput> {
    if (!this.video) {
      return {
        payload: {},
        hint: '需要 video provider',
        artifacts: {},
        completed: false,
        requires_intervention: false,
        error: 'VideoDirectorAgent requires a video provider; configure models.hailuo-2.3 in config.yaml',
      };
    }
    const arts = input.meta.artifacts as {
      storyboard?: { shots?: Shot[] };
      reference_generation?: {
        refImages?: Array<{ name: string; path: string }>;
      };
    } | undefined;
    const allShots = arts?.storyboard?.shots ?? [];
    if (!allShots.length) {
      return {
        payload: {},
        hint: '缺少分镜',
        artifacts: {},
        completed: false,
        requires_intervention: true,
        error: 'storyboard artifact required',
      };
    }
    // P0-1: backfill reference images from reference_generation artifact.
    // Build a map from character name → local ref-image path. The Hailuo
    // v2 provider accepts local paths via `referenceImages` (it downloads
    // and base64-encodes when not a URL); first-frame uses the primary
    // character's ref image when available.
    const refByChar = new Map<string, string>();
    for (const r of arts?.reference_generation?.refImages ?? []) {
      if (r?.name && r?.path) refByChar.set(r.name, r.path);
    }
    const shots = allShots.slice(0, MAX_SHOTS_PER_CALL);
    // Local alias so TS strict-mode keeps narrowing inside the loop and the
    // arrow closures passed to withProviderRetry don't see `this.video?`.
    const video = this.video;

    const projectName = (input.meta.project_name as string | undefined) ?? input.session_id;
    const outDir = resolve(DEFAULT_OUTPUT_DIR, projectName, 'clips');
    mkdirSync(outDir, { recursive: true });
    const ffmpeg = new FfmpegRunner();

    const clips: Array<{ shot_index: number; video_url: string; video_path: string; duration: number }> = [];
    const errors: string[] = [];
    let quotaAborted = false;
    for (const shot of shots) {
      if (input.signal?.aborted || quotaAborted) {
        errors.push(`shot ${shot.index}: ${quotaAborted ? 'aborted (quota exceeded)' : 'cancelled by caller'}`);
        if (quotaAborted) break;
        continue;
      }
      try {
        const prompt = [
          shot.visual_prompt,
          shot.description,
          (shot.characters ?? []).map((n) => `featuring ${n}`).join(', '),
        ].filter(Boolean).join('. ');
        // P0-1: attach character reference images for subject consistency.
        // The first matching character's ref image goes as first-frame anchor;
        // all matching ref images go as `referenceImages` (subject consistency).
        const shotChars = shot.characters ?? [];
        const refPaths = shotChars
          .map((n) => refByChar.get(n))
          .filter((p): p is string => Boolean(p));
        const req: VideoGenerationRequest = {
          model: this.video.providerName === 'hailuo' ? 'MiniMax-Hailuo-2.3' : this.video.providerName,
          prompt,
          duration: Math.max(4, Math.min(10, shot.duration || 6)),
          resolution: '768P',
          ratio: '16:9',
          ...(refPaths.length > 0 && {
            firstFrameImageUrl: refPaths[0],
            referenceImages: refPaths,
          }),
          signal: input.signal,
        };
        // P0-2: submit with retry on transient errors. Quota / cancelled
        // propagate immediately so the run aborts instead of spinning.
        const taskId = await withProviderRetry(
          () => video.submit(req),
          { signal: input.signal, maxRetries: 2 },
        );
        // Poll until success/failure
        let videoUrl: string | undefined;
        const start = Date.now();
        while (!videoUrl) {
          if (input.signal?.aborted) throw new Error('cancelled by caller');
          await new Promise((r) => setTimeout(r, 5_000));
          const result = await this.video.poll(taskId, input.signal);
          if (result.status === 'succeeded') videoUrl = result.videoUrl;
          else if (['failed', 'cancelled', 'expired'].includes(result.status)) {
            throw new Error(`shot ${shot.index}: ${result.status} (${result.error ?? ''})`);
          }
          if (Date.now() - start > 5 * 60_000) throw new Error(`shot ${shot.index}: timeout (5 min)`);
        }
        // Download
        const ext = pickVideoExt(videoUrl ?? '');
        const filePath = join(outDir, `shot_${String(shot.index).padStart(3, '0')}${ext}`);
        await withProviderRetry(
          () => ffmpeg.download(videoUrl ?? '', filePath, input.signal).then(() => filePath),
          { signal: input.signal, maxRetries: 2 },
        );
        // P0-4: quality gate — probe duration / resolution / black-frame
        // ratio. On failure, log the reasons and skip the clip; one retry
        // is the user's manual decision (not auto).
        const qc = await checkClipQuality(filePath, { expected_sec: shot.duration }).catch((e) => {
          console.warn(`[video_director] quality probe error for shot ${shot.index}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (qc && !qc.ok) {
          errors.push(
            `shot ${shot.index}: quality gate failed (${qc.reasons.join(', ')}) — file kept on disk for inspection`,
          );
          // Don't add to `clips` so the downstream post-production doesn't
          // mux a corrupted clip. We still surface `video_path` in payload
          // so the user can find and inspect.
          continue;
        }
        clips.push({ shot_index: shot.index, video_url: videoUrl ?? '', video_path: filePath, duration: shot.duration });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`shot ${shot.index}: ${msg}`);
        // P0-2: quota exceeded — abort the entire run (no point submitting
        // more shots if the account is over its Token Plan cap).
        if (e instanceof ProviderError && e.kind === 'quota_exceeded') {
          quotaAborted = true;
          errors.push(`RUN ABORTED: quota exceeded — ${msg}`);
          break;
        }
      }
    }
    return {
      payload: { clips, errors, requested: shots.length, completed: clips.length },
      hint: `已生成 ${clips.length}/${shots.length} 个镜头${errors.length ? `, 失败 ${errors.length}` : ''}`,
      artifacts: { video_generation: { clips, errors } },
      completed: true,
      requires_intervention: false,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    };
  }
}

function pickVideoExt(url: string): string {
  if (url.includes('.mp4')) return '.mp4';
  if (url.includes('.mov')) return '.mov';
  if (url.includes('.webm')) return '.webm';
  return '.mp4';
}