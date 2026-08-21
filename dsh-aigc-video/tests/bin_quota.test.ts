/**
 * Tests for `bin/quota.mjs` — local-session aggregator.
 *
 * Reads JSON session files from `code/data/sessions/`, aggregates shots +
 * USD + credits, and prints by date. No provider API calls — purely local.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';

// Resolve `bin/quota.mjs` relative to this test file, NOT relative to
// `process.cwd()` — vitest's cwd varies and the user may invoke tests
// from any directory.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, '..');
const QUOTA_CLI = resolve(PKG_ROOT, 'bin', 'quota.mjs');

let scratchDir: string;
function ensureScratch(): string {
  if (!scratchDir) scratchDir = mkdtempSync(join(tmpdir(), 'aigc-quota-'));
  return scratchDir;
}
function cleanup() {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
}
process.on('exit', cleanup);

function writeSession(dir: string, name: string, payload: Record<string, unknown>) {
  writeFileSync(join(dir, name), JSON.stringify(payload));
}

function runQuota(args: string[], dataDir: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [QUOTA_CLI, '--data-dir', dataDir, ...args], {
    encoding: 'utf-8',
    cwd: PKG_ROOT,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe('bin/quota.mjs', () => {
  beforeEach(() => { ensureScratch(); });
  afterEach(cleanup);

  it('reports no-sessions message when data dir is empty', () => {
    const dir = ensureScratch();
    const r = runQuota([], dir);
    expect(r.stdout).toContain('no sessions found');
    expect(r.stdout).toContain('Run a pipeline first');
  });

  it('aggregates one session correctly', () => {
    const dir = ensureScratch();
    writeSession(dir, '2026-08-21T10-00-00.json', {
      updated_at: '2026-08-21T10:00:00Z',
      shots_total: 4,
      shots_succeeded: 3,
      shots_failed: 1,
      provider: 'hailuo',
      estimate: {
        breakdown: { total_usd: 3.36 },
        breakdown_tokens: { total: 3360 },
      },
    });
    const r = runQuota([], dir);
    expect(r.stdout).toContain('📅 2026-08-21');
    expect(r.stdout).toContain('runs:    1');
    expect(r.stdout).toContain('shots:   3/4 succeeded');
    expect(r.stdout).toContain('est USD: $3.36');
    expect(r.stdout).toContain('est credits: 3,360');
    expect(r.stdout).toContain('hailuo(1×4shots)');
  });

  it('groups multiple sessions by date (latest first)', () => {
    const dir = ensureScratch();
    writeSession(dir, '2026-08-21T10.json', { updated_at: '2026-08-21T10:00:00Z', shots_total: 2, shots_succeeded: 2, shots_failed: 0 });
    writeSession(dir, '2026-08-21T15.json', { updated_at: '2026-08-21T15:00:00Z', shots_total: 3, shots_succeeded: 3, shots_failed: 0 });
    writeSession(dir, '2026-08-20T08.json', { updated_at: '2026-08-20T08:00:00Z', shots_total: 1, shots_succeeded: 1, shots_failed: 0 });
    const r = runQuota([], dir);
    // Dates in order: 2026-08-21 first, then 2026-08-20
    const idx21 = r.stdout.indexOf('2026-08-21');
    const idx20 = r.stdout.indexOf('2026-08-20');
    expect(idx21).toBeGreaterThan(-1);
    expect(idx20).toBeGreaterThan(-1);
    expect(idx21).toBeLessThan(idx20);
  });

  it('JSON output is valid JSON with daily + total arrays', () => {
    const dir = ensureScratch();
    writeSession(dir, '2026-08-21T10.json', {
      updated_at: '2026-08-21T10:00:00Z',
      shots_total: 2,
      shots_succeeded: 2,
      shots_failed: 0,
      estimate: { breakdown: { total_usd: 1.68 }, breakdown_tokens: { total: 1680 } },
    });
    const r = runQuota(['--json'], dir);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.daily).toHaveLength(1);
    expect(parsed.daily[0].date).toBe('2026-08-21');
    expect(parsed.total.runs).toBe(1);
    expect(parsed.total.shots_total).toBe(2);
    expect(parsed.total.estimated_usd).toBe(1.68);
  });

  it('--today filter limits to today only', () => {
    const dir = ensureScratch();
    const today = new Date().toISOString();
    writeSession(dir, 'today.json', { updated_at: today, shots_total: 5, shots_succeeded: 5, shots_failed: 0 });
    writeSession(dir, 'old.json', { updated_at: '2020-01-01T00:00:00Z', shots_total: 100, shots_succeeded: 100, shots_failed: 0 });
    const r = runQuota(['--today'], dir);
    expect(r.stdout).toContain('shots:   5/5');
    expect(r.stdout).not.toContain('100/100'); // old session excluded
  });

  it('skips malformed JSON files without crashing', () => {
    const dir = ensureScratch();
    writeFileSync(join(dir, 'bad.json'), '{not valid json');
    writeSession(dir, 'good.json', {
      updated_at: '2026-08-21T10:00:00Z',
      shots_total: 1, shots_succeeded: 1, shots_failed: 0,
    });
    const r = runQuota([], dir);
    expect(r.stdout).toContain('shots:   1/1');
    expect(r.status).toBe(0);
  });
});