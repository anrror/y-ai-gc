/**
 * Tests for `src/providers/router.ts` — the multi-provider router.
 *
 * Three strategies are exercised:
 *   - 'priority'        — fall back on quota
 *   - 'round-robin'     — distribute load
 *   - 'first-success'   — race all, take the winner
 *
 * Plus: poll() routing, attempt log, recoverable-error classification,
 * and reset() semantics.
 */

import { describe, expect, it } from 'vitest';

import { ProviderRouter } from '../src/providers/router.js';
import type { VideoGenerationRequest, VideoProvider, VideoResult } from '../src/providers/types.js';
import { ProviderError } from '../src/providers/base.js';

// ── helpers ────────────────────────────────────────────────────────────────

class StubProvider implements VideoProvider {
  public readonly submits: VideoGenerationRequest[] = [];
  public readonly polls: string[] = [];
  constructor(
    readonly providerName: string,
    private readonly opts: {
      submitResult?: (req: VideoGenerationRequest) => Promise<string>;
      pollResult?: (taskId: string) => Promise<VideoResult>;
    } = {},
  ) {}
  async submit(req: VideoGenerationRequest): Promise<string> {
    this.submits.push(req);
    if (this.opts.submitResult) return this.opts.submitResult(req);
    return `${this.providerName}-task-${this.submits.length}`;
  }
  async poll(taskId: string): Promise<VideoResult> {
    this.polls.push(taskId);
    if (this.opts.pollResult) return this.opts.pollResult(taskId);
    return { taskId, status: 'succeeded', videoUrl: `https://${this.providerName}.example/${taskId}.mp4` };
  }
}

const SAMPLE_REQ: VideoGenerationRequest = {
  model: 'MiniMax-Hailuo-2.3',
  prompt: 'test',
  duration: 6,
  resolution: '768P',
  ratio: '16:9',
};

// ── tests ─────────────────────────────────────────────────────────────────

describe('ProviderRouter — priority strategy', () => {
  it('first provider succeeds → no fallback', async () => {
    const hailuo = new StubProvider('hailuo');
    const kling = new StubProvider('kling');
    const router = new ProviderRouter({ providers: [hailuo, kling], strategy: 'priority' });

    const taskId = await router.submit(SAMPLE_REQ);
    expect(taskId).toMatch(/^hailuo:/);
    expect(hailuo.submits).toHaveLength(1);
    expect(kling.submits).toHaveLength(0);

    const log = router.getAttemptLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ provider: 'hailuo', ok: true });
  });

  it('falls back to second provider on quota_exceeded', async () => {
    const hailuo = new StubProvider('hailuo', {
      submitResult: async () => {
        throw new ProviderError('quota_exceeded', 'token plan max');
      },
    });
    const kling = new StubProvider('kling');
    const router = new ProviderRouter({ providers: [hailuo, kling], strategy: 'priority' });

    const taskId = await router.submit(SAMPLE_REQ);
    expect(taskId).toMatch(/^kling:/);
    expect(hailuo.submits).toHaveLength(1);
    expect(kling.submits).toHaveLength(1);

    const log = router.getAttemptLog();
    expect(log.map((l) => l.provider)).toEqual(['hailuo', 'kling']);
    expect(log[0]).toMatchObject({ ok: false });
    expect(log[1]).toMatchObject({ ok: true });
  });

  it('throws aggregated error when all providers fail', async () => {
    const fail1 = new StubProvider('fail1', {
      submitResult: async () => { throw new ProviderError('quota_exceeded', 'no quota 1'); },
    });
    const fail2 = new StubProvider('fail2', {
      submitResult: async () => { throw new ProviderError('quota_exceeded', 'no quota 2'); },
    });
    const router = new ProviderRouter({ providers: [fail1, fail2], strategy: 'priority' });

    await expect(router.submit(SAMPLE_REQ)).rejects.toThrow(/all 2 provider\(s\) exhausted/);
  });

  it('aborts immediately on non-recoverable error (bad_request)', async () => {
    const fail = new StubProvider('fail', {
      submitResult: async () => { throw new ProviderError('bad_request', 'invalid prompt'); },
    });
    const unreachable = new StubProvider('kling'); // would succeed if reached
    const router = new ProviderRouter({ providers: [fail, unreachable], strategy: 'priority' });

    await expect(router.submit(SAMPLE_REQ)).rejects.toThrow(/invalid prompt/);
    expect(unreachable.submits).toHaveLength(0); // never tried
  });
});

describe('ProviderRouter — round-robin strategy', () => {
  it('rotates starting position across consecutive calls', async () => {
    const a = new StubProvider('a');
    const b = new StubProvider('b');
    const c = new StubProvider('c');
    const router = new ProviderRouter({ providers: [a, b, c], strategy: 'round-robin' });

    const id1 = await router.submit(SAMPLE_REQ);
    const id2 = await router.submit(SAMPLE_REQ);
    const id3 = await router.submit(SAMPLE_REQ);
    const id4 = await router.submit(SAMPLE_REQ);
    expect([id1, id2, id3, id4]).toEqual([
      expect.stringMatching(/^a:/),
      expect.stringMatching(/^b:/),
      expect.stringMatching(/^c:/),
      expect.stringMatching(/^a:/), // wraps around
    ]);
  });
});

describe('ProviderRouter — first-success strategy', () => {
  it('returns the first successful submit (whichever resolves first)', async () => {
    // hailuo is slow (50ms), kling is fast (5ms) — kling should win.
    const hailuo = new StubProvider('hailuo', {
      submitResult: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return 'hailuo-slow-task';
      },
    });
    const kling = new StubProvider('kling', {
      submitResult: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'kling-fast-task';
      },
    });
    const router = new ProviderRouter({
      providers: [hailuo, kling],
      strategy: 'first-success',
    });

    const taskId = await router.submit(SAMPLE_REQ);
    expect(taskId).toMatch(/^kling:/);
    // Both providers were called (race) — both submit histories exist.
    expect(hailuo.submits).toHaveLength(1);
    expect(kling.submits).toHaveLength(1);
  });

  it('throws aggregated error when all providers reject', async () => {
    const a = new StubProvider('a', { submitResult: async () => { throw new Error('a-fail'); } });
    const b = new StubProvider('b', { submitResult: async () => { throw new Error('b-fail'); } });
    const router = new ProviderRouter({ providers: [a, b], strategy: 'first-success' });

    await expect(router.submit(SAMPLE_REQ)).rejects.toThrow(/all 2 failed/);
  });
});

describe('ProviderRouter — poll routing', () => {
  it('routes poll() to the namespaced provider', async () => {
    const hailuo = new StubProvider('hailuo');
    const kling = new StubProvider('kling');
    const router = new ProviderRouter({ providers: [hailuo, kling], strategy: 'priority' });

    const taskId = await router.submit(SAMPLE_REQ);
    // Internally should be hailuo's task-id with 'hailuo:' prefix.
    const result = await router.poll(taskId);
    expect(result.videoUrl).toContain('hailuo.example');
    expect(hailuo.polls).toHaveLength(1);
    expect(kling.polls).toHaveLength(0);
  });

  it('throws on un-namespaced taskId', async () => {
    const router = new ProviderRouter({ providers: [new StubProvider('a')] });
    await expect(router.poll('not-namespaced')).rejects.toThrow(/not namespaced/);
  });
});

describe('ProviderRouter — construction + reset', () => {
  it('rejects empty provider list', () => {
    expect(() => new ProviderRouter({ providers: [] })).toThrow(/at least one provider/);
  });

  it('rejects unknown strategy', () => {
    expect(() => new ProviderRouter({
      providers: [new StubProvider('a')],
      strategy: 'wat' as unknown as 'priority',
    })).toThrow(/unknown strategy/);
  });

  it('providerName composes from all providers', () => {
    const router = new ProviderRouter({
      providers: [new StubProvider('hailuo'), new StubProvider('kling'), new StubProvider('veo')],
    });
    expect(router.providerName).toBe('router(hailuo|kling|veo)');
  });

  it('reset() clears attempt counters + log', async () => {
    const fail = new StubProvider('fail', {
      submitResult: async () => { throw new ProviderError('q', 'quota_exceeded', 'exhausted'); },
    });
    const router = new ProviderRouter({ providers: [fail] });
    await expect(router.submit(SAMPLE_REQ)).rejects.toThrow();
    expect(router.getAttemptLog()).toHaveLength(1);
    router.reset();
    expect(router.getAttemptLog()).toHaveLength(0);
  });
});