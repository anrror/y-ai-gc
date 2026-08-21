# ADR-0006: DSH Plugin Abstraction

- **Status**: Accepted (v3.0)
- **Date**: 2026-07

## Context

DSH (DeepSeek Harness) is an in-house runtime that registers plugins and
exposes them as tools to LLM agents. We could have built a standalone CLI /
HTTP service / desktop app instead.

The DSH approach gives us:
- Free installation via `npm i @deepseek-ai/cordis` + plugin registration
- LLM agent can call `aigc_creative_to_video` tool from inside a chat
- No need to build a web UI for v1

The downside: requires DSH to be installed, which limits reach.

## Decision

We are a **DSH plugin first**, CLI second.

- `src/index.ts` calls `apply(ctx)` to register 6 tools + HTTP server
- `bin/creative-to-video.mjs` is a thin wrapper for users who don't use DSH
- HTTP server (`http/server.ts`) provides 12 endpoints for external integrations

The same code paths serve all three interfaces (DSH / CLI / HTTP) — no
forking of business logic.

## Consequences

**Positive**:
- 6 DSH tools + CLI + HTTP from one codebase → DRY
- Plugin auto-loads when DSH restarts → no install scripts
- LLM agents can compose our tools with others (e.g., script → voice → translate)

**Negative**:
- Tied to DSH versioning (breaks if cordis renames interfaces)
- README confuses some users — they think this is "another video gen tool" when
  it's specifically a DSH plugin
- `ctx.http.mount` is missing in current DSH → we self-host `node:http` (workaround)

**Mitigations**:
- v3.4 README rewrite (commit 655dbe9) explicitly positions the project as
  "DSH plugin / TypeScript tool for AI engineers" — not a generic video gen tool
- `node:http` self-host is a single-line workaround that's well-isolated
- CLI gives users an escape hatch from DSH dependency