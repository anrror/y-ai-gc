/**
 * aigc_video_generate tool smoke test — mocks fetch to verify the
 * tool's submit → poll → return dance without a real Hailuo key.
 *
 * Approach: a single URL-routed mock that returns the right response
 * for each endpoint, regardless of call order. The poll loop returns
 * SUCCEEDED on the very first poll so the tool doesn't burn 5s × N polls.
 * We speed up polling by monkey-patching setTimeout to 0 ms.
 *
 * Run:  npx vitest run tests/video_generate.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { videoGenerateTool } from '../src/tools/video_generate.js';

let originalFetch: typeof globalThis.fetch;
let realSetTimeout: typeof globalThis.setTimeout;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  realSetTimeout = globalThis.setTimeout;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = realSetTimeout;
  vi.unstubAllGlobals();
});

/** Build a URL-routed mock. Each branch matches by `endsWith` or `includes`. */
function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const [pattern, resp] of Object.entries(routes)) {
      if (u.endsWith(pattern) || u.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`mockFetch: no route matched for ${u}`);
  }) as typeof globalThis.fetch;
}

describe('aigc_video_generate (mocked Hailuo)', { timeout: 15_000 }, () => {
  it('v1: submits, polls (Success immediately), retrieves download_url', async () => {
    mockFetch({
      '/v1/video_generation': { body: { task_id: 'task-001', base_resp: { status_code: 0, status_msg: 'ok' } } },
      '/v1/query/video_generation': { body: { status: 'Success', file_id: 'file-001', base_resp: { status_code: 0, status_msg: 'ok' } } },
      '/v1/files/retrieve': { body: { file: { download_url: 'https://mock.test/v1.mp4' }, base_resp: { status_code: 0, status_msg: 'ok' } } },
    });
    // Speed up polling: collapse the 5s setTimeout to 0ms.
    globalThis.setTimeout = ((cb: () => void, _ms?: number) => realSetTimeout(cb, 0)) as typeof globalThis.setTimeout;

    const result = await videoGenerateTool.execute(
      { prompt: 'a cat playing piano', model: 'MiniMax-Hailuo-2.3', duration: 4, resolution: '768P', ratio: '16:9' },
      { signal: undefined } as never,
    );
    expect(result).toEqual({
      task_id: 'task-001',
      video_url: 'https://mock.test/v1.mp4',
      duration_seconds: 4,
      // The actual provider name comes from the loaded config.yaml's
      // pipeline.videoProvider alias (default "minimax-h3"). The tool
      // does not mutate it; it just reports what's in the registry.
      provider: 'minimax-h3',
      model: 'MiniMax-Hailuo-2.3',
      api_version: 'v1',
    });
  });

  it('v2: submits, polls (succeeded immediately with content.url)', async () => {
    mockFetch({
      '/v2/video_generation': { body: { task_id: 'task-v2', base_resp: { status_code: 0, status_msg: 'ok' } } },
      '/v2/query/video_generation': { body: { status: 'succeeded', content: { url: 'https://mock.test/v2.mp4' }, base_resp: { status_code: 0, status_msg: 'ok' } } },
    });
    globalThis.setTimeout = ((cb: () => void, _ms?: number) => realSetTimeout(cb, 0)) as typeof globalThis.setTimeout;

    const result = await videoGenerateTool.execute(
      { prompt: 'a city at night', model: 'MiniMax-H3', duration: 6, resolution: '2K', ratio: '16:9' },
      { signal: undefined } as never,
    );
    expect(result).toEqual({
      task_id: 'task-v2',
      video_url: 'https://mock.test/v2.mp4',
      duration_seconds: 6,
      provider: 'minimax-h3',
      model: 'MiniMax-H3',
      api_version: 'v2',
    });
  });
});