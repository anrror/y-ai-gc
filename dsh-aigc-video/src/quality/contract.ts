/**
 * Quality contract — the unified interface every stage returns.
 *
 * Design philosophy (Quality by Design):
 *   - Every stage must produce a QualityReport alongside its payload.
 *   - Every metric has a threshold; failure triggers a StageAction.
 *   - Composite score is a weighted sum of all metrics, used by
 *     higher-level decision agents.
 *
 * The metrics we use are a VBench-lite subset (see VBench/EvalCrafter).
 * CLIP-Score alone correlates only 6.3% with human ratings per
 * EvalCrafter, so we use a 6-dimensional composite instead.
 */

/** Single metric value: 0..1 (higher = better). */
export type MetricScore = number;

/** All metrics we currently track. */
export type MetricName =
  | 'duration_ok'           // clip duration matches expected ±20%
  | 'resolution_ok'         // ≥ min width/height
  | 'black_frame_ratio'    // 0..1, lower = better (we invert to 0..1 good)
  | 'subject_consistency'  // ArcFace cosine across frames
  | 'temporal_consistency'  // CLIP image embedding cosine across frames
  | 'temporal_flickering'  // 0..1, lower = better (inverted)
  | 'motion_smoothness'     // 0..1, higher = better
  | 'aesthetic_quality'     // LAION aesthetic predictor (normalised to 0..1)
  | 'prompt_alignment'     // CLIP text-image cosine
  | 'script_completeness'  // 5-act structure present
  | 'audio_sync'           // voice track vs video track time offset (inverted)
  ;

/**
 * Default thresholds for each metric. Stage output is `passed` when
 * all checked metrics meet the threshold (or the metric wasn't measured).
 *
 * Values are conservative — derived from VBench real-video baselines
 * (real video ≈ 0.84 subject consistency, etc.). Lower to be strict,
 * raise to be permissive.
 */
export const DEFAULT_THRESHOLDS: Record<MetricName, number> = {
  duration_ok: 0.5,            // binary: 1.0 if matches, 0.0 if not
  resolution_ok: 0.5,          // binary
  black_frame_ratio: 0.5,      // we want ≤50% black; score = 1 - black_ratio
  subject_consistency: 0.65,   // VBench real ≈ 0.84
  temporal_consistency: 0.85,  // VBench background consistency floor
  temporal_flickering: 0.85,   // inverted MAD; ≥0.85 means MAD ≤0.15
  motion_smoothness: 0.80,
  aesthetic_quality: 0.45,     // LAION aesthetic normalised: 0.45 ≈ 4.5/10
  prompt_alignment: 0.25,     // CLIP cosine; ≥0.25 = meaningful match
  script_completeness: 0.6,   // 5-act heuristic score
  audio_sync: 0.90,           // ±100ms → 0.90
};

/** Composite weights (sum ≈ 1.0 after normalising). */
export const DEFAULT_WEIGHTS: Partial<Record<MetricName, number>> = {
  duration_ok: 0.05,
  resolution_ok: 0.05,
  black_frame_ratio: 0.10,
  subject_consistency: 0.20,   // heaviest — most important for series/IP
  temporal_consistency: 0.15,
  temporal_flickering: 0.10,
  motion_smoothness: 0.05,
  aesthetic_quality: 0.10,
  prompt_alignment: 0.15,
  script_completeness: 0.05,
  audio_sync: 0.10,
};
// Raw weights (sum = 1.10); compositeScore() normalises by totalWeight() so
// the actual composite stays in [0, 1].

/** Composite weight sum (for normalisation). */
export function totalWeight(): number {
  return Object.values(DEFAULT_WEIGHTS).reduce((s, w) => s + (w ?? 0), 0);
}

/** Single metric reading in a report. */
export interface MetricReading {
  name: MetricName;
  value: MetricScore;
  threshold: number;
  passed: boolean;
}

/**
 * QualityReport — the unified per-stage quality assessment.
 *
 * `metrics` is intentionally a Map (not all metrics may be measured
 * per stage — e.g. a script stage has no video metrics). `passed`
 * is true when every *measured* metric meets its threshold.
 */
export interface QualityReport {
  /** Composite score 0..1 (weighted sum, falling). `). */
  composite: number;
  /** Per-metric readings (only includes measured ones). */
  metrics: MetricReading[];
  /** True iff every measured metric meets its threshold. */
  passed: boolean;
  /** Human-readable failure reasons (empty when passed). */
  reasons: string[];
  /** Optional classifier hint — which decision agent should pick. */
  failure_class?: FailureClass;
}

export type FailureClass =
  | 'technical'       // duration/resolution/black-frame
  | 'temporal'        // consistency / flickering / smoothness
  | 'identity'        // subject_consistency
  | 'aesthetic'       // aesthetic_quality
  | 'semantic'        // prompt_alignment
  | 'structural'     // script_completeness
  | 'sync'           // audio_sync
  ;

/** What should happen next when a stage fails. */
export type StageAction =
  | 'continue'                  // passed — move on
  | 'retry-prompt-variation'   // C: regenerate with prompt variations
  | 'retry-seed'              // try a different seed
  | 'retry-provider'          // route to another provider
  | 'fallback'                // use a degraded alternative
  | 'escalate-to-human'       // write to session, wait for human
  ;

/**
 * Stage output — every agent must return this.
 *
 * The wrapper provides typed payload access while keeping quality
 * metadata for downstream decision agents.
 */
export interface StageOutput<T> {
  payload: T;
  quality: QualityReport;
  retry_count: number;
  next_action: StageAction;
  /** When next_action is 'escalate-to-human', this is the reason. */
  human_review_reason?: string;
  /** When retried, the history of previous attempt qualities. */
  attempt_history?: QualityReport[];
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Build a single metric reading + check against threshold. */
export function reading(name: MetricName, value: MetricScore): MetricReading {
  const threshold = DEFAULT_THRESHOLDS[name];
  return { name, value, threshold, passed: value >= threshold };
}

/** Aggregate a list of readings into a QualityReport. */
export function report(
  metrics: MetricReading[],
  options: { failureClass?: FailureClass; extraReasons?: string[] } = {},
): QualityReport {
  const reasons: string[] = [];
  for (const m of metrics) {
    if (!m.passed) reasons.push(`${m.name}=${m.value.toFixed(3)} < ${m.threshold}`);
  }
  if (options.extraReasons) reasons.push(...options.extraReasons);
  const composite = compositeScore(metrics);
  const passed = metrics.every((m) => m.passed);
  const out: QualityReport = {
    composite,
    metrics,
    passed,
    reasons,
  };
  if (options.failureClass) out.failure_class = options.failureClass;
  return out;
}

/**
 * Weighted composite score. Only measured metrics contribute; missing
 * metrics are ignored (not penalised).
 */
export function compositeScore(metrics: MetricReading[]): number {
  let num = 0;
  let denom = 0;
  for (const m of metrics) {
    const w = DEFAULT_WEIGHTS[m.name] ?? 0;
    if (w === 0) continue;
    num += m.value * w;
    denom += w;
  }
  if (denom === 0) return 0;
  return num / denom;
}

/** Pass-or-fail shortcut for quickGate-style paths. */
export function passedOnly(metrics: MetricReading[]): boolean {
  return metrics.every((m) => m.passed);
}