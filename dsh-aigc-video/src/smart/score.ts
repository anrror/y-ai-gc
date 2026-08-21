/**
 * Heuristic scoring for a candidate cut point.
 *
 * `scoreCandidate` combines:
 *   - 0.5 × script alignment confidence
 *   - 0.2 × normalised motion / scene-change density
 *   - 0.2 × normalised audio energy / speech presence
 *   - 0.1 × position score (peaks in the middle, tapers at the edges)
 *
 * v2 will swap heuristic factors for a Qwen2-VL ONNX inference call.
 */

export interface CutCandidate {
  /** Time offset in seconds. */
  t: number;
  /** How strongly this is a scene change. */
  sceneScore: number;
  /** 0..1 — speech / music energy at this moment. */
  audioScore: number;
  /** 0..1 — script alignment confidence. */
  scriptScore: number;
  /** Total clip duration, used to compute position bonus. */
  duration: number;
}

export function scoreCandidate(c: CutCandidate): { score: number; reason: string } {
  const positionFactor = 1 - Math.abs(c.t / Math.max(0.1, c.duration) - 0.5) * 2; // peak in middle
  const score =
    0.5 * clamp01(c.scriptScore) +
    0.2 * clamp01(c.sceneScore) +
    0.2 * clamp01(c.audioScore) +
    0.1 * clamp01(positionFactor);
  return {
    score: clamp01(score),
    reason: `script=${(c.scriptScore * 100).toFixed(0)}% scene=${(c.sceneScore * 100).toFixed(0)}% audio=${(c.audioScore * 100).toFixed(0)}% pos=${(positionFactor * 100).toFixed(0)}%`,
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}