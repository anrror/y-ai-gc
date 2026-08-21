/**
 * JimengImageProvider smoke test — mocks Volcengine ARK synchronous
 * image generation so we can verify generate() end-to-end without a
 * real ARK API key.
 *
 * Run:  npx vitest run tests/jimeng_image.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { JimengImageProvider } from '../src/providers/image/index.js';

// 1x1 transparent PNG (base64). Tiny but valid.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/api/v3/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        created: Date.now(),
        data: [{ url: 'https://mock.test/result.png' }],
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NotFound', message: `unexpected path ${url}` }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        // baseUrl should NOT include /api/v3 — the provider appends it.
        baseUrl = `http://127.0.0.1:${addr.port}`;
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

describe('JimengImageProvider (mocked Volcengine ARK)', () => {
  it('POSTs to /api/v3/images/generations and returns an ImageResult', async () => {
    const provider = new JimengImageProvider({
      apiKey: 'mock-ark-key',
      // baseUrl must NOT include /api/v3 — the provider appends it.
      baseUrl: baseUrl,
      modelName: 'doubao-seedream-3-0-t2i-250415',
      concurrency: 1,
    });
    const result = await provider.generate({
      prompt: 'a serene mountain landscape',
      model: 'jimeng',
      width: 1024,
      height: 1024,
    });
    expect(result.model).toBe('doubao-seedream-3-0-t2i-250415');
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.url).toBe('https://mock.test/result.png');
    expect(result.images[0]?.width).toBe(1024);
    expect(result.images[0]?.height).toBe(1024);
  });

  it('throws when apiKey is empty', async () => {
    const provider = new JimengImageProvider({
      apiKey: '',
      baseUrl: baseUrl,
      modelName: 'doubao-seedream-3-0-t2i-250415',
      concurrency: 1,
    });
    await expect(
      provider.generate({ prompt: 'x', model: 'jimeng' }),
    ).rejects.toThrow(/ARK API key is empty/);
  });

  it('uses model from request when provided (overrides modelName)', async () => {
    const provider = new JimengImageProvider({
      apiKey: 'mock-ark-key',
      baseUrl: baseUrl,
      modelName: 'doubao-seedream-3-0-t2i-250415',
      concurrency: 1,
    });
    const result = await provider.generate({ prompt: 'a cat', model: 'custom-model' });
    expect(result.model).toBe('custom-model');
  });
});