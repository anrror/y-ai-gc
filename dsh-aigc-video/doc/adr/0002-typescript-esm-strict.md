# ADR-0002: TypeScript ESM Strict Mode

- **Status**: Accepted (v3.0)
- **Date**: 2026-07

## Context

DSH (DeepSeek Harness) runtime is Node 22 with native ESM. We needed a
language + module system that:
1. Compiles-time-checks the API boundaries between contexts (per ADR-0001)
2. Plays well with ESM imports / top-level await
3. Doesn't require a runtime like Babel (Node-native)
4. Forces explicit handling of `undefined` / `null`

## Decision

- **TypeScript** with `"strict": true`, `"noImplicitAny": true`,
  `"strictNullChecks": true`, `"noUncheckedIndexedAccess": true`
- **ESM** (`.mts` / `.ts` compiled to ESM output, `"type": "module"` in package.json)
- **Vitest** for tests (ESM-native, no Jest config gymnastics)

The cost is occasional `as unknown as Provider` casts in test files (we use
typed mock providers in `tests/helpers/mock_providers.ts` to avoid this).

## Consequences

**Positive**:
- `npm run build` catches contract breaks at compile time, not runtime
- ESM `import.meta.url` is the modern way to resolve paths relative to the
  current file
- Vitest's `expect()` is so much nicer than Jest's

**Negative**:
- `as unknown as T` casts are still needed in a handful of mock tests (acceptable)
- ESM has subtle gotchas: e.g., `__dirname` doesn't exist (must reconstruct via
  `fileURLToPath(import.meta.url)`)
- Some npm packages still don't ship ESM; we accept these as devDependencies only

**Mitigations**:
- The `as unknown as` casts are quarantined to `tests/helpers/mock_providers.ts`
  and friends — production code has zero such casts (verified by grep)
- Type errors in v3.5 refactors (e.g., `dirname` missing after import cleanup)
  caught every issue at build time