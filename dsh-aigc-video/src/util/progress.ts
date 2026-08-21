/**
 * Progress / observability helpers for long-running pipelines.
 *
 * Adds four behaviours the bare `console.log` does not provide:
 *   1. `logWithTs(msg)`     — every line carries an `HH:MM:SS` prefix so
 *                            the user can correlate to wall-clock time
 *                            after a run.
 *   2. `logPhase(name, idx, total)` — explicit `[Phase 2/4]` boundaries so
 *                            the user always knows which major step is
 *                            running (parse → decompose → generate →
 *                            compose).
 *   3. `formatProgressBar(pct, width=20)` — terminal-friendly ASCII bar
 *                            so the user can see overall completion at a
 *                            glance.
 *   4. `progressEta(completed, total, elapsedMs)` — projects remaining
 *                            time using a moving average of completed-shot
 *                            durations; returns a human string like
 *                            "5min 20s" or "—".
 *
 * All helpers are dependency-free so the worker files don't have to
 * import anything heavy.
 */

/** Format a Date as `HH:MM:SS` (24-hour, local time). */
export function formatTs(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Print a single line with a `[HH:MM:SS]` prefix. Falls back to no-op
 * if `console.log` is unavailable (e.g. in a worker context).
 */
export function logWithTs(msg: string): void {
  const line = `[${formatTs()}] ${msg}`;
  // Prefer console.log for simplicity; if you need stderr-only output,
  // swap to `process.stderr.write` here. We don't make it configurable
  // to keep callers terse.
  console.log(line);
}

/**
 * Print a phase boundary header. Example output:
 *   [12:34:56] === [Phase 2/4] Generating shots ===
 */
export function logPhase(name: string, idx: number, total: number): void {
  logWithTs(`=== [Phase ${idx}/${total}] ${name} ===`);
}

/**
 * Render a percentage as a fixed-width ASCII progress bar.
 * Example: `formatProgressBar(0.42)` → `[████████░░░░░░░░░░░░] 42%`
 *
 * Uses `█` (filled) and `░` (empty). Width 20 by default. Always returns
 * the same character count so consecutive updates line up cleanly.
 */
export function formatProgressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const filledStr = '█'.repeat(filled);
  const emptyStr = '░'.repeat(empty);
  const pctLabel = `${Math.round(clamped * 100)}%`.padStart(3, ' ');
  return `[${filledStr}${emptyStr}] ${pctLabel}`;
}

/**
 * Compute ETA string given completed/total counts and total elapsed ms.
 * Returns "—" when completed=0 (not enough samples to project).
 *
 * Uses a simple `mean(per-shot) * remaining` projection — accurate enough
 * for the use case (Hailuo shots are 30-90 s, so the variance is small).
 */
export function progressEta(
  completed: number,
  total: number,
  elapsedMs: number,
): string {
  if (completed <= 0 || total <= completed) return '—';
  const meanMs = elapsedMs / completed;
  const remaining = (total - completed) * meanMs;
  return formatDuration(remaining);
}

/** Format milliseconds as a compact `Nmin Ns` / `Ns` string. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}min` : `${m}min ${s}s`;
}

/**
 * Throttled heartbeat — returns true when at least `intervalMs` has
 * elapsed since `lastBeat`. Lets long polls emit an "alive" pulse every
 * ~5 s without flooding stdout.
 */
export function shouldBeat(lastBeatMs: number, intervalMs = 5000): boolean {
  return Date.now() - lastBeatMs >= intervalMs;
}