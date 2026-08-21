# ADR-0008: Composer Abstraction (DDD Layering)

- **Status**: Accepted (v3.4)
- **Date**: 2026-08

## Context

In v3.3, `creative_pipeline.ts` had grown to 430 lines and contained TWO
distinct concerns:
1. **Generation**: submit → poll → download → quality gate
2. **Composition**: VideoMixer.mix() for `final.mp4` + manifest.json write

These are different bounded contexts:
- Generation = "produce N shots that match the script"
- Composition = "concatenate N shots into a playable file"

The mixing made the file hard to test (you had to mock VideoMixer just to test
generation) and violated ADR-0001's layering.

## Decision

Extract composition into a new module: **`src/workflow/composer.ts`**.

```typescript
// creative_pipeline.ts (now ~340 lines, single concern)
const composed = await composeFinalMp4({
  shots: results,
  out_dir: dirname(outDir),
  project_name: projectName,
});
finalMp4 = composed.final_mp4_path;
manifest = composed.manifest_path;

// composer.ts (new, ~140 lines, single concern)
export async function composeFinalMp4(input): Promise<ComposeResult> {
  // 1. Filter successful clips
  // 2. Check ffmpeg availability
  // 3. VideoMixer.mix() with N-1 cut transitions
  // 4. Write manifest.json (always)
}
```

## Consequences

**Positive**:
- `creative_pipeline.ts` tests no longer need to mock `VideoMixer`
- Future: composition can be swapped (e.g., GPU hardware encoder) without
  touching generation code
- `EndToEndCreativePipeline` (dub path) can also call `composer.ts` —
  composes twice (bare concat + voice/BGM/SRT overwrite) without code duplication

**Negative**:
- Slight indirection — readers have to follow 2 files instead of 1
- One more import to add when extending composition logic

**Mitigations**:
- Header comment in `composer.ts` explains when to call it
- `creative_pipeline.ts` test surface is now strictly about generation
- The `composed_at` timestamp in manifest.json makes it easy to debug