/**
 * Phase 6.5: Whisper-based speech-to-text for smart_edit transcripts.
 *
 * Uses `@xenova/transformers` (transformers.js / onnxruntime under the
 * hood) to run whisper-tiny / whisper-base / whisper-small in pure JS /
 * WASM. The model is lazy-loaded on first call and cached in-process; the
 * HuggingFace download happens transparently (≈ 40–500 MB depending on
 * model). All network / model failures are caught and surfaced as a
 * plain `Error` so smart_edit can degrade gracefully to scene-detect +
 * VAD + script-match when whisper is unavailable.
 *
 * Why whisper via transformers.js?
 *   - Cross-platform (Windows / macOS / Linux), no native compilation.
 *   - Quantised models run on CPU in <1 GB RAM for tiny / base.
 *   - The same npm package would otherwise require whisper.cpp binaries
 *     which we've had download issues with on Windows.
 *
 * NOTE: `@xenova/transformers` is declared in optionalDependencies; if
 * the package is missing this module's `transcribeAudio` returns `[]`
 * immediately and emits a single console warning.
 */

import { existsSync } from 'node:fs';
import type { TranscriptSegment } from '../smart/align.js';

export interface TranscribeOptions {
  /** Whisper model id (HuggingFace namespace). Default `Xenova/whisper-tiny`. */
  model?: string;
  /** Force language (`zh` / `en` / ...). Default auto-detect. */
  language?: string;
  /** Sample rate override (default 16000 — whisper's native rate). */
  sampleRate?: number;
}

/**
 * Cache the pipeline loader per (model, language) tuple. transformers.js
 * is heavy on first call (~200–500 MB download) so subsequent calls
 * reuse the same in-process pipeline.
 */
let _pipelinePromise: Promise<unknown> | undefined;
let _pipelineKey: string | undefined;

async function getPipeline(model: string) {
  const key = model;
  if (_pipelinePromise && _pipelineKey === key) return _pipelinePromise;
  _pipelineKey = key;
  _pipelinePromise = (async () => {
    // Dynamic import — `@xenova/transformers` is in optionalDependencies
    // so this may fail on systems where the install was skipped.
    const mod = await import('@xenova/transformers' as string).catch((e) => {
      throw new Error(`@xenova/transformers not installed: ${e instanceof Error ? e.message : String(e)}`);
    });
    // The default export is the transformers namespace; the pipeline
    // factory is at `pipeline`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformers: any = (mod as any).pipeline
      ? mod
      : (mod as any).default ?? mod;
    const factory = transformers.pipeline;
    if (typeof factory !== 'function') {
      throw new Error('@xenova/transformers: pipeline factory not found');
    }
    return factory('automatic-speech-recognition', model, { quantized: true });
  })();
  return _pipelinePromise;
}

/**
 * Run Whisper on a local audio/video file. Returns an ordered list of
 * `{ start, end, text }` segments in seconds.
 *
 * Throws only on programmer errors (e.g. file missing); runtime failures
 * (model load failure, decode failure) are surfaced as empty-array
 * return + console warning so smart_edit can fall back gracefully.
 */
export async function transcribeAudio(
  filePath: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptSegment[]> {
  if (!existsSync(filePath)) {
    throw new Error(`transcribe: file not found: ${filePath}`);
  }
  const model = opts.model ?? 'Xenova/whisper-tiny';
  let pipeline: (input: unknown, opts: unknown) => Promise<unknown>;
  try {
    pipeline = (await getPipeline(model)) as (input: unknown, opts: unknown) => Promise<unknown>;
  } catch (e) {
    console.warn(`[transcribe] ${e instanceof Error ? e.message : String(e)} — falling back to empty transcript`);
    return [];
  }

  // `automatic-speech-recognition` pipeline accepts file paths (Node.js).
  // `chunk_length_s` splits long audio; `stride_length_s` is the overlap.
  // `return_timestamps: 'word'` is the default and produces fine-grained
  // segments which we coalesce to sentence-level below.
  let output: unknown;
  try {
    output = await pipeline(filePath, {
      ...(opts.language ? { language: opts.language } : {}),
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: 'word',
    });
  } catch (e) {
    console.warn(`[transcribe] decode failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  // transformers.js output shape:
  // { text: string, chunks: Array<{ text: string, timestamp: [number|null, number|null] }> }
  // `timestamp` is `[startSec, endSec]` in seconds. Words without a
  // timestamp (e.g. first silence) get `null` start/end — we filter those.
  const chunks = (output as { chunks?: Array<{ text: string; timestamp: [number | null, number | null] }> })?.chunks ?? [];
  const segments: TranscriptSegment[] = [];
  for (const c of chunks) {
    const start = c.timestamp?.[0];
    const end = c.timestamp?.[1];
    if (start == null || end == null) continue;
    const text = (c.text ?? '').trim();
    if (!text) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

/**
 * Best-effort: try whisper, return [] on any issue. Used by smart_edit
 * so a single missing dep / no-network never breaks the cut pipeline.
 */
export async function tryTranscribeAudio(
  filePath: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptSegment[]> {
  try {
    return await transcribeAudio(filePath, opts);
  } catch (e) {
    console.warn(`[transcribe] unexpected error for ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}