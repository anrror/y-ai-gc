# ADR-0001: DDD Layered Bounded Contexts

- **Status**: Accepted (v3.0)
- **Date**: 2026-07 (initial), refined through v3.4

## Context

The codebase grew organically from a 7-stage pipeline (script → character → storyboard
→ reference → video → voice → post). Each stage touches external APIs (LLM, image,
video, TTS) and has its own quality concerns. Without explicit boundaries, modules
tend to drift toward "the kitchen sink" — every module imports from every other,
and refactoring becomes a guessing game.

## Decision

We adopted **DDD-inspired layered bounded contexts**:

```
┌───────────────────────────────────────────────────────┐
│  Presentation: bin/, http/server.ts, tools/            │  (entry points)
├───────────────────────────────────────────────────────┤
│  Application:  workflow/, quality/                     │  (orchestration)
├───────────────────────────────────────────────────────┤
│  Domain:       providers/, video/mixer.ts,             │  (business rules)
│               quality/contract.ts                      │
├───────────────────────────────────────────────────────┤
│  Infrastructure: providers/base.ts, providers/config.ts │  (cross-cutting)
│                  cost/estimator.ts, util/               │
└───────────────────────────────────────────────────────┘
```

- Dependencies flow **downward only** (presentation → application → domain → infra)
- Each context has a clear public API; private internals are not exported
- Cross-context communication uses **typed events**, not reach-in imports

## Consequences

**Positive**:
- v3.4 refactor pulled composition out of `creative_pipeline.ts` into `composer.ts`
  without touching any consumer — proof the layering works
- Adding `provider_router.ts` (v3.5) only needed an interface in `domain/`,
  no application layer changes
- Test boundaries are obvious: unit-test domain in isolation, integration-test
  the application layer

**Negative**:
- Some duplication (e.g., types re-exported across contexts)
- New contributors must learn the layer rules; otherwise they bypass them and
  the layering degrades

**Mitigations**:
- `src/workflow/composer.ts` exists specifically because we hit the "composition
  concern leaking into generation concern" anti-pattern in v3.3
- ESLint rule `no-restricted-imports` could enforce layer boundaries (P3 backlog)