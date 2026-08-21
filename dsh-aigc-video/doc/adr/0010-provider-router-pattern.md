# ADR-0010: Provider Router over Direct Dispatch

- **Status**: Accepted (v3.5)
- **Date**: 2026-08

## Context

AIGC video is moving from "single provider" to "best-of-breed per shot":
- Hailuo v2: cheap, fast, but soft subject consistency
- Kling Element Library: hard subject lock, but slower + more expensive
- Seedance 12-file multi-modal: best of both, newest
- Veo 2: best cinematic quality, Google-only

If `creative_pipeline.ts` had a hardcoded `this.video = new HailuoVideoProvider(...)`,
swapping providers would require touching every consumer. Worse: writing
"try Hailuo first, fall back to Kling" requires duplicating retry logic in
every call site.

## Decision

A **`ProviderRouter` class** wraps multiple `VideoProvider` instances and
implements the same `VideoProvider` interface — it's a transparent proxy.

```typescript
const router = new ProviderRouter({
  providers: [hailuo, kling],
  strategy: 'priority', // or 'round-robin' / 'first-success'
});
// router is itself a VideoProvider — drops into any consumer unchanged.
const pipe = new CreativePipeline(router as VideoProvider, ...);
```

Three strategies cover the realistic load patterns:
- `priority` — fall back on quota/network (most common)
- `round-robin` — split quota across providers
- `first-success` — race for fastest (lowest latency at the cost of N× quota)

The `taskId` returned to the caller is **namespaced** (`hailuo:abc123`),
so `router.poll()` can route back to the right backend.

## Consequences

**Positive**:
- Future Kling/Veo/Seedance integrations = add to `providers: [...]` array,
  no business code changes
- `getAttemptLog()` gives operators an audit trail for debugging
- `first-success` strategy gives "lowest latency wins" semantics for users
  who pay for speed

**Negative**:
- Doesn't cancel the loser providers on `first-success` (no shared
  cancellation channel at this layer) — they continue in the background,
  user pays the quota for whichever providers actually submitted
- ProviderError `kind` discrimination needs to be carefully maintained
  (`'quota_exceeded'` is recoverable; `'bad_request'` is not)

**Mitigations**:
- The cancellation limitation is documented in the doc comment for
  `submitFirstSuccess`
- `isRecoverable()` keeps the recover-vs-fail decision explicit (one line
  to add new kinds)
- Router emits `RouterAttemptLog[]` so operators can see who got hit