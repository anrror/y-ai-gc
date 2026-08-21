/**
 * WanImageProvider smoke test — mocks the DashScope async task flow
 * (submit → poll → SUCCEEDED) so we can verify generate() end-to-end
 * without a real DASHSCOPE_API_KEY.
 *
 * Run:  npx vitest run tests/wan_image.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WanImageProvider } from '../src/providers/image/index.js';

interface DashscopeTask {
  task_id: string;
  task_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  task_results?: Array<{ url?: string; b64_image?: string }>;
  code?: string;
  message?: string;
}

// 1x1 transparent PNG (base64). Tiny but valid.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let server: Server;
let baseUrl: string;
const tasks = new Map<string, DashscopeTask>();

beforeAll(async () => {
  tasks.clear();
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    // Async submit — task is already SUCCEEDED on the first poll so we
    // don't blow the 5s vitest default timeout (provider polls every 3s).
    if (req.method === 'POST' && url.startsWith('/api/v1/services/aigc/text2image/image-synthesis/async-submit')) {
      const task_id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tasks.set(task_id, {
        task_id,
        task_status: 'SUCCEEDED',
        task_results: [{ b64_image: TINY_PNG_B64 }],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: { task_id } }));
      return;
    }
    // Task poll
    const m = url.match(/^\/api\/v1\/tasks\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const id = m[1] as string;
      const t = tasks.get(id);
      if (!t) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'NotFound', message: `task ${id} not found` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: t }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
        resolve();
      } else {
        resolve();
      }
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('WanImageProvider (mocked DashScope)', { timeout: 15_000 }, () => {
  it('submits, polls, and returns an ImageResult with the b64 image', async () => {
    const provider = new WanImageProvider({
      apiKey: 'mock-key',
      baseUrl: baseUrl,
      modelName: 'wanx-v1',
      concurrency: 1,
    });
    const result = await provider.generate({
      prompt: 'a serene mountain landscape at dawn',
      model: 'wan',
      width: 1024,
      height: 1024,
    });
    expect(result.model).toBe('wanx-v1');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.b64).toBe(TINY_PNG_B64);
    expect(result.images[0]?.width).toBe(1024);
    expect(result.images[0]?.height).toBe(1024);
  });

  it('throws when apiKey is empty', async () => {
    const provider = new WanImageProvider({
      apiKey: '',
      baseUrl: baseUrl,
      modelName: 'wanx-v1',
      concurrency: 1,
    });
    await expect(
      provider.generate({ prompt: 'x', model: 'wan' }),
    ).rejects.toThrow(/DASHSCOPE_API_KEY is empty/);
  });

  it('uses model from request when provided (overrides modelName)', async () => {
    const provider = new WanImageProvider({
      apiKey: 'mock-key',
      baseUrl: baseUrl,
      modelName: 'wanx-v1',
      concurrency: 1,
    });
    const result = await provider.generate({ prompt: 'a cat', model: 'custom-model' });
    expect(result.model).toBe('custom-model');
  });
});