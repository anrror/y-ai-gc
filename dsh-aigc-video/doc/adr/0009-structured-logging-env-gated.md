# ADR-0009: Structured JSON Logging via Env Var

- **Status**: Accepted (v3.5)
- **Date**: 2026-08

## Context

Production observability needs structured logs (Loki / Datadog / Vector ingest
JSON Lines). Local dev needs human-readable text. Two output modes, one
code path. A runtime env var lets the same binary serve both:

- `AIGC_STRUCTURED_LOGS=1` → JSON Lines to stdout/stderr
- unset (or =0) → `[HH:MM:SS] [INFO] msg` human-readable

## Decision

`src/util/structured_log.ts` checks the env var **on every call** (not
cached at module load — tests need to toggle it mid-run).

```typescript
export function logStructured(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const structured = isStructuredLoggingEnabled();
  if (structured) {
    // write JSON to stdout (info) or stderr (warn/error)
    process.stdout.write(JSON.stringify({ts, level, session_id: SESSION_ID, msg, ...fields}) + '\n');
  } else {
    // write human-readable to stdout (info) or stderr (warn/error)
    process.stdout.write(`[${formatTs()}] [${level.toUpperCase()}] ${msg} ${JSON.stringify(fields)}\n`);
  }
}
```

`session_id` is a process-stable id so all log lines from one run correlate.

## Consequences

**Positive**:
- Zero code changes for users — they just set the env var
- Same spy-friendly surface for tests (we mock `process.stdout.write`)
- Session id correlates lines across stdout + stderr

**Negative**:
- Reading env var on every call is a tiny perf hit (negligible — 1 syscall)
- Not cached means tests can flip the env var mid-run and observe the change

**Mitigations**:
- All log calls go through `logStructured` → switching output is one env var
- Future: structured log fields include `phase`, `shot_index`, `provider`
  automatically (v3.6 backlog)