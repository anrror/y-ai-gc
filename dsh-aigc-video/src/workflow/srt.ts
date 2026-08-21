/**
 * SRT subtitle generation for the end-to-end creative pipeline.
 *
 * Takes a list of timed lines (per-shot, with character + text + start
 * / end in seconds) and writes a standard SubRip subtitle file. SRT is
 * the simplest subtitle format that ffmpeg's `subtitles=` filter can
 * burn directly into the final MP4 (handled by VideoMixer).
 *
 * Format reference (SubRip):
 *   1
 *   00:00:01,500 --> 00:00:03,200
 *   Hello, world.
 *
 *   2
 *   00:00:04,000 --> 00:00:06,000
 *   Next line.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SrtLine {
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Visible text (no formatting tags). */
  text: string;
}

/**
 * Format seconds as `HH:MM:SS,mmm` (SubRip).
 *   - HH unbounded (we keep >= 0).
 *   - SS rounded up to avoid negative durations when start === end.
 */
function formatTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe - Math.floor(safe)) * 1000);
  // Round-up safety: if ms rounds to 1000, bump the second.
  let finalS = s;
  let finalMs = ms;
  if (finalMs >= 1000) {
    finalS += 1;
    finalMs -= 1000;
  }
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(finalS)},${pad(finalMs, 3)}`;
}

/**
 * Build SRT content from a list of timed lines. Lines are emitted in
 * order; lines with `end <= start` are dropped (defensive).
 */
export function buildSrt(lines: SrtLine[]): string {
  const out: string[] = [];
  let index = 1;
  for (const l of lines) {
    if (!l.text?.trim()) continue;
    if (l.end <= l.start) continue;
    out.push(String(index));
    out.push(`${formatTimestamp(l.start)} --> ${formatTimestamp(l.end)}`);
    out.push(l.text.trim());
    out.push(''); // blank separator
    index += 1;
  }
  return out.join('\n');
}

/** Write the SRT content to `path` (creates parent dirs as needed). */
export function writeSrt(path: string, lines: SrtLine[]): string {
  const content = buildSrt(lines);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}