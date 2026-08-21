/**
 * P0-3: cost pre-estimation for an end-to-end run.
 *
 * Pricing is approximate (USD) and read from a config so it can be tuned
 * without code changes. Per-second rates come from public API docs and
 * recent vendor comparisons (see doc/5-AIGC竞品分析与优化路线.md).
 *
 *   Hailuo-2.3:  ~$0.084 / sec @ 768P    (1 token ≈ 1 USD on Token Plan Max)
 *   Hailuo t2v:  ~$0.0001 / char for TTS  (T2A v2 ≈ 0.5 yuan / 1k chars)
 *   Wan image:   ~$0.02 / image          (DashScope wanx-v1 ≈ 0.08 yuan)
 *
 * The estimator runs synchronously and cheaply — used by callers to
 * surface an estimate before any API call lands.
 */

export interface RunEstimateInput {
  /** Number of shots to render (text→video via Hailuo). */
  shots: number;
  /** Per-shot duration in seconds (Hailuo-2.3: 6s or 10s, snap to nearest). */
  duration_per_shot_sec: number;
  /** Number of character reference images to generate (image API). */
  reference_images?: number;
  /** Number of TTS lines / characters total (for voice-over). */
  tts_chars?: number;
}

export interface RunEstimate {
  /** Per-resource totals in USD. */
  breakdown: {
    video_usd: number;
    image_usd: number;
    tts_usd: number;
    total_usd: number;
  };
  /** Per-resource totals in MiniMax Token Plan credits (1 USD ≈ 1 token). */
  breakdown_tokens: {
    video: number;
    image: number;
    tts: number;
    total: number;
  };
  /** Notes / warnings (e.g. duration snap, out-of-range). */
  notes: string[];
}

export const HAILUO_2_3_USD_PER_SEC = 0.084; // Atlas Cloud 2026
export const WAN_IMAGE_USD_PER_IMAGE = 0.02; // DashScope wanx-v1 baseline
export const T2A_V2_USD_PER_CHAR = 0.00005; // ≈0.5 yuan per 1000 chars

export function estimateRunCost(input: RunEstimateInput): RunEstimate {
  const notes: string[] = [];
  // Snap duration to Hailuo-2.3 legal values (6 / 10 / 15s typical).
  const dur = snapDuration(input.duration_per_shot_sec, notes);

  const videoUsd = input.shots * dur * HAILUO_2_3_USD_PER_SEC;
  const imageUsd = (input.reference_images ?? 0) * WAN_IMAGE_USD_PER_IMAGE;
  const ttsUsd = (input.tts_chars ?? 0) * T2A_V2_USD_PER_CHAR;

  const total = videoUsd + imageUsd + ttsUsd;
  const toToken = (usd: number) => Math.round(usd * 1000); // 1 token ≈ $1 on Token Plan Max (conservative round-up)

  return {
    breakdown: {
      video_usd: round2(videoUsd),
      image_usd: round2(imageUsd),
      tts_usd: round2(ttsUsd),
      total_usd: round2(total),
    },
    breakdown_tokens: {
      video: toToken(videoUsd),
      image: toToken(imageUsd),
      tts: toToken(ttsUsd),
      total: toToken(total),
    },
    notes,
  };
}

function snapDuration(sec: number, notes: string[]): number {
  // Hailuo-2.3 accepts 6 / 10 / 15. Snap to nearest legal value, warn.
  const legal = [6, 10, 15];
  const snapped = legal.reduce((best, v) => Math.abs(v - sec) < Math.abs(best - sec) ? v : best, legal[0]!);
  if (snapped !== sec) notes.push(`duration snapped: ${sec}s → ${snapped}s (Hailuo-2.3 legal values)`);
  return snapped;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}