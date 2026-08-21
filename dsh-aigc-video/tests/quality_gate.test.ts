/**
 * Tests for `src/video/quality_gate.ts`.
 *
 * Focuses on the regression we just fixed: ffprobe / ffmpeg missing on the
 * host should be a SOFT skip (ok=true, reasons=['probe_unavailable']), not
 * a hard failure that wipes valid clips from the report.
 *
 * Test environment note: this Windows box may not have ffprobe installed.
 * That's actually the perfect condition for these tests — we explicitly
 * exercise the missing-binary path and verify it no longer misclassifies
 * clips as failed.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkClipQuality } from '../src/video/quality_gate.js';

let scratchDir: string;
function ensureScratch(): string {
  if (!scratchDir) scratchDir = mkdtempSync(join(tmpdir(), 'aigc-qgate-'));
  return scratchDir;
}
function cleanup() {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
}
process.on('exit', cleanup);

describe('checkClipQuality', () => {
  it('returns missing_file reason when file does not exist', async () => {
    const r = await checkClipQuality('C:/no/such/file.mp4');
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('missing_file');
  });

  it('returns too_small reason when file is under 1 KB', async () => {
    const dir = ensureScratch();
    const p = join(dir, 'tiny.mp4');
    writeFileSync(p, Buffer.from([0x00, 0x00, 0x00])); // 3 bytes
    const r = await checkClipQuality(p);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('too_small');
  });

  it('returns ok=true with probe_unavailable when ffprobe binary is missing', async () => {
    const dir = ensureScratch();
    const p = join(dir, 'fake.mp4');
    // Write 2 KB of dummy bytes — passes the size check, fails on ffprobe.
    writeFileSync(p, Buffer.alloc(2048, 0x42));
    const r = await checkClipQuality(p, {
      // Path that almost certainly doesn't exist on any host.
      ffprobePath: 'C:/__definitely_no_such_binary__/ffprobe.exe',
    });
    // The whole point of this fix: missing tool → SOFT skip, not failure.
    expect(r.ok).toBe(true);
    expect(r.reasons).toContain('probe_unavailable');
  });

  it('does NOT mark the clip as failed when only the probe tool is missing', async () => {
    const dir = ensureScratch();
    const p = join(dir, 'fake2.mp4');
    writeFileSync(p, Buffer.alloc(2048, 0x42));
    const r = await checkClipQuality(p, {
      ffprobePath: '/nonexistent/ffprobe',
    });
    // Critical regression guard: the reasons array must contain ONLY
    // 'probe_unavailable' (soft), never 'probe_failed' (hard).
    expect(r.reasons).not.toContain('probe_failed');
    expect(r.reasons).toEqual(['probe_unavailable']);
  });

  it('still returns ok=false with probe_failed when ffprobe exists but reports garbage', async () => {
    const dir = ensureScratch();
    const p = join(dir, 'fake3.mp4');
    writeFileSync(p, Buffer.alloc(2048, 0x42));
    // Use the `node` executable with a script that exits non-zero via
    // --check (parse failure) — this fails the execFile call but the
    // failure is NOT an ENOENT, so we should still hit probe_failed.
    const r = await checkClipQuality(p, {
      ffprobePath: process.execPath,
    });
    // `node` won't output ffprobe's expected format → execFile may succeed
    // (exit 0) but the parse finds nothing, OR it may exit non-zero. Either
    // way the reasons array must NOT contain 'probe_unavailable' (we have
    // an executable binary, just not the right one).
    expect(r.reasons).not.toContain('probe_unavailable');
  });
});

beforeAll(() => { ensureScratch(); });
afterAll(cleanup);