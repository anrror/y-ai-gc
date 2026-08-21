# ADR-0005: first_frame Anchor + Identity Hint

- **Status**: Accepted (v3.3)
- **Date**: 2026-08

## Context

Hailuo v2's `reference_image` role is a **SOFT** signal. When you pass 3
reference images, the model averages / picks one — but doesn't hard-lock
identity across distant shots. Real-world test: 4 shots generated from a
script with 3 reference images produced visibly different characters.

Two failure modes were clear:
1. **Multi-reference** (3 refs) → model confused, identity drifts
3. **Single reference** (1 ref) → soft signal, drift still possible in distant shots

## Decision

Two-pronged defense:

1. **`first_frame` = references[0]** (HARD constraint — anchors every shot's
   starting frame to the reference)
2. **Drop multi-reference** entirely (log a warning) — second-and-later refs
   are silently ignored to prevent the "averaging" failure mode
3. **Identity hint** appended to every prompt:
   ```
   Maintain identical character identity throughout: same face structure,
   same outfit details, same body proportions, same hairstyle and accessories.
   ```

This re-states the constraint in text form, which empirically improves
subject consistency even when the model doesn't perfectly honor `first_frame`.

## Consequences

**Positive**:
- 1 reference image is now reliably the "subject anchor"
- Prompt-based hint reinforces identity across distant shots
- Single-line warning educates users why their 3 references aren't doing what
  they expect

**Negative**:
- Multi-reference support is intentionally **rejected** — some users want to
  blend multiple faces (no current path)
- For HARD identity lock across distant shots, only Provider Router with
  Kling Element Library / Seedance 12-file multi-modal will work (P1 backlog)

**Mitigations**:
- The hint is opt-out-able (would require a `--no-identity-hint` flag, not
  built yet — most users want it on)
- Provider Router (v3.5) is the architectural foundation for when we add
  hard-lock providers