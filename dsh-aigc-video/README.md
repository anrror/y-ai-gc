# dsh-aigc-video

**DSH plugin** (DeepSeek Harness) — a 7-stage AI video generation pipeline that turns a Chinese markdown script into a fully voiced, mixed, and edited final MP4.

```
script.md → 角色场景 → 分镜 → 参考图 → 视频片段 → 配音 → 后期剪辑 → final.mp4
```

Built on the **MiniMax** stack: text generation (LLM), image (wan/jimeng), video (Hailuo-2.3 / Hailuo H3), and **Speech 2.8-hd / Turbo** TTS. Plus standalone sub-products: 视频混剪 (`aigc_mix`), 智剪 (`aigc_smart_edit`), 创意脚本→视频 (`aigc_creative_to_video`), 配音 (`aigc_voice_dub`).

## Quality engineering

Output quality is **a first-class concern**, not an afterthought. The pipeline ships with a closed-loop quality layer in `src/quality/` that runs metrics at every stage and retries with prompt variation when gates fail. See **[§4 Quality Engineering](#4-quality-engineering)** for the full design.

---

## 1. Quick start

```bash
cd dsh-aigc-video
npm install
npm run build

# 38/38 → 129/129 tests
npm test

# Dry run (no API quota)
node bin/creative-to-video.mjs D:/down/fox.md --dry-run --max-shots 4

# Real end-to-end (consumes quota)
MINIMAX_API_KEY=... node bin/creative-to-video.mjs D:/down/fox.md --dub --max-shots 6

# Optional BGM track
MINIMAX_API_KEY=... node bin/creative-to-video.mjs D:/down/fox.md --dub --bgm music.mp3 --max-shots 6

# Quality report from the audit log
node bin/quality-report.mjs
node bin/quality-report.mjs --json
```

---

## 2. Architecture (DDD)

The codebase is organized by **bounded contexts** along domain seams, not by file type:

```
src/
├── quality/             # Quality Engineering context — gates + retry + audit (see §4)
├── providers/           # External service adapters (Hailuo, MiniMax, OpenAI, Wan, …)
├── pipeline/            # State machine + SessionManager + Orchestrator
├── agents/              # 7 stage agents (one per state transition)
├── workflow/            # Creative workflow (md → N clips, no LLM) + end-to-end orchestrator
├── video/               # ffmpeg mixer + transitions + quality gate (legacy P0-4)
├── audio/               # scene_detect / vad / beats / transcribe
├── smart/               # align / score / decide (smart_edit pipeline)
├── http/                # 12-endpoint HTTP server
└── tools/               # 6 model-facing DSH tool wrappers
```

Each context owns its types and has a public API; cross-context communication goes through domain events, not by reaching into private internals. See [§5 Type design](#5-type-design) for the layered QualityReport pattern.

### 2.1 7-stage pipeline

| # | Stage | Agent | Provider | Output |
|---|---|---|---|---|
| 1 | `script_generation` | `ScriptWriterAgent` (LLM) | `isigning-llm` / `minimax-llm` | logline + beats + script |
| 2 | `character_design` | `CharacterDesignerAgent` (LLM) | `isigning-llm` | characters + voice_id per character |
| 3 | `storyboard` | `StoryboardAgent` (LLM) | `isigning-llm` | shots (index/duration/visual_prompt) |
| 4 | `reference_generation` | `ReferenceGeneratorAgent` (Image) | `wan` | first-frame images per character |
| 5 | `video_generation` | `VideoDirectorAgent` (Video) | `hailuo-2.3` | MP4 clips per shot |
| 6 | `voice_generation` | `VoiceDirectorAgent` (TTS) | `hailuo-tts` (MiniMax Speech 2.8) | MP3 voice tracks |
| 7 | `post_production` | `EditorAgent` (LLM) + ffmpeg | `isigning-llm` + ffmpeg | SRT + EditDecision + muxed MP4 |

State machine persists to `code/data/sessions/{id}.json` after every transition — 9-stop-point workflows can resume after crash.

### 2.2 6 model-facing tools

| Tool | Stage | Provider | Function |
|---|---|---|---|
| `aigc_video_generate` | 3 | video | single-clip Hailuo v1/v2 |
| `aigc_mix` | 5 | ffmpeg | 8 transitions + BGM + SRT burn-in |
| `aigc_smart_edit` | 6 | ffmpeg | scene-detect + VAD + Jaccard align + beat sync |
| `aigc_pipeline_run` | 4 | llm + image + video + tts | full 7-stage orchestrator |
| `aigc_creative_to_video` | 5.5 | video | md script → N Hailuo clips (no LLM) |
| `aigc_voice_dub` | 5.5 | tts | per-shot voice generation (MiniMax Speech 2.8) |

### 2.3 12 HTTP endpoints

```
GET  /api/health
GET  /api/stages
POST /api/project/create
POST /api/project/start
GET  /api/project/{id}
GET  /api/project/{id}/status
GET  /api/project/{id}/artifact/{stage}
POST /api/project/{id}/execute/{stage}        (NDJSON streaming)
POST /api/project/{id}/intervene
POST /api/project/{id}/continue
POST /api/creative/render                     (md script → N clips)
POST /api/voice_dub                           (script + chars → N voice tracks)
```

---

## 3. End-to-end workflow (`bin/creative-to-video.mjs`)

`--dub` flag enables the full **md → final.mp4** chain:

```
parse md → CreativePipeline (Hailuo N clips)
         → rule-based voice assignment (voice_rules.ts — zero LLM)
         → MiniMax T2A v2 (speech-2.8-hd)
         → write SRT (srt.ts — HH:MM:SS,mmm)
         → VideoMixer (concat + xfade + voice tracks + BGM + SRT burn-in)
         → final.mp4
```

**Voice assignment rules** (Chinese-name heuristic, no LLM):
| Input | voice_id |
|---|---|
| 少女 / 机灵 / 萌 | `female-shaonv` |
| 御姐 / 女王 | `female-yujie` |
| 熊 / 憨 / 老实 | `male-qn-qingse` |
| 精英 / 商务 / 总裁 | `male-qn-jingying` |
| 粤语 + 女 | `Cantonese_GentleLady` |
| 用户显式 `voice_id` | 覆盖规则（支持 cloned voice） |

---

## 4. Quality Engineering

Quality is **not an afterthought** — it's a first-class concern with its own bounded context (`src/quality/`).

### 4.1 The closed-loop pattern

```
[generate] ──▶ [gate] ──▶ metric below threshold?
                            │
                yes ──▶ [Decision Agent] → retry / fallback / escalate
                            │
                            └─▶ [Variation Engine] ──▶ 3-5 prompt variants
                                                            │
                            ┌─── best by composite score ◀────┘
                            ▼
                        [final gate] → QualityReport
```

Three layers of feedback:

| Layer | Timeframe | Scope |
|---|---|---|
| **L0 micro-loop** | real-time | technical failures → immediate strategy swap |
| **L1 per-shot** | one shot | composite gate → variation retry (≤2 retries, respects quota) |
| **L2 end-to-end** | whole final.mp4 | aggregate pass-rate ≥80% → escalate-to-human |

### 4.2 Module map

```
src/quality/
├── contract.ts          # QualityReport / MetricReading / StageAction contract
├── decision.ts          # Decision Agent — rule-based, fallback/continue/retry/escalate
├── variation.ts         # Prompt Variation Engine — 5 strategies + tournament select
├── retry.ts              # qualityAwareGenerate — A+B+C combined
├── pipeline.ts          # QualityPipeline.quickGate — ffprobe + blackdetect + freezedetect + silencedetect
├── subject_consistency.ts  # subject_consistency gate (sidecar + local fallback)
└── end_to_end_gate.ts   # per-shot gate + final composite gate + aggregateShotReports
```

### 4.3 The unified contract (`src/quality/contract.ts`)

```typescript
export interface QualityReport {
  composite: number;        // 0..1 weighted sum
  metrics: MetricReading[];
  passed: boolean;
  reasons: string[];
  failure_class?: 'technical' | 'temporal' | 'identity' | 'aesthetic'
                | 'semantic' | 'structural' | 'sync';
}

export interface StageOutput<T> {
  payload: T;
  quality: QualityReport;
  retry_count: number;
  next_action: 'continue' | 'retry-prompt-variation' | 'retry-seed'
             | 'retry-provider' | 'fallback' | 'escalate-to-human';
}
```

Every stage returns this — no exceptions. The contract is the **DDD aggregate root** of the Quality context.

### 4.4 The Decision Agent (`src/quality/decision.ts`)

Pure rule-based dispatch on the worst failed metric:

| Failed metric | Action | Variant hint |
|---|---|---|
| `subject_consistency` | `retry-prompt-variation` (or `retry-provider` if alt available) | `reference-emphasis` |
| `temporal_flickering` / `temporal_consistency` / `motion_smoothness` | `retry-seed` | — |
| `aesthetic_quality` | `retry-provider` (early) → `retry-prompt-variation` | `add-style` |
| `prompt_alignment` | `retry-prompt-variation` | `longer` |
| `duration_ok` / `resolution_ok` / `black_frame_ratio` | `fallback` (no retry) | — |
| `script_completeness` / `audio_sync` | `escalate-to-human` (auto-fix unavailable) | — |
| retry budget exhausted | `escalate-to-human` | — |

### 4.5 The Prompt Variation Engine (`src/quality/variation.ts`)

Given a failed shot, generates **2–5 prompt variants** and selects the best by composite score via **pairwise tournament** (O(N log N)):

| Strategy | Adds |
|---|---|
| `reference-emphasis` | "Reference identity: preserve exact face, clothing, and body shape…" |
| `simpler` | "Concise: subject + action only" |
| `longer` | "Detailed scene context: lighting, environment" |
| `add-style` | "Aesthetic direction: cinematic, well-lit, harmonious colours" |
| `add-camera` | "Camera direction: [Push in]" |

Inspired by **VISTA** (CVPR 2026) and **U-Gen Adaptive Prompt Rewriting** — see [doc/5-AIGC竞品分析与优化路线.md](doc/5-AIGC竞品分析与优化路线.md) for the full research background.

### 4.6 Per-stage metrics (VBench-lite)

| Metric | Threshold | Default weight | Source |
|---|---|---|---|
| `duration_ok` | ≥0.5 (binary) | 0.05 | ffprobe |
| `resolution_ok` | ≥0.5 (binary) | 0.05 | ffprobe |
| `black_frame_ratio` | ≥0.5 | 0.10 | ffmpeg `blackdetect` |
| `temporal_flickering` | ≥0.85 | 0.10 | ffmpeg `freezedetect` |
| `motion_smoothness` | ≥0.80 | 0.05 | reserved (motion interp model) |
| `subject_consistency` | ≥0.65 | **0.20** | sidecar DINO/ArcFace + local pHash fallback |
| `temporal_consistency` | ≥0.85 | 0.15 | sidecar CLIP |
| `aesthetic_quality` | ≥0.45 | 0.10 | sidecar LAION aesthetic |
| `prompt_alignment` | ≥0.25 | 0.15 | sidecar BLIP-BLEU (NOT CLIP-Score — ρ=6.3 only per EvalCrafter) |
| `audio_sync` | ≥0.90 | 0.10 | ffmpeg `silencedetect` |
| `script_completeness` | ≥0.60 | 0.05 | reserved (5-act heuristic) |

Subject consistency is the **heaviest weight (0.20)** because it's the most important dimension for series / character consistency — exactly the lever that drove Kling Element Library, Seedance 12-file multi-modal, and Wan multi-reference designs in the competitor landscape.

### 4.7 Audit log + reporting

Every shot gate decision is appended to `code/quality/<session>.jsonl`:

```jsonl
{"ts":"2026-08-20T...","session_id":"s1","shot_index":1,"decision":"retry-prompt-variation","attempt":0,"composite":0.42,"passed":false,"reasons":["subject_consistency=0.4 < 0.65"]}
{"ts":"2026-08-20T...","session_id":"s1","shot_index":1,"decision":"continue","attempt":1,"composite":0.91,"passed":true,"reasons":[]}
```

`bin/quality-report.mjs` aggregates across sessions:

```
───── quality report ─────
sessions:       3
attempts:       47
passed:         38
failed:         9
pass rate:      80.9%
composite min:  0.41
composite max:  0.97
composite mean: 0.83

top failure reasons:
     12  subject_consistency=0.4 < 0.65
      5  aesthetic_quality=0.3 < 0.45

decisions:
     22  continue
      9  retry-prompt-variation
      3  retry-seed
      1  escalate-to-human
```

### 4.8 Sidecar contract (Python reference implementation)

The `subject_consistency` gate and `prompt_alignment`/`aesthetic_quality` deep gates delegate to a Python sidecar (DINOv2 + ArcFace + LAION aesthetic + BLIP-BLEU). Contract:

```
POST /subject_consistency
Body:    { clip_path: string, reference_path?: string }
200:    { score: 0..1, details?: { frame_count, mean_cosine, reference_cosine } }
Timeout: 30s
```

If no sidecar is configured, the local pHash fallback runs (zero dep). The fallback is a **soft signal** — any score <0.7 should be escalated.

---

## 5. Type design (DDD aggregate)

```typescript
// Bounded context: Quality Engineering
// Aggregate root: QualityReport
//   - composite (weighted metric sum)
//   - metrics (Map<MetricName, MetricReading>)
//   - passed (derived from metrics)
//   - failure_class (categorises failure for decision routing)
//   - reasons (human-readable failure list)

// Entity: StageOutput<T>
//   - payload (T — stage-specific result)
//   - quality (QualityReport)
//   - retry_count, next_action, human_review_reason

// Value object: MetricReading
//   - name (MetricName enum, 11 values)
//   - value (0..1)
//   - threshold (default from contract)
//   - passed (derived from value >= threshold)

// Domain service: Decision Agent
//   - decide(DecisionContext) → Decision
//   - pure rule-based, deterministic

// Domain service: Variation Engine
//   - buildVariants(prompt, n, hint) → Array<{ prompt, strategy }>
//   - variationLoop(...) → VariationLoopResult (bounded concurrency, O(N log N) tournament)

// Application service: qualityAwareGenerate
//   - glues Decision + Variation + quickGate
//   - returns StageOutput<QualityReport>

// Repository: AuditLog (append-only JSONL)
//   - appendAuditLine(logPath, AuditEntry)
```

The aggregate boundary is enforced by type signatures: `StageOutput<T>` requires `quality: QualityReport`, so no stage can return a result without running a gate.

---

## 6. Provider abstraction

Each external service is hidden behind an interface:

```
LLMProvider   (OpenAI-compatible base + 7 vendor subclasses: DeepSeek/Qwen/GLM/Kimi/Isigning/Minimax)
ImageProvider (Wan/Jimeng/Seedream stubs)
VideoProvider (Hailuo v1 + v2 — supports `first_frame_image`, `reference_image`, etc.)
TtsProvider   (MiniMax T2A v2 + voice clone)
VlmProvider   (Qwen-VL/Gemini-VL stubs)
```

`createLLMProvider(alias, cfg)` / `createVideoProvider(...)` / `createTtsProvider(...)` — add a vendor = 1 new file + 1 switch case.

Provider errors are classified into 5 kinds via `ProviderError` (`src/providers/base.ts`):

```
quota_exceeded   → abort run immediately (Hailuo 2056)
transient        → retry with exponential backoff
bad_request      → log + skip (don't retry)
cancelled        → propagate (don't retry)
network / unknown → wrap + retry once
```

---

## 7. Cost control

`src/cost/estimator.ts` pre-computes a `RunEstimate` (USD + Token Plan credits) before any API call lands:

```typescript
estimateRunCost({ shots: 6, duration_per_shot_sec: 6, tts_chars: 200 })
// → { breakdown: { video_usd: 3.02, image_usd: 0, tts_usd: 0.01, total_usd: 3.03 }, ... }
```

The CLI prints both **pre-submit** and **post-run** estimates so the user knows the budget before any quota burns.

---

## 8. Configuration

`config.yaml` (project root or CWD):

```yaml
server:
  host: "127.0.0.1"
  port: 8000
session:
  data_dir: "code/data"
pipeline:
  video_provider: "hailuo-2.3"
  tts_provider: "hailuo-tts"          # v3.1
  planner_model: "isigning-llm"
providers:
  hailuo-2.3:   { api_key: "${MINIMAX_API_KEY}",  base_url: "https://api.minimaxi.com",  concurrency: 3, model_name: "MiniMax-Hailuo-2.3" }
  hailuo-tts:   { api_key: "${MINIMAX_API_KEY}",  base_url: "https://api.minimaxi.com",  concurrency: 4, model_name: "speech-2.8-hd" }
  isigning-llm: { api_key: "${ISIGNING_API_KEY}", base_url: "https://prod-ai.isigning.cn/v1", concurrency: 5, model_name: "Qwen3.6-..." }
  wan:          { api_key: "${DASHSCOPE_API_KEY}", base_url: "https://dashscope.aliyuncs.com/api/v1", concurrency: 2, model_name: "wanx-v1" }
```

`${VAR}` is expanded from `process.env` at lookup time. Both `models:` and `providers:` keys are accepted (canonicalised to `providers:`).

---

## 9. Known limitations

1. **ffmpeg not bundled** — install via `winget install ffmpeg`. The plugin auto-detects `@ffmpeg-installer/ffmpeg`; falls back to plain concat if the binary lacks `xfade` (pre-4.3).
2. **Whisper @xenova/transformers** — installed via `optionalDependencies`; if missing, smart_edit falls back to scene-detect + VAD + script-match.
3. **Reference generation needs `DASHSCOPE_API_KEY`** — `wan` (DashScope wanx-v1) for first-frame reference images.
4. **LLM stages need a working LLM key** — `isigning-llm` default; `minimax-llm` works only on Token Plan tiers that include LLM.
5. **Hailuo-2.3 only accepts 6s/10s** — `shot_decomposer.estimateDuration()` snaps to nearest legal value.
6. **Token Plan Max quota is finite** — MiniMax returns `status_code=2056` when exhausted. Quality layer's `quota_exceeded` action aborts the run cleanly.
7. **PowerShell `Start-Process` mangles non-ASCII args** — use ASCII paths (`fox.md`) or stdin.
8. **Subject consistency in production requires Python sidecar** — local pHash fallback is a soft signal only.

---

## 10. Testing & observability

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | clean |
| Build | `npm run build` | clean (dist/) |
| Unit tests | `npm test` | **129/129 across 19 files** |
| Real CLI smoke | `node bin/creative-to-video.mjs D:/down/fox.md --dry-run` | estimate output verified |
| Real run with placeholder key | `node bin/creative-to-video.mjs ... --max-shots 1` | 1004 error grade verified |
| Quality report | `node bin/quality-report.mjs` | per-session composite + top failures |
| JSONL audit | `cat code/quality/s1.jsonl` | append-only, per-shot |

---

## 11. License

MIT.