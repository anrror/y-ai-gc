# ADR-0004: Parallel Shot Submission (concurrency=3)

- **Status**: Accepted (v3.4)
- **Date**: 2026-08

## Context

Before v3.4, `creative_pipeline.ts` submitted shots sequentially:
```typescript
for (let i = 0; i < shots.length; i++) {
  await submitAndPoll(shots[i]); // blocks until done
}
```

For a 4-shot run, this was 4 × ~60s = **240s** of wall-clock time. The Hailuo API
doesn't rate-limit by user-agent concurrency (each submit returns immediately
with a task_id; polling is async). Wasting 50% of time was the #1 wall-clock
loss in v3.3.

## Decision

Replace the serial loop with **chunked `Promise.allSettled`** at concurrency 3
(default, override-able via `input.concurrency`):

```typescript
for (let chunkStart = 0; chunkStart < shots.length; chunkStart += concurrency) {
  const settled = await Promise.allSettled(
    chunkIndices.map((j) => this._generateOneShot(shots[j]!, ...))
  );
  // process results, detect quota_exceeded → inner AbortController
}
```

Quotas are NOT shared across providers in v3.4 (single Hailuo provider); with
Provider Router (v3.5), `round-robin` strategy can split quota.

## Consequences

**Positive**:
- 4-shot run: 240s → **~80s** (3x faster)
- 12-shot run: 720s → **~260s** (~3x faster)
- Inner `AbortController` propagates quota-exceeded cancellation across all
  in-flight shots

**Negative**:
- Logs are now interleaved (3 shots log simultaneously) — slightly noisier
- Concurrency > 3 may exceed provider rate limits (Hailuo throttles around 5
  concurrent submits per account based on empirical data)

**Mitigations**:
- Progress bar shows overall % complete, easier to read than per-shot logs
- `input.concurrency` exposed for users to dial down if they hit throttling
- Quota tracking will record per-provider usage to surface throttling (v3.6)