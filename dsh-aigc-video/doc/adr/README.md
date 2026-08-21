# Architecture Decision Records (ADRs)

This directory captures the **why** behind dsh-aigc-video's architectural choices.
Each ADR follows the [Nygard template](https://github.com/joelparkerhenderson/architecture_decision_records):

- **Status**: proposed / accepted / superseded
- **Context**: the forces at play (technical, business, political)
- **Decision**: what we chose to do
- **Consequences**: trade-offs — both positive and negative

ADRs are **immutable** once accepted. To reverse a decision, write a new ADR that
supersedes the old one (don't edit history).

| # | Title | Status |
|---|---|---|
| [0001](0001-ddd-layered-bounded-contexts.md) | DDD layered bounded contexts | Accepted |
| [0002](0002-typescript-esm-strict.md) | TypeScript ESM strict mode | Accepted |
| [0003](0003-hailuo-primary-provider.md) | Hailuo v2 as primary video provider | Accepted |
| [0004](0004-parallel-shot-submission.md) | Parallel shot submission (concurrency=3) | Accepted |
| [0005](0005-first-frame-plus-identity-hint.md) | first_frame anchor + identity hint | Accepted |
| [0006](0006-dsh-plugin-abstraction.md) | DSH plugin abstraction | Accepted |
| [0007](0007-quality-gate-soft-skip.md) | Quality gate soft-skip on probe_unavailable | Accepted |
| [0008](0008-composer-abstraction.md) | Composer abstraction (DDD layering) | Accepted |
| [0009](0009-structured-logging-env-gated.md) | Structured JSON logging via env var | Accepted |
| [0010](0010-provider-router-pattern.md) | Provider Router over direct dispatch | Accepted |