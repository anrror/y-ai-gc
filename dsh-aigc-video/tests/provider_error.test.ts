/**
 * ProviderError + withProviderRetry unit tests.
 *
 * P0-2: error grading so callers can branch on kind instead of parsing
 * messages. The classifier + retry helper are pure logic, no ffmpeg or
 * HTTP — safe to test directly.
 */

import { describe, expect, it } from 'vitest';
import { ProviderError, ProviderHttpError, withProviderRetry } from '../src/providers/base.js';

describe('ProviderError.fromHttp', () => {
  it('classifies MiniMax 2056 as quota_exceeded (non-retriable)', () => {
    const http = new ProviderHttpError(200, 'quota', 2056, '已达 Token Plan 用量上限');
    const e = ProviderError.fromHttp(http);
    expect(e.kind).toBe('quota_exceeded');
    expect(e.retriable).toBe(false);
    expect(e.providerCode).toBe(2056);
  });

  it('classifies MiniMax 1004 (auth) as bad_request (non-retriable)', () => {
    const http = new ProviderHttpError(200, 'login fail', 1004, 'Please carry the API secret key');
    const e = ProviderError.fromHttp(http);
    expect(e.kind).toBe('bad_request');
    expect(e.retriable).toBe(false);
  });

  it('classifies HTTP 500 as transient (retriable)', () => {
    const http = new ProviderHttpError(500, 'server error');
    const e = ProviderError.fromHttp(http);
    expect(e.kind).toBe('transient');
    expect(e.retriable).toBe(true);
  });

  it('classifies HTTP 429 as transient (retriable)', () => {
    const http = new ProviderHttpError(429, 'rate limit');
    const e = ProviderError.fromHttp(http);
    expect(e.kind).toBe('transient');
    expect(e.retriable).toBe(true);
  });

  it('classifies HTTP 400 as bad_request (non-retriable)', () => {
    const http = new ProviderHttpError(400, 'bad payload');
    const e = ProviderError.fromHttp(http);
    expect(e.kind).toBe('bad_request');
    expect(e.retriable).toBe(false);
  });
});

describe('withProviderRetry', () => {
  it('returns the value on first success', async () => {
    let calls = 0;
    const out = await withProviderRetry(async () => {
      calls += 1;
      return 42;
    });
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries transient errors then succeeds', async () => {
    let calls = 0;
    const out = await withProviderRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new ProviderError('transient', `try ${calls}`, { httpStatus: 500 });
        }
        return 'ok';
      },
      { maxRetries: 5 },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry quota_exceeded (hard-stop)', async () => {
    let calls = 0;
    await expect(
      withProviderRetry(
        async () => {
          calls += 1;
          throw new ProviderError('quota_exceeded', 'plan cap', { providerCode: 2056 });
        },
        { maxRetries: 5 },
      ),
    ).rejects.toMatchObject({ kind: 'quota_exceeded' });
    expect(calls).toBe(1);
  });

  it('does not retry bad_request', async () => {
    let calls = 0;
    await expect(
      withProviderRetry(
        async () => {
          calls += 1;
          throw new ProviderError('bad_request', 'bad', { httpStatus: 400 });
        },
        { maxRetries: 5 },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(calls).toBe(1);
  });

  it('eventually throws after maxRetries exhausted', async () => {
    let calls = 0;
    await expect(
      withProviderRetry(
        async () => {
          calls += 1;
          throw new ProviderError('transient', 'flaky', { httpStatus: 500 });
        },
        { maxRetries: 2 },
      ),
    ).rejects.toMatchObject({ kind: 'transient' });
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('honors caller signal abort', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      withProviderRetry(
        async () => 'never',
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('wraps unknown errors as network and retries once', async () => {
    let calls = 0;
    const out = await withProviderRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('connect ECONNREFUSED');
        return 'recovered';
      },
    );
    expect(out).toBe('recovered');
    expect(calls).toBe(2);
  });
});