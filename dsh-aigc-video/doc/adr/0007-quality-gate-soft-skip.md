# ADR-0007: Quality Gate Soft-Skip on probe_unavailable

- **Status**: Accepted (v3.3 fix, fb7debb)
- **Date**: 2026-08

## Context

`src/video/quality_gate.ts` runs `ffprobe` to verify duration, resolution,
and black-frame ratio of downloaded clips. Real-world failure scenario:

- User runs pipeline without `ffmpeg` installed (typical dev machine)
- `execFile(ffprobe, ...)` throws ENOENT
- Code catches the error and marks clip as `probe_failed`
- `creative_pipeline` interprets that as a HARD failure → excludes the
  clip from `shots_succeeded`
- User sees `0/4 succeeded` even though 3 valid MP4s sit on disk

This was a major UX bug surfaced in real testing.

## Decision

Detect the **missing-tool case** (ENOENT / "not found" / "not recognized")
and treat it as a **SOFT skip**, not a failure:

```typescript
if (code === 'ENOENT' || /ENOENT|no such file|not found|not recognized/i.test(msg)) {
  result.reasons.push('probe_unavailable');
  return result; // ok stays true
}
```

Other probe failures (bad metadata, codec-incompatible) still mark the
clip as failed.

## Consequences

**Positive**:
- Real test: 3 successful MP4s were reported as "0/4 succeeded" → fixed to
  "3/4 succeeded, probe skipped"
- Single-line regression test prevents future re-introduction
- Backwards-compatible: hard failures still surface

**Negative**:
- We can't run quality metrics without ffprobe — but the user gets a clear
  console warning telling them to `winget install ffmpeg`
- A truly broken video file (zero bytes, corrupt header) won't be detected
  — but `checkClipQuality`'s size check (≥1 KB) catches that

**Mitigations**:
- `quality_gate.ts` comment explains the soft-vs-hard distinction
- `tests/quality_gate.test.ts` has 5 tests including "ffprobe unavailable →
  ok=true + probe_unavailable"