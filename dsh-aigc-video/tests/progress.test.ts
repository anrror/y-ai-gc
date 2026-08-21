/**
 * Tests for `src/util/progress.ts` — the observability helpers that give
 * the creative pipeline visible phase boundaries, ETA, and a heartbeat.
 *
 * The pipeline's UX complaint was "整体进度不可见" — these helpers are
 * the fix. Locking them with tests ensures the pipeline stays observable.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  formatTs,
  logWithTs,
  logPhase,
  formatProgressBar,
  progressEta,
  formatDuration,
  shouldBeat,
} from '../src/util/progress.js';

describe('formatTs', () => {
  it('returns HH:MM:SS for a given Date', () => {
    const d = new Date(2024, 0, 1, 9, 5, 3); // 2024-01-01 09:05:03 local
    expect(formatTs(d)).toBe('09:05:03');
  });
  it('pads single-digit hours / minutes / seconds with 0', () => {
    const d = new Date(2024, 0, 1, 1, 2, 3);
    expect(formatTs(d)).toBe('01:02:03');
  });
});

describe('logWithTs', () => {
  it('prefixes the message with a [HH:MM:SS] timestamp', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logWithTs('hello world');
    expect(spy).toHaveBeenCalledTimes(1);
    const out = spy.mock.calls[0]?.[0] as string;
    expect(out).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello world$/);
    spy.mockRestore();
  });
});

describe('logPhase', () => {
  it('emits [Phase 2/4] header with a name', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logPhase('Generating clips', 2, 4);
    const out = spy.mock.calls[0]?.[0] as string;
    expect(out).toMatch(/\[Phase 2\/4\]/);
    expect(out).toContain('Generating clips');
    spy.mockRestore();
  });
});

describe('formatProgressBar', () => {
  it('renders 0% with all-empty bar', () => {
    const bar = formatProgressBar(0);
    expect(bar).toContain('░');
    expect(bar).not.toContain('█');
    expect(bar).toContain('0%');
  });
  it('renders 100% with all-filled bar', () => {
    const bar = formatProgressBar(1);
    expect(bar).toContain('█');
    expect(bar).not.toContain('░');
    expect(bar).toContain('100%');
  });
  it('renders 50% with half-filled bar (default width 20)', () => {
    const bar = formatProgressBar(0.5, 20);
    expect(bar.startsWith('[')).toBe(true);
    // Should have 10 filled + 10 empty (rounded).
    const inner = bar.slice(1, bar.indexOf(']'));
    const filled = (inner.match(/█/g) ?? []).length;
    const empty = (inner.match(/░/g) ?? []).length;
    expect(filled).toBe(10);
    expect(empty).toBe(10);
  });
  it('clamps pct to [0, 1]', () => {
    const over = formatProgressBar(1.5);
    expect(over).toContain('100%');
    expect(over).not.toContain('150%');
    const under = formatProgressBar(-0.5);
    expect(under).toContain('0%');
    expect(under).not.toContain('-50%');
  });
  it('returns fixed width regardless of percentage value', () => {
    const a = formatProgressBar(0.2, 10);
    const b = formatProgressBar(0.8, 10);
    // both should be the same total character length (excluding the % label)
    const inner = (s: string) => s.slice(1, s.indexOf(']'));
    expect(inner(a).length).toBe(inner(b).length);
  });
});

describe('progressEta', () => {
  it('returns "—" when completed=0 (no data to project)', () => {
    expect(progressEta(0, 10, 30_000)).toBe('—');
  });
  it('returns "—" when total<=completed (run finished)', () => {
    expect(progressEta(10, 10, 30_000)).toBe('—');
  });
  it('projects remaining time as mean * (total - completed)', () => {
    // 4 completed in 80s = 20s/shot. 6 remaining → 120s = 2min.
    const eta = progressEta(4, 10, 80_000);
    expect(eta).toBe('2min');
  });
  it('formats sub-minute ETAs as seconds', () => {
    const eta = progressEta(2, 3, 10_000); // 5s/shot × 1 = 5s
    expect(eta).toBe('5s');
  });
});

describe('formatDuration', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(59_000)).toBe('59s');
  });
  it('formats exact-minute durations without trailing :00', () => {
    expect(formatDuration(60_000)).toBe('1min');
    expect(formatDuration(120_000)).toBe('2min');
  });
  it('formats min+sec durations as "Nmin Ns"', () => {
    expect(formatDuration(90_000)).toBe('1min 30s');
    expect(formatDuration(150_000)).toBe('2min 30s');
  });
  it('returns "—" for invalid inputs', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('shouldBeat', () => {
  it('returns true when intervalMs has elapsed since lastBeat', () => {
    const lastBeat = Date.now() - 6_000; // 6s ago
    expect(shouldBeat(lastBeat, 5000)).toBe(true);
  });
  it('returns false when intervalMs has NOT elapsed', () => {
    const lastBeat = Date.now() - 1_000; // 1s ago
    expect(shouldBeat(lastBeat, 5000)).toBe(false);
  });
  it('defaults to 5000ms interval', () => {
    const lastBeat = Date.now() - 6_000;
    expect(shouldBeat(lastBeat)).toBe(true);
  });
});