/**
 * Structured JSON logging for production observability.
 *
 * The default logWithTs() prints human-readable lines for local dev. For
 * production / CI / log aggregation (Loki / Vector / Datadog), set
 * `AIGC_STRUCTURED_LOGS=1` to emit JSON Lines instead — one object per
 * line, easy to ingest with `jq` / Vector / Cloud Logging.
 *
 * Format:
 *   {"ts":"2026-08-21T13:56:13.412Z","level":"info","msg":"shot 1 done","shot":1,"session_id":"...","provider":"hailuo"}
 *
 * The schema is intentionally minimal — extend with custom fields via the
 * second argument (`fields`). Reserved fields: `ts`, `level`, `msg`.
 *
 * Note: STRUCTURED state is checked on every call (not cached) so tests
 * that toggle `process.env.AIGC_STRUCTURED_LOGS` mid-run observe the
 * expected behaviour. The env-read is cheap enough.
 */

import { formatTs } from './progress.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

let sessionIdCounter = 0;
/** Stable id for the current process. Used to correlate log lines
 * across a single run when structured logs are enabled. */
export const SESSION_ID = `run_${Date.now()}_${++sessionIdCounter}`;

/** Read whether structured logging is currently active. */
export function isStructuredLoggingEnabled(): boolean {
  return process.env.AIGC_STRUCTURED_LOGS === '1';
}

/** Emit one log line. Always goes to stdout (or stderr if level=error/warn
 * and STRUCTURED is on — separating error stream helps log shippers). */
export function logStructured(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const structured = isStructuredLoggingEnabled();
  if (structured) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      session_id: SESSION_ID,
      msg,
      ...fields,
    };
    const line = JSON.stringify(payload) + '\n';
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  } else {
    // Dev mode: human-readable line with timestamp. We use the same
    // process.stdout.write / process.stderr.write path as structured
    // mode (instead of console.log/console.warn) so observability tests
    // can spy on a single surface regardless of mode.
    const line = `[${formatTs()}] [${level.toUpperCase()}] ${msg}` +
      (Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '') + '\n';
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
}

/** Convenience: info-level logStructured. */
export function logInfo(msg: string, fields?: LogFields): void {
  logStructured('info', msg, fields);
}

/** Convenience: warn-level logStructured. */
export function logWarn(msg: string, fields?: LogFields): void {
  logStructured('warn', msg, fields);
}

/** Convenience: error-level logStructured. */
export function logError(msg: string, fields?: LogFields): void {
  logStructured('error', msg, fields);
}