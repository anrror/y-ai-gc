/**
 * Voice activity / silence detection via ffmpeg's silencedetect filter.
 *
 * Output: alternating speech / silence intervals in seconds.
 *
 * Phase 6: simple wrapper. silero-vad (better quality, smaller
 * artefacts) will be a Phase 6.5 sub-task.
 */

import { spawn } from 'node:child_process';
import { FfmpegRunner } from '../video/ffmpeg.js';

export interface VadInterval {
  /** "silence" or "speech" */
  kind: 'silence' | 'speech';
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
}

export async function detectSpeech(
  file: string,
  opts: { noiseDb?: number; minSilenceMs?: number; ffmpegPath?: string } = {},
): Promise<VadInterval[]> {
  const noise = opts.noiseDb ?? -30; // dB
  const min = opts.minSilenceMs ?? 500;
  const runner = new FfmpegRunner({ ffmpegPath: opts.ffmpegPath });
  const args = [
    '-nostats',
    '-i', file,
    '-af', `silencedetect=noise=${noise}dB:d=${min / 1000}`,
    '-f', 'null',
    '-',
  ];
  const intervals: VadInterval[] = [];
  let lastEnd = 0;
  let cursor = 0;
  const child = spawn(runner.resolveBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      for (const line of buffer.split('\n')) {
        if (line.includes('silence_start:')) {
          const m = /silence_start: ([\d.]+)/.exec(line);
          if (m) {
            const start = parseFloat(m[1] ?? '0');
            if (cursor < start) {
              intervals.push({ kind: 'speech', start: cursor, end: start });
            }
            cursor = start;
          }
        } else if (line.includes('silence_end:')) {
          const m = /silence_end: ([\d.]+)/.exec(line);
          if (m) {
            const end = parseFloat(m[1] ?? '0');
            intervals.push({ kind: 'silence', start: cursor, end });
            cursor = end;
            lastEnd = end;
          }
        }
      }
      const lastNl = buffer.lastIndexOf('\n');
      if (lastNl >= 0) buffer = buffer.slice(lastNl + 1);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 || code === null) {
        // Open-tail "speech" interval from the last cursor to the file end.
        if (cursor > lastEnd) {
          intervals.push({ kind: 'speech', start: lastEnd, end: cursor });
        }
        resolve();
      } else {
        reject(new Error(`ffmpeg silencedetect failed (code ${code})`));
      }
    });
  });
  return intervals;
}