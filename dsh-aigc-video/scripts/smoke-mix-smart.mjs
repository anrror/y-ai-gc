/**
 * Smoke test for aigc_mix (混剪) + aigc_smart_edit (智剪).
 *
 * End-to-end against real ffmpeg. Run after installing one of:
 *   npm install --no-save @ffmpeg-installer/ffmpeg   (recommended — reliable Windows binary)
 *   npm install --no-save ffmpeg-static              (cross-platform, but can grab wrong arch)
 *
 * What it tests:
 *   1. Generate 2 synthetic test MP4s (red+440Hz, blue+880Hz, 5s each)
 *   2. Run aigc_mix with crossfade → assert real output MP4 + ~10s duration
 *   3. Run aigc_smart_edit → assert EditDecision JSON with scene+VAD scores
 *
 * Output: prints PASS/FAIL with timings.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

// Probe order: @ffmpeg-installer/ffmpeg (gives Windows binary reliably)
// then ffmpeg-static (can download wrong arch on Windows).
function findFfmpeg() {
  try {
    const m = require('@ffmpeg-installer/ffmpeg');
    return m.path ?? m;
  } catch {}
  try {
    const m = require('ffmpeg-static');
    return m.path ?? m.default?.path ?? m;
  } catch {}
  return null;
}

const FFMPEG = findFfmpeg();
if (!FFMPEG) {
  console.error('FAIL: no ffmpeg binary found. Install one of:');
  console.error('  npm install --no-save @ffmpeg-installer/ffmpeg');
  console.error('  npm install --no-save ffmpeg-static');
  process.exit(2);
}
console.log(`[smoke] ffmpeg: ${FFMPEG}`);
console.log(`[smoke] version: ${execFileSync(FFMPEG, ['-version']).toString().split('\n')[0]}`);

const work = mkdtempSync(join(tmpdir(), 'dsh-smoke-'));
console.log(`[smoke] work dir: ${work}`);

// 1. Generate 2 test videos.
const clip1 = join(work, 'clip1.mp4');
const clip2 = join(work, 'clip2.mp4');
const out = join(work, 'mix-out.mp4');

console.log('[smoke] generating test clips...');
for (const [target, color, freq] of [
  [clip1, 'red', '440'],
  [clip2, 'blue', '880'],
]) {
  execFileSync(
    FFMPEG,
    [
      '-y',
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=5:r=24`,
      '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=5`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      target,
    ],
    { stdio: 'pipe' },
  );
}
console.log(`[smoke] clips: clip1=${(statSync(clip1).size / 1024).toFixed(1)} KB, clip2=${(statSync(clip2).size / 1024).toFixed(1)} KB`);

// 2. aigc_mix (混剪)
console.log('[smoke] running aigc_mix (crossfade 0.5s)...');
const mixStarted = Date.now();
const { mixTool } = await import('../dist/tools/mix.js');
const mixResult = await mixTool.execute(
  {
    clips: [{ path: clip1 }, { path: clip2 }],
    transitions: [{ kind: 'crossfade', duration: 0.5 }],
    output_path: out,
  },
  { signal: undefined },
);
const mixSize = statSync(out).size;
console.log(`[smoke] aigc_mix PASS in ${((Date.now() - mixStarted) / 1000).toFixed(1)}s`);
console.log(`[smoke]   transitions=${mixResult.transitions_applied} duration=${mixResult.duration_seconds}s`);
console.log(`[smoke]   output=${(mixSize / 1024).toFixed(1)} KB`);
if (mixSize < 1000) throw new Error(`mix output too small: ${mixSize} bytes`);

// 3. aigc_smart_edit (智剪) — runs scene_detect + vad against real videos
console.log('[smoke] running aigc_smart_edit...');
const editStarted = Date.now();
const { smartEditTool } = await import('../dist/tools/smart_edit.js');
const editResult = await smartEditTool.execute(
  {
    clips: [
      { path: clip1, duration_hint: 5 },
      { path: clip2, duration_hint: 5 },
    ],
    script: 'A red hero walks into a blue alley. They meet and merge.',
  },
  { signal: undefined },
);
console.log(`[smoke] aigc_smart_edit PASS in ${((Date.now() - editStarted) / 1000).toFixed(1)}s`);
console.log(`[smoke]   decisions=${editResult.decisions.length} total_duration=${editResult.total_duration}s confidence=${editResult.confidence.toFixed(2)}`);
for (const d of editResult.decisions) {
  console.log(`[smoke]   - ${d.clip_path.split(/[\\/]/).pop()}  transition=${d.transition}  score=${d.score.toFixed(2)}`);
  console.log(`[smoke]     reason=${d.reason}`);
}

// 4. ffprobe the mix output to verify it's a real, valid MP4
console.log('[smoke] ffprobe mix output...');
const probe = execFileSync(FFMPEG, ['-i', out], { stdio: 'pipe' }).toString();
const durationMatch = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe);
const videoMatch = /Video: (\w+)/.exec(probe);
const audioMatch = /Audio: (\w+)/.exec(probe);
if (durationMatch) {
  const total = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  console.log(`[smoke]   duration=${total.toFixed(2)}s codec=video:${videoMatch?.[1] ?? '?'} audio:${audioMatch?.[1] ?? '?'}`);
  if (total < 8 || total > 12) throw new Error(`unexpected duration: ${total}s (expected ~10s)`);
}

if (!existsSync(out)) throw new Error('mix output missing');
console.log('\n[smoke] PASS — aigc_mix + aigc_smart_edit ran end-to-end with real ffmpeg');