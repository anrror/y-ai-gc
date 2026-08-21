/**
 * Scene change detection via ffmpeg's `select=gt(scene,...)` filter.
 *
 * Output: list of `t` (seconds) timestamps where the scene difference
 * score exceeds the threshold (default 0.4 = 40 % per-frame delta).
 *
 * Phase 6: simple wrapper. Real systems can swap in TransNetV2 / PySceneDetect,
 * but ffmpeg is shipped everywhere and avoids a 1-GB model download.
 */

import { spawn } from 'node:child_process';
import { FfmpegRunner } from '../video/ffmpeg.js';

export interface SceneChange {
  /** Time offset in seconds. */
  t: number;
  /** Raw scene-difference score at that frame (0..1). */
  score?: number;
}

export async function detectScenes(
  file: string,
  opts: { threshold?: number; ffmpegPath?: string } = {},
): Promise<SceneChange[]> {
  const threshold = opts.threshold ?? 0.4;
  const runner = new FfmpegRunner({ ffmpegPath: opts.ffmpegPath });
  // Reuse spawn via a dedicated argv: ffmpeg -nostats -i FILE -vf
  // select='gt(scene,THRESHOLD)',showinfo -f null -
  // The `showinfo` filter prints `pts_time=<sec>` for each cut.
  const args = [
    '-nostats',
    '-i', file,
    '-vf', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null',
    '-',
  ];
  const events: SceneChange[] = [];
  const child = spawn(runner.resolveBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      for (const line of buffer.split('\n')) {
        if (line.includes('pts_time:')) {
          const m = /pts_time:([\d.]+)/.exec(line);
          if (m) events.push({ t: parseFloat(m[1] ?? '0') });
        }
      }
      // Truncate buffer to last incomplete line to avoid memory growth.
      const lastNl = buffer.lastIndexOf('\n');
      if (lastNl >= 0) buffer = buffer.slice(lastNl + 1);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 || code === null) resolve();
      // ffmpeg returns 0 even for filter output streams; non-zero is an error.
      else reject(new Error(`ffmpeg scene-detect failed (code ${code})`));
    });
  });
  return events;
}