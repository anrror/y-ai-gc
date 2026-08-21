// Phase 2 smoke test — Hailuo v1 + v2 end-to-end against the real MiniMax API.
//
// Reads MINIMAX_API_KEY from backend/.env (the user's Subscription Key for
// Token Plan Max). Consumes 2 of the 3 daily video generations on success.
//
// Run:  node smoke.mjs
// or:    node --env-file=../aigc-claw/backend/.env smoke.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Read .env from backend (Subscription Key is there) ──────────────────
const
__filename = fileURLToPath(import.meta.url);
const here = dirname(__filename);
const envPath = resolve(here, '..', 'aigc-claw', 'backend', '.env');
try {
  const text = readFileSync(envPath, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim();
    }
  }
  console.log(`[smoke] loaded ${envPath}`);
} catch (e) {
  console.warn(`[smoke] could not load .env (${e.message}); relying on env vars`);
}

if (!process.env.MINIMAX_API_KEY) {
  console.error('MINIMAX_API_KEY not set; aborting');
  process.exit(1);
}

// ── Import compiled plugin ───────────────────────────────────────────────
const { HailuoVideoProvider } = await import('./dist/providers/video/hailuo.js');

const cfg = {
  apiKey: process.env.MINIMAX_API_KEY,
  baseUrl: 'https://api.minimaxi.com',
  modelName: 'MiniMax-Hailuo-2.3',
  concurrency: 2,
};

async function testV1(provider, label) {
  console.log(`\n=== ${label} ===`);
  const started = Date.now();
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] submitting t2v…`);
  const taskId = await provider.submit({
    model: 'MiniMax-Hailuo-2.3',
    prompt: 'A red sports car driving fast through a rain-soaked neon city street at night, cinematic, lens flare',
    duration: 6,
    resolution: '768P',
    ratio: '16:9',
  });
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] task_id=${taskId}`);

  // Poll until done.
  while (true) {
    await new Promise(r => setTimeout(r, 5_000));
    const result = await provider.poll(taskId);
    console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] status=${result.status}${result.error ? ' error=' + result.error : ''}`);
    if (result.status === 'succeeded') {
      console.log(`\n${label} SUCCESS in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(`video_url=${result.videoUrl}`);
      return true;
    }
    if (['failed', 'cancelled', 'expired'].includes(result.status)) {
      console.log(`\n${label} FAILED (${result.status})`);
      return false;
    }
  }
}

const provider = new HailuoVideoProvider(cfg);
const v1ok = await testV1(provider, 'Hailuo v1 (MiniMax-Hailuo-2.3)');
process.exit(v1ok ? 0 : 1);