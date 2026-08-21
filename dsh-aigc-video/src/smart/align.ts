/**
 * Script ↔ transcript alignment (Phase 6 simplified).
 *
 * Given:
 *   - `script` (one paragraph per line, in order)
 *   - `transcriptSegments` (ordered, with start/end times from Whisper)
 *
 * For each script sentence, find the best-matching transcript segment(s)
 * by Jaccard word overlap. The result is a list of matches that downstream
 * scoring can use to align script text to clip ranges.
 *
 * Phase 6.5 will replace this with a proper forced-aligner (WhisperX /
 * MMS-style) once Whisper transcripts are available.
 */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface ScriptMatch {
  scriptSentence: string;
  matchedSegments: TranscriptSegment[];
  confidence: number;
}

/** Tokenize English / Chinese text into lower-cased words + bigrams. */
function tokens(text: string): Set<string> {
  // Treat any non-letter/non-digit as a separator; collapses CJK characters
  // into per-character tokens so the same set-comparison works for both.
  const out = new Set<string>();
  const lower = text.toLowerCase();
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of words) out.add(w);
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (a && b) out.add(`${a} ${b}`);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Greedy alignment: each script sentence is matched against the
 * best-overlapping contiguous run of transcript segments. The matched
 * run is removed before the next sentence is processed (so each transcript
 * segment is consumed at most once).
 */
export function alignScriptToTranscript(
  script: string,
  transcript: TranscriptSegment[],
): ScriptMatch[] {
  const sentences = script
    .split(/[\n。.!?;；!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];

  const remaining = transcript.slice();
  const matches: ScriptMatch[] = [];

  for (const sentence of sentences) {
    const sTok = tokens(sentence);
    let bestScore = 0;
    let bestStart = -1;
    let bestEnd = -1;
    // Slide a window of 1..min(3, remaining.length) segments.
    const maxWindow = Math.min(3, remaining.length);
    for (let i = 0; i < remaining.length; i++) {
      const t1 = remaining[i];
      if (!t1) continue;
      for (let win = 1; win <= maxWindow; win++) {
        const end = Math.min(remaining.length, i + win);
        const segs = remaining.slice(i, end);
        if (segs.length === 0) continue;
        const merged = segs.map((s) => s.text).join(' ');
        const score = jaccard(sTok, tokens(merged));
        if (score > bestScore) {
          bestScore = score;
          bestStart = i;
          bestEnd = end;
        }
      }
    }

    if (bestStart >= 0 && bestEnd > bestStart && bestScore > 0.05) {
      const matchedSegments = remaining.slice(bestStart, bestEnd).filter((s) => s !== undefined) as TranscriptSegment[];
      matches.push({ scriptSentence: sentence, matchedSegments, confidence: bestScore });
      remaining.splice(bestStart, bestEnd - bestStart);
    } else {
      matches.push({ scriptSentence: sentence, matchedSegments: [], confidence: 0 });
    }
  }
  return matches;
}