import { describe, expect, it } from 'vitest';
import { alignScriptToTranscript } from '../src/smart/align.js';

describe('alignScriptToTranscript', () => {
  it('returns one match per non-empty script sentence', () => {
    const out = alignScriptToTranscript('Hello world. Goodbye world.', [
      { start: 0, end: 1, text: 'hello world' },
      { start: 1, end: 2, text: 'goodbye world' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.scriptSentence).toBe('Hello world');
    expect(out[0]?.matchedSegments).toHaveLength(1);
  });

  it('matches even with partial word overlap', () => {
    const out = alignScriptToTranscript('a quick brown fox', [
      { start: 0, end: 1, text: 'a slow brown fox jumps' },
    ]);
    expect(out[0]?.confidence).toBeGreaterThan(0);
  });

  it('returns confidence 0 when no overlap', () => {
    const out = alignScriptToTranscript('alpha beta gamma', [
      { start: 0, end: 1, text: 'completely unrelated words' },
    ]);
    expect(out[0]?.confidence).toBe(0);
    expect(out[0]?.matchedSegments).toEqual([]);
  });

  // TODO(6.5): improve tokenisation for CJK — the current bigram-only
  // approach treats CJK text as a single "word" so sub-word overlap is
  // missed. Phase 6.5 will add per-character n-grams for non-whitespace
  // scripts; meanwhile the CJK case still works in practice because Whisper
  // transcripts for Chinese typically match the script sentence-for-sentence.
});