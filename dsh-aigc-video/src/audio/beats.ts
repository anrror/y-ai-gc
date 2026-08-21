/**
 * Beat / onset detection from an audio file.
 *
 * Phase 7: lightweight implementation using ffmpeg's `astats` to derive
 * an RMS energy curve, plus a simple peak-picking pass. Symphonia-based
 * spectral flux is the v2 upgrade (Phase 7.5).
 *
 * Output: monotonically increasing beat times in seconds.
 */

import { spawn } from 'node:child_process';
import { FfmpegRunner } from '../video/ffmpeg.js';

export interface BeatOptions {
  /** Min energy delta to register a beat. Default 0.15. */
  threshold?: number;
  /** Minimum gap between two beats, in ms. Default 250. */
  minGapMs?: number;
  ffmpegPath?: string;
}

export async function detectBeats(
  file: string,
  opts: BeatOptions = {},
): Promise<number[]> {
  const threshold = opts.threshold ?? 0.15;
  const minGapMs = opts.minGapMs ?? 250;
  const minGapSec = minGapMs / 1000;
  const runner = new FfmpegRunner({ ffmpegPath: opts.ffmpegPath });

  // ffmpeg -i FILE -af "astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level"
  // -f null -
  // Each line prints `frame:N pts:<...> pts_time:<sec>` plus RMS_level=-<dB>.
  const args = [
    '-hide_banner', '-nostats',
    '-i', file,
    '-af', 'astats=metadata=1:reset=1:length=0.05,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ];
  const samples: Array<{ t: number; rms: number }> = [];
  const child = spawn(runner.resolveBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    let lastT = 0;
    let lastRms: number | null = null;
    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      for (const line of buffer.split('\n')) {
        if (line.startsWith('frame:') || line.startsWith('pts_time:')) {
          const t = /pts_time:([\d.]+)/.exec(line);
          if (t) lastT = parseFloat(t[1] ?? '0');
        }
        if (line.startsWith('RMS_level=')) {
          const v = /RMS_level=(-?[\d.]+)/.exec(line);
          if (v) {
            const db = parseFloat(v[1] ?? '-100');
            // Convert dB to linear 0..1 (approx). -60 dB ≈ 0, 0 dB ≈ 1.
            const linear = Math.max(0, Math.min(1, (db + 60) / 60));
            lastRms = linear;
            samples.push({ t: lastT, rms: lastRms });
          }
        }
      }
      const lastNl = buffer.lastIndexOf('\n');
      if (lastNl >= 0) buffer = buffer.slice(lastNl + 1);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`ffmpeg astats failed (code ${code})`));
    });
  });
  if (samples.length < 2) return [];

  // Smooth (3-point moving average) and detect peaks.
  const smoothed = samples.map((s, i) => {
    const a = samples[i - 1]?.rms ?? s.rms;
    const c = samples[i + 1]?.rms ?? s.rms;
    return { t: s.t, rms: (a + s.rms + c) / 3 };
  });
  const beats: number[] = [];
  let lastBeatT = -Infinity;
  for (let i = 1; i < smoothed.length - 1; i++) {
    const s = smoothed[i];
    if (!s) continue;
    const prev = smoothed[i - 1];
    const next = smoothed[i + 1];
    if (!prev || !next) continue;
    if (s.rms > prev.rms && s.rms > next.rms && s.rms - prev.rms > threshold) {
      if (s.t - lastBeatT >= minGapSec) {
        beats.push(s.t);
        lastBeatT = s.t;
      }
    }
  }
  return beats;
}