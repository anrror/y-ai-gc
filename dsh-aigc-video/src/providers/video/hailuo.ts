/**
 * Hailuo (MiniMax) video generation provider.
 *
 * Implements BOTH API generations:
 *   - **v1** (`POST /v1/video_generation`): flat payload, 5 statuses
 *     (Preparing → Queueing → Processing → Success / Fail), Success includes
 *     `file_id`. Download via `GET /v1/files/retrieve?file_id=...` → 1h-TTL URL.
 *   - **v2 / H3** (`POST /v2/video_generation`): multimodal `content[]` array,
 *     6 statuses (queued → running → succeeded / failed / cancelled / expired),
 *     Success includes `content.url` directly.
 *
 * Models auto-detected from the model id:
 *   - `MiniMax-H3` → v2
 *   - `MiniMax-Hailuo-2.3` / `MiniMax-Hailuo-02` / `T2V-01*` / `MiniMax-Hailuo-2.3-Fast` → v1
 *
 * Verified end-to-end with the user's MiniMax Token Plan (China station).
 */

import { BaseProvider, ProviderError, ProviderHttpError } from '../base.js';
import type { ProviderConfig } from '../config.js';
import type { VideoProgress, VideoGenerationRequest, VideoResult } from '../types.js';

// ── v1 API contract ──────────────────────────────────────────────────────

interface V1SubmitReq {
  model: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  /** v1 ignores `ratio` when first_frame_image is set. */
  first_frame_image?: string;
  /** v1 ignores `ratio` when last_frame_image is set. */
  last_frame_image?: string;
}

interface V1SubmitResp {
  task_id: string;
  base_resp: { status_code: number; status_msg: string };
}

type V1Status = 'Preparing' | 'Queueing' | 'Processing' | 'Success' | 'Fail';

interface V1TaskResp {
  status: V1Status;
  file_id?: string;
  base_resp: { status_code: number; status_msg: string };
}

interface V1RetrieveResp {
  file: { download_url: string };
  base_resp: { status_code: number; status_msg: string };
}

// ── v2 API contract ──────────────────────────────────────────────────────

interface V2ContentItemText {
  type: 'text';
  text: string;
}
interface V2ContentItemImage {
  type: 'image_url';
  image_url: { url: string };
  role?: 'first_frame' | 'last_frame' | 'reference_image' | 'reference_video' | 'reference_audio';
}
type V2ContentItem = V2ContentItemText | V2ContentItemImage;

interface V2SubmitReq {
  model: string;
  content: V2ContentItem[];
  duration?: number;
  resolution?: string;
  /** For text-to-video ratio is required; for i2v it's ignored ( adaptive). */
  ratio?: string;
}

interface V2SubmitResp {
  task_id: string;
  base_resp: { status_code: number; status_msg: string };
}

type V2Status = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

interface V2TaskResp {
  status: V2Status;
  /** Populated only when status='succeeded'. */
  content?: { url?: string };
  error?: { code?: string; message?: string };
  base_resp?: { status_code: number; status_msg: string };
}

// ── Public provider ──────────────────────────────────────────────────────

export class HailuoVideoProvider extends BaseProvider {
  readonly providerName = 'hailuo';

  /** Decide v1 vs v2 from model name. */
  private isV2(model: string): boolean {
    return model.toLowerCase().includes('h3') || model.toLowerCase().endsWith('-h3');
  }

  async submit(req: VideoGenerationRequest): Promise<string> {
    // Submit using the version determined by the model id. Remember the
    // version so the next `poll()` defaults to the same endpoint.
    if (this.isV2(req.model)) {
      this._lastSubmittedVersion = 'v2';
      return this.submitV2(req);
    }
    this._lastSubmittedVersion = 'v1';
    return this.submitV1(req);
  }

  /**
   * Poll a task using whichever API version the most recent `submit()` used.
   * Signature matches `VideoProvider.poll` interface exactly.
   */
  async poll(taskId: string, _signal?: AbortSignal): Promise<VideoResult> {
    const useV2 = this._lastSubmittedVersion === 'v2';
    const result = useV2 ? await this.pollV2(taskId) : await this.pollV1(taskId);
    if (!result.apiVersion) result.apiVersion = useV2 ? 'v2' : 'v1';
    return result;
  }

  /** Track which version the most recent submit() used, so poll() can default. */
  private _lastSubmittedVersion: 'v1' | 'v2' | undefined;

  /** Public hooks for callers that know the version explicitly. */
  pollV1Only(taskId: string) {
    return this.pollV1(taskId);
  }
  pollV2Only(taskId: string) {
    return this.pollV2(taskId);
  }

  /** v1 implementation — flat payload, file_id workflow. */
  private async submitV1(req: VideoGenerationRequest): Promise<string> {
    const body: V1SubmitReq = {
      model: req.model,
      prompt: req.prompt,
      duration: req.duration,
      resolution: req.resolution,
    };
    if (req.firstFrameImageUrl) body.first_frame_image = req.firstFrameImageUrl;
    if (req.lastFrameImageUrl) body.last_frame_image = req.lastFrameImageUrl;
    // v1 expects ratio only when t2v; when first_frame_image is present ratio
    // is forced to `adaptive` server-side. We omit it to stay portable.
    const url = `${this.baseUrl}/v1/video_generation`;
    const resp = await this.http.request<V1SubmitResp>({ method: 'POST', url, body });
    this.checkBaseResp(resp.base_resp, 'v1 submit');
    if (!resp.task_id) throw new Error('Hailuo v1: no response.task_id');
    return resp.task_id;
  }

  private async pollV1(taskId: string): Promise<VideoResult> {
    const url = `${this.baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`;
    const resp = await this.http.request<V1TaskResp>({ method: 'GET', url });
    this.checkBaseResp(resp.base_resp, 'v1 poll');
    if (resp.status === 'Success' && resp.file_id) {
      const videoUrl = await this.retrieveFile(resp.file_id);
      return { taskId, status: 'succeeded', videoUrl };
    }
    if (resp.status === 'Fail') return { taskId, status: 'failed', error: 'v1 task failed' };
    return { taskId, status: resp.status };
  }

  private async retrieveFile(fileId: string): Promise<string> {
    const url = `${this.baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`;
    const resp = await this.http.request<V1RetrieveResp>({ method: 'GET', url });
    this.checkBaseResp(resp.base_resp, 'v1 files/retrieve');
    const downloadUrl = resp.file?.download_url;
    if (!downloadUrl) throw new Error('Hailuo v1: files/retrieve returned no download_url');
    return downloadUrl;
  }

  /** v2 implementation — content[] payload, direct URL on success. */
  private async submitV2(req: VideoGenerationRequest): Promise<string> {
    const content: V2ContentItem[] = [{ type: 'text', text: req.prompt }];
    if (req.firstFrameImageUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: req.firstFrameImageUrl },
        role: 'first_frame',
      });
    }
    if (req.lastFrameImageUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: req.lastFrameImageUrl },
        role: 'last_frame',
      });
    }
    // Subject-consistency reference images (Hailuo v2 supports `reference_image`
    // role). Attach each as a separate item; Hailuo applies them as character/
    // scene anchors. Dedupe against first/last frame URLs to avoid duplicates.
    const frameUrls = new Set([
      req.firstFrameImageUrl,
      req.lastFrameImageUrl,
    ].filter((u): u is string => Boolean(u)));
    for (const refUrl of req.referenceImages ?? []) {
      if (!refUrl || frameUrls.has(refUrl)) continue;
      content.push({
        type: 'image_url',
        image_url: { url: refUrl },
        role: 'reference_image',
      });
    }
    const body: V2SubmitReq = {
      model: req.model,
      content,
      duration: req.duration,
      resolution: req.resolution,
    };
    // For t2v, ratio is required and may not be `adaptive`.
    if (!req.firstFrameImageUrl && req.ratio) body.ratio = req.ratio;
    const url = `${this.baseUrl}/v2/video_generation`;
    const resp = await this.http.request<V2SubmitResp>({ method: 'POST', url, body });
    this.checkBaseResp(resp.base_resp, 'v2 submit');
    if (!resp.task_id) throw new Error('Hailuo v2: no response.task_id');
    return resp.task_id;
  }

  private async pollV2(taskId: string): Promise<VideoResult> {
    const url = `${this.baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`;
    const resp = await this.http.request<V2TaskResp>({ method: 'GET', url });
    if (resp.base_resp) this.checkBaseResp(resp.base_resp, 'v2 poll');
    if (resp.status === 'succeeded') {
      const videoUrl = resp.content?.url;
      if (!videoUrl) throw new Error('Hailuo v2: succeeded but no content.url');
      return { taskId, status: 'succeeded', videoUrl };
    }
    if (resp.status === 'failed' || resp.status === 'cancelled' || resp.status === 'expired') {
      return {
        taskId,
        status: resp.status,
        error: resp.error?.message ?? `${resp.status}`,
      };
    }
    return { taskId, status: resp.status };
  }

  /** Provider error envelope — `base_resp.status_code === 0` means success. */
  private checkBaseResp(
    base: { status_code: number; status_msg: string },
    ctx: string,
  ): void {
    if (!base || base.status_code !== 0) {
      const msg = base?.status_msg ?? 'unknown error';
      const code = base?.status_code ?? -1;
      // P0-2: convert raw envelope into a typed ProviderError. 2056 = quota
      // exhausted (Token Plan Max hard-stop); 1002/1004/1008 = auth/account
      // issues (non-retriable). Everything else falls through to a generic
      // bad_request with the original code so retries are decided by retry
      // helper, not here.
      const fakeHttp = new ProviderHttpError(200, `Hailuo ${ctx} failed: ${msg}`, code, msg);
      throw ProviderError.fromHttp(fakeHttp);
    }
  }

  /** Convenience: poll-with-progress for callers that want it. */
  async *pollStream(taskId: string, intervalMs = 10_000): AsyncIterable<VideoProgress> {
    const started = Date.now();
    while (true) {
      const result = await this.poll(taskId);
      yield {
        status: result.status,
        elapsedSec: (Date.now() - started) / 1000,
        message: result.error,
      };
      if (
        result.status === 'succeeded' ||
        result.status === 'failed' ||
        result.status === 'cancelled' ||
        result.status === 'expired'
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Download the generated MP4 to a local file. */
  async download(url: string, destAbsPath: string, signal?: AbortSignal): Promise<string> {
    return this.http.download(url, destAbsPath, signal);
  }
}