/**
 * Image provider stubs + Wan/J /Image concrete skeleton.
 *
 * Concrete providers (Wan/Jimeng/Seedream) are Phase 2 sub-tasks.
 * The base shape mirrors OpenAI image generation but most Chinese image
 * APIs (Wan, Jimeng, Seedream) have their own multipart / async-poll
 * shape, so concrete providers will extend this with their specific
 * protocol.
 */

import { BaseProvider } from '../base.js';
import type { ImageGenerationRequest, ImageProvider, ImageResult } from '../types.js';

export abstract class BaseImageProvider extends BaseProvider implements ImageProvider {
  abstract readonly providerName: string;
  abstract generate(req: ImageGenerationRequest): Promise<ImageResult>;
}

export class WanImageProvider extends BaseImageProvider {
  readonly providerName = 'wan';

  async generate(req: ImageGenerationRequest): Promise<ImageResult> {
    const { apiKey } = this.cfg;
    if (!apiKey) {
      throw new Error('WanImageProvider: DASHSCOPE_API_KEY is empty — set it in env or config.yaml');
    }
    const size = (req.width && req.height) ? `${req.width}*${req.height}` : '1024*1024';
    const n = req.n ?? 1;
    const model = req.model && req.model !== 'wan' ? req.model : (this.cfg.modelName || 'wanx-v1');

    // Step 1: submit async task
    const submitUrl = `${this.baseUrl}/services/aigc/text2image/image-synthesis/async-submit`;
    const submitBody = {
      model,
      input: { prompt: req.prompt },
      parameters: { size, n },
    };
    const submitResp = await this.http.request<{ output?: { task_id?: string }; code?: string; message?: string }>({
      method: 'POST',
      url: submitUrl,
      body: submitBody,
      timeoutMs: 30_000,
      signal: req.signal,
    });
    const taskId = submitResp.output?.task_id;
    if (!taskId) {
      throw new Error(`WanImageProvider: submit returned no task_id (code=${submitResp.code ?? '?'} msg=${submitResp.message ?? '?'})`);
    }

    // Step 2: poll task until SUCCEEDED
    const pollUrl = `${this.baseUrl}/tasks/${taskId}`;
    const POLL_INTERVAL = 3_000;
    const TIMEOUT = 5 * 60_000;
    const started = Date.now();
    type PollResult = {
      output?: {
        task_status?: string;
        task_results?: Array<{ url?: string; b64_image?: string; orig_prompt?: string }>;
      };
      code?: string;
      message?: string;
    };
    let pollResult: PollResult = {};
    while (true) {
      if (req.signal?.aborted) throw new Error('WanImageProvider: cancelled by caller');
      if (Date.now() - started > TIMEOUT) {
        throw new Error(`WanImageProvider: task ${taskId} timed out after ${TIMEOUT / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      pollResult = await this.http.request<PollResult>({
        method: 'GET',
        url: pollUrl,
        timeoutMs: 10_000,
        signal: req.signal,
      });
      const status = pollResult.output?.task_status;
      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED') {
        throw new Error(`WanImageProvider: task ${taskId} FAILED: ${pollResult.code ?? '?'} ${pollResult.message ?? '?'}`);
      }
      // PENDING / RUNNING → keep polling
    }

    // Step 3: collect image URLs
    const results = pollResult.output?.task_results ?? [];
    if (!results.length) {
      throw new Error(`WanImageProvider: task ${taskId} returned no results`);
    }
    const images: ImageResult['images'] = results
      .map((r: PollResult['output'] extends infer T ? (T extends { task_results?: Array<infer U> } ? U : never) : never) => {
        const img: { url: string; b64?: string; width?: number; height?: number } = {
          url: r.url ?? '',
        };
        if (r.b64_image) img.b64 = r.b64_image;
        if (req.width) img.width = req.width;
        if (req.height) img.height = req.height;
        return img;
      })
      .filter((i: { url: string; b64?: string }) => i.url || i.b64);
    if (!images.length) {
      throw new Error(`WanImageProvider: task ${taskId} results have no url/b64`);
    }
    return { images, model };
  }
}
export class JimengImageProvider extends BaseImageProvider {
  readonly providerName = 'jimeng';

  /**
   * Volcengine ARK API for ByteDance Jimeng (即梦) image generation.
   * Synchronous: one POST returns the image(s) in the response.
   *   POST {baseUrl}/api/v3/images/generations
   *     Authorization: Bearer {apiKey}
   *     body: { "model": "...", "prompt": "...", "size": "1024x1024",
   *             "response_format": "url" | "b64_json", "n": 1 }
   *   → { "created": ..., "data": [{ "url": "..." | "b64_json": "..." }] }
   */
  async generate(req: ImageGenerationRequest): Promise<ImageResult> {
    const { apiKey } = this.cfg;
    if (!apiKey) {
      throw new Error('JimengImageProvider: ARK API key is empty — set it via models.<alias>.api_key in config.yaml');
    }
    const model = req.model && req.model !== 'jimeng' ? req.model : (this.cfg.modelName || 'doubao-seedream-3-0-t2i-250415');
    const size = (req.width && req.height) ? `${req.width}x${req.height}` : '1024x1024';
    const n = req.n ?? 1;
    const url = `${this.baseUrl}/api/v3/images/generations`;
    const body: Record<string, unknown> = { model, prompt: req.prompt, size, n };
    // 豆包图像支持 url 或 b64_json
    body.response_format = 'url';
    const resp = await this.http.request<{
      created?: number;
      data?: Array<{ url?: string; b64_json?: string }>;
    }>({
      method: 'POST',
      url,
      body,
      timeoutMs: 120_000,
      signal: req.signal,
    });
    const data = resp.data ?? [];
    if (!data.length) throw new Error(`JimengImageProvider: empty data array (created=${resp.created ?? '?'})`);
    const images: ImageResult['images'] = data.map((d) => {
      const img: { url: string; b64?: string; width?: number; height?: number } = { url: d.url ?? '' };
      if (d.b64_json) img.b64 = d.b64_json;
      if (req.width) img.width = req.width;
      if (req.height) img.height = req.height;
      return img;
    }).filter((i) => i.url || i.b64);
    if (!images.length) throw new Error('JimengImageProvider: all data items lack url/b64_json');
    return { images, model };
  }
}
export class SeedreamImageProvider extends BaseImageProvider {
  readonly providerName = 'seedream';
  // Seedream and Jimeng share the Volcengine ARK /api/v3/images/generations
  // endpoint. Seedream is just a different model_id on the same backend.
  // We subclass JimengImageProvider and override the default model.
  async generate(req: ImageGenerationRequest): Promise<ImageResult> {
    const effective: ImageGenerationRequest = {
      ...req,
      model: req.model && req.model !== 'seedream' ? req.model : (this.cfg.modelName || 'doubao-seedream-3-0-t2i-250415'),
    };
    // Delegate to the Jimeng implementation by constructing one with the same
    // baseUrl / apiKey / modelName. This avoids duplicating ~40 lines of
    // HTTP + response handling.
    const inner = new JimengImageProvider({
      apiKey: this.cfg.apiKey,
      baseUrl: this.cfg.baseUrl,
      modelName: effective.model,
      concurrency: this.cfg.concurrency,
      mode: this.cfg.mode,
    });
    return inner.generate(effective);
  }
}

export function createImageProvider(alias: string, cfg: import('../config.js').ProviderConfig) {
  const a = alias.toLowerCase();
  if (a.includes('wan')) return new WanImageProvider(cfg);
  if (a.includes('jimeng')) return new JimengImageProvider(cfg);
  if (a.includes('seedream')) return new SeedreamImageProvider(cfg);
  throw new Error(`Unknown image provider alias: ${alias}`);
}