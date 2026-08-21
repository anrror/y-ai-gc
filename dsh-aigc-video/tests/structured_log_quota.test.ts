/**
 * Tests for `src/util/structured_log.ts` + `src/quota/budget.ts`.
 *
 * Two-way observability: structured JSON lines for production log
 * aggregation, human-readable text for dev. QuotaTracker aggregates
 * per-provider usage for the `/quota` CLI.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  logStructured,
  logInfo,
  logWarn,
  logError,
  isStructuredLoggingEnabled,
  SESSION_ID,
} from '../src/util/structured_log.js';
import { QuotaTracker } from '../src/quota/budget.js';

describe('structured_log', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalStructured: string | undefined;
  let structuredActive = false;

  beforeEach(() => {
    originalStructured = process.env.AIGC_STRUCTURED_LOGS;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (originalStructured === undefined) delete process.env.AIGC_STRUCTURED_LOGS;
    else process.env.AIGC_STRUCTURED_LOGS = originalStructured;
  });

  function enableStructured() {
    process.env.AIGC_STRUCTURED_LOGS = '1';
    structuredActive = true;
  }
  function disableStructured() {
    process.env.AIGC_STRUCTURED_LOGS = '0';
    structuredActive = false;
  }

  it('emits JSON line to stdout when STRUCTURED=1 and level=info', () => {
    enableStructured();
    logInfo('hello world', { shot: 1 });
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const line = stdoutSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed).toMatchObject({
      level: 'info',
      msg: 'hello world',
      session_id: SESSION_ID,
      shot: 1,
    });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits JSON line to stderr when level=warn/error (even with STRUCTURED=1)', () => {
    enableStructured();
    logWarn('something fishy', { code: 'E2056' });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line.trim());
    expect(parsed.level).toBe('warn');
    expect(parsed.code).toBe('E2056');
  });

  it('emits human-readable line when STRUCTURED=0 (dev mode)', () => {
    disableStructured();
    logInfo('hello dev', { shot: 2 });
    const line = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\] \[INFO\] hello dev/);
    expect(line).toContain('"shot":2');
  });

  it('isStructuredLoggingEnabled reflects env var', () => {
    enableStructured();
    expect(isStructuredLoggingEnabled()).toBe(true);
    disableStructured();
    expect(isStructuredLoggingEnabled()).toBe(false);
  });

  it('SESSION_ID is stable across calls', () => {
    const a = SESSION_ID;
    logInfo('one');
    const b = SESSION_ID;
    expect(a).toBe(b);
    expect(a).toMatch(/^run_\d+_\d+$/);
  });
});

describe('QuotaTracker', () => {
  let tracker: QuotaTracker;
  beforeEach(() => {
    tracker = new QuotaTracker();
  });

  it('starts empty', () => {
    const r = tracker.report('session-x');
    expect(r.providers).toEqual([]);
    expect(r.totals).toEqual({
      shots_submitted: 0,
      shots_succeeded: 0,
      shots_failed: 0,
      estimated_credits_used: 0,
      estimated_usd_used: 0,
    });
  });

  it('records successful shots + accumulates estimate once per provider', () => {
    const estimate = {
      breakdown: {
        video_usd: 3.0,
        image_usd: 0,
        tts_usd: 0.1,
        total_usd: 3.1,
      },
      breakdown_tokens: { video: 3000, image: 0, tts: 100, total: 3100 },
      notes: [],
    };
    tracker.recordSubmit('hailuo', true, undefined, estimate);
    tracker.recordSubmit('hailuo', true, undefined, estimate); // estimate already applied
    tracker.recordSubmit('hailuo', true, undefined, estimate);

    const r = tracker.report('session-1');
    expect(r.providers).toHaveLength(1);
    const hailuo = r.providers[0]!;
    expect(hailuo.provider).toBe('hailuo');
    expect(hailuo.shots_submitted).toBe(3);
    expect(hailuo.shots_succeeded).toBe(3);
    expect(hailuo.shots_failed).toBe(0);
    expect(hailuo.estimated_credits_used).toBe(3100); // applied only once
    expect(hailuo.estimated_usd_used).toBe(3.1);
  });

  it('records failures separately and tracks last_error', () => {
    tracker.recordSubmit('hailuo', false, 'quota exceeded');
    tracker.recordSubmit('kling', true);

    const r = tracker.report('session-2');
    const hailuo = r.providers.find((p) => p.provider === 'hailuo')!;
    const kling = r.providers.find((p) => p.provider === 'kling')!;
    expect(hailuo.shots_failed).toBe(1);
    expect(hailuo.shots_succeeded).toBe(0);
    expect(hailuo.last_error).toBe('quota exceeded');
    expect(kling.shots_succeeded).toBe(1);
    expect(r.totals.shots_submitted).toBe(2);
  });

  it('aggregates totals across multiple providers', () => {
    tracker.recordSubmit('hailuo', true);
    tracker.recordSubmit('hailuo', true);
    tracker.recordSubmit('kling', false, 'network blip');
    tracker.recordSubmit('kling', true);

    const r = tracker.report('session-3');
    expect(r.totals.shots_submitted).toBe(4);
    expect(r.totals.shots_succeeded).toBe(3);
    expect(r.totals.shots_failed).toBe(1);
  });

  it('handles missing estimate gracefully (estimate=undefined)', () => {
    tracker.recordSubmit('hailuo', true); // no estimate
    const r = tracker.report('session-4');
    expect(r.providers[0]?.estimated_credits_used).toBe(0);
    expect(r.providers[0]?.estimated_usd_used).toBe(0);
    expect(r.providers[0]?.shots_succeeded).toBe(1);
  });
});