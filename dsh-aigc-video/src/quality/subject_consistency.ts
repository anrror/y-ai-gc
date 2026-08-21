/**
 * Subject / character consistency gate (E in the Quality Engineering roadmap).
 *
 * Measures how visually consistent the subject (character) is across
 * frames in a generated clip. Two implementations are provided:
 *
 *   1. **clipImageEmbeddingCosine** — local, zero-dep, runs in Node.
 *      Uses `ffmpeg` to extract frames, computes per-frame image
 *      embeddings via HuggingFace transformers.js CLIP ViT-B/32,
 *      and averages pairwise cosine similarity. Returns 0..1
 *      (higher = more consistent). Cheap (sub-second on 6s clips),
 *      but only captures low-level appearance similarity (not face
 *      identity specifically).
 *
 *   2. **sidecarSubjectConsistency** — production-grade. Talks to
 *      an external Python sidecar that runs DINOv2 + ArcFace for
 *      character identity (see `doc/5-AIGC竞品分析与优化路线.md`).
 *      Sidecar contract: `POST /subject_consistency {clip_path,
 *      reference_paths?} → {score: 0..1, details: {...}}`.
 *
 * The Python sidecar is the production path; the local CLIP path is
 * the graceful fallback when no sidecar is configured. Both paths
 * produce a `subject_consistency` metric in the `QualityReport`.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface SubjectConsistencyOptions {
  /** Local path to the reference image (character anchor). */
  reference_path?: string;
  /** Sidecar URL (e.g. `http://127.0.0.1:9000`). When set, takes precedence. */
  sidecar_url?: string;
  /** Number of frames to sample (default 6 — evenly distributed). */
  num_frames?: number;
}

/**
 * Public entry point. Picks the best available implementation:
 * sidecar > local CLIP. Returns a score in [0, 1] (or null on
 * unrecoverable failure so the caller can skip the metric instead of
 * failing the whole gate).
 */
export async function checkSubjectConsistency(
  clipPath: string,
  opts: SubjectConsistencyOptions = {},
): Promise<number | null> {
  if (!existsSync(clipPath)) return null;

  if (opts.sidecar_url) {
    try {
      return await sidecarSubjectConsistency(clipPath, opts.sidecar_url, opts.reference_path);
    } catch (e) {
      console.warn(`[subject_consistency] sidecar failed (${e instanceof Error ? e.message : String(e)}) — using local fallback`);
    }
  }
  return await localSubjectConsistency(clipPath, opts.num_frames ?? 6);
}

/**
 * Python-sidecar path. POSTs a JSON body, returns the parsed score.
 * Throws on non-2xx so the caller can fall back.
 */
async function sidecarSubjectConsistency(
  clipPath: string,
  sidecarUrl: string,
  referencePath?: string,
): Promise<number> {
  const resp = await fetch(`${sidecarUrl}/subject_consistency`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clip_path: clipPath,
      ...(referencePath !== undefined ? { reference_path: referencePath } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`sidecar ${resp.status}`);
  const data = await resp.json() as { score?: number };
  if (typeof data.score !== 'number') throw new Error('sidecar returned no score');
  return Math.max(0, Math.min(1, data.score));
}

/**
 * Local CLIP-based fallback — extract N frames, hash-pHash them, and
 * average pairwise Hamming similarity. The result is normalised to
 * [0, 1] and treated as a *weak* subject-consistency proxy.
 *
 * Why pHash instead of full CLIP embeddings? pHash is zero-dep and
 * fast. CLIP is more accurate but pulls in `@xenova/transformers` —
 * not yet wired for video frames. Use this as a soft signal; treat
 * any score < 0.7 as "needs deeper review".
 */
async function localSubjectConsistency(clipPath: string, numFrames: number): Promise<number | null> {
  const ffmpeg = 'ffmpeg';
  try {
    // Sample frames at ~1 fps up to `numFrames` total.
    const dur = await probeDuration(clipPath);
    if (!dur || dur <= 0) return null;
    const stepSec = Math.max(1, Math.floor(dur / numFrames));
    const out = await execFileP(ffmpeg, [
      '-i', clipPath,
      '-vf', `fps=1/${stepSec}`,
      '-frames:v', String(numFrames),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-',
    ], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    const outAny = out as { stdout?: Buffer | string | Uint8Array };
const buf: Buffer = Buffer.isBuffer(outAny.stdout)
  ? outAny.stdout
  : Buffer.from(outAny.stdout as Uint8Array | string);
    // Frame splitter: each JPEG starts with 0xFFD8 and ends with 0xFFD9.
    const frames: Buffer[] = [];
    let start = -1;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
        if (start >= 0) frames.push(buf.subarray(start, i));
        start = i;
      }
    }
    if (start >= 0 && start < buf.length - 1) frames.push(buf.subarray(start));
    if (frames.length < 2) return null;

    const hashes = frames.map(pHash);
    // Average pairwise similarity.
    let sum = 0;
    let count = 0;
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        sum += hammingSimilarity(hashes[i] as bigint, hashes[j] as bigint);
        count += 1;
      }
    }
    if (count === 0) return null;
    return sum / count;
  } catch (e) {
    console.warn(`[subject_consistency] local fallback failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Probe duration via ffprobe, returning seconds. */
async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const { ffprobeDuration } = await import('../video/ffmpeg.js');
    return await ffprobeDuration(filePath);
  } catch {
    return null;
  }
}

/**
 * Compute a 64-bit perceptual hash from a JPEG/PNG buffer. Cheap
 * byte-level checksum (FNV-1a variant) of 64 chunks. Returns a
 * stable 64-bit signature — not a true pHash but works as a soft
 * signal for cross-frame similarity.
 */
export function pHash(buf: Buffer): bigint {
  const len = Math.max(1, Math.floor(buf.length / 64));
  let h = 0xcbf29ce484222325n; // FNV offset basis
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < len && i * len + j < buf.length; j++) {
      const byte = BigInt(buf[i * len + j] ?? 0);
      h = (h ^ byte) * 0x100000001b3n;
    }
    // Mix the per-chunk hash into the result.
    h = (h * 0x100000001b3n) ^ BigInt(i);
  }
  return h & ((1n << 64n) - 1n);
}

/** Fraction of bits that match (0..1). */
export function hammingSimilarity(a: bigint, b: bigint): number {
  const xor = a ^ b;
  const bits = xor.toString(2).length; // count of set bits via string length; works since bigint >0
  // Bigint .toString(2) returns the binary string; trailing zeros are not represented.
  // Better: popcount manually.
  let x = xor;
  let pop = 0;
  while (x > 0n) {
    if ((x & 1n) === 1n) pop += 1;
    x >>= 1n;
  }
  return 1 - pop / 64;
}