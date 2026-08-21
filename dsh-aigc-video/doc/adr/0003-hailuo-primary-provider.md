# ADR-0003: Hailuo v2 as Primary Video Provider

- **Status**: Accepted (v3.0)
- **Date**: 2026-07

## Context

The video-generation stage has three realistic options on MiniMax's stack:
- **Hailuo v1** (`MiniMax-Hailuo-2.3`) — flat payload, file_id workflow, 5 statuses
- **Hailuo v2 / H3** (`MiniMax-H3`) — multimodal `content[]` array, 6 statuses, direct URL
- **Hailuo-2.3-Fast** — cheaper, lower quality

We needed a single default that balances quality vs reliability vs cost.

## Decision

Default to **`MiniMax-Hailuo-2.3`** (v1 API) for the first cut. Rationale:
- v1 is the most battle-tested endpoint (longest in production)
- 5-status model is simpler to reason about
- File-ID download-via-`/v1/files/retrieve` is well-documented
- Reference-image support (`first_frame_image` / `reference_image`) is stable

Expose the model as `input.model` so callers can swap to H3 later without code
changes (v3.4 prep work).

## Consequences

**Positive**:
- Most Hailuo docs and StackOverflow answers cover v1
- Failure modes are well-understood (e.g., 2056 = quota exhausted)
- Easy to swap models via config

**Negative**:
- v1's `reference_image` is a SOFT signal — multi-shot subject consistency drifts
- No native xfade / cinematic presets
- 6s/10s duration limits mean a 60s script needs 4-6 shots → 4-6 quota

**Mitigations**:
- Subject consistency v3.3 (identity hint in prompt + first_frame anchor)
- Pipeline decomposes into N shots automatically (no manual work)
- Future: Provider Router (v3.5) lets users swap to Kling/Veo for hard lock