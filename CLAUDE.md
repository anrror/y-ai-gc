# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working on this repository.

## Project Overview

**dsh-aigc-video** is a **DSH plugin** (DeepSeek Harness) implementing a 7-stage AI video generation pipeline:

```
script_generation → character_design → storyboard → reference_generation → video_generation → voice_generation → post_production
```

Plus video mixing (混剪), smart editing (智剪), voice dubbing (配音), and an end-to-end **md script → N Hailuo clips** workflow (脚本 → 视频).

This repository is the **single source of truth** for AIGC-Claw. The v3 implementation lives entirely in `dsh-aigc-video/`. **There is no Python backend or Next.js frontend** — those were the v1/v2 implementations and have been removed from the workspace (still visible in git history for archaeology).

## Repository Layout

```
y-ai-gc/
├── README.md            # project overview (v3 only — DSH plugin)
├── CLAUDE.md            # this file
├── AGENTS.md            # AI assistant guidance (any agent)
├── .gitignore
├── doc/                 # design docs (v3 only)
│   ├── 4-DSH插件架构设计.md
│   └── 4-Rust重构与混剪智剪设计.md
└── dsh-aigc-video/      # the ONLY code — DSH plugin (TypeScript)
    ├── README.md        # plugin's full docs (~400 lines)
    ├── AGENTS.md        # plugin-scoped AI guidance
    ├── src/
    │   ├── index.ts                          # apply(ctx) — registers 6 tools + spawns HTTP server
    │   ├── framework/streaming.ts            # SSEEvent (NDJSON wire format)
    │   ├── providers/                        # LLM/Image/Video/VLM/TTS clients
    │   ├── pipeline/                         # StateMachine + SessionManager + Orchestrator
    │   ├── agents/                           # 7 stage agents (script → voice → editor)
    │   ├── workflow/                         # creative script → N clips (Phase 5.5)
    │   ├── video/                            # ffmpeg mixing (8 transitions, xfade fallback)
    │   ├── audio/                            # scene_detect / vad / beats
    │   ├── smart/                            # align / score / decide
    │   ├── http/                             # 12-endpoint Node http server (port 8000)
    │   └── tools/                            # 6 model-facing tool wrappers
    ├── bin/                # creative-to-video.mjs CLI
    ├── scripts/            # dry-run-fox-script.mjs
    ├── tests/              # 38 vitest tests across 9 files
    ├── smoke.mjs           # Phase 2 end-to-end Hailuo v1 smoke
    ├── smoke-http.mjs      # Phase 8 HTTP smoke (no real API)
    ├── config.yaml         # provider config
    └── cordis.patch.yml    # DSH plugin patch
```

## Commands

All development happens inside `dsh-aigc-video/`.

```bash
cd dsh-aigc-video

npm install
npm run typecheck     # tsc --noEmit
npm run build         # outputs dist/
npm test              # vitest (38 tests across 9 files)

# Smoke tests
node smoke.mjs                       # Hailuo v1 end-to-end (consumes 1 quota)
node smoke-http.mjs                  # 12/12 HTTP endpoints (no real API)

# Creative workflow CLI
node bin/creative-to-video.mjs D:/down/fox.md --dry-run     # preview only
MINIMAX_API_KEY=... node bin/creative-to-video.mjs D:/down/fox.md --max-shots 6  # real run
```

## Architecture (v3 DSH plugin)

**6 model-facing tools** registered by `apply(ctx)`:

| Tool | What it does |
|---|---|
| `aigc_video_generate` | Single-clip Hailuo v1/v2 generation |
| `aigc_mix` | 8 transitions + BGM + SRT (ffmpeg subprocess) |
| `aigc_smart_edit` | Scene-detect + VAD + Jaccard alignment + scoring + **beat-aligned cuts (bgm_path, Phase 7)** |
| `aigc_pipeline_run` | End-to-end 7-stage orchestrator |
| `aigc_creative_to_video` | md script → N Hailuo clips (Phase 5.5) |
| `aigc_voice_dub` | Per-shot voice generation (MiniMax Speech 2.8) |

**12 HTTP endpoints** (plugin spawns its own `node:http` on port 8000):
- `GET /api/health`
- `GET /api/stages`
- `POST /api/project/create`
- `POST /api/project/start`
- `GET /api/project/{id}`
- `GET /api/project/{id}/status`
- `GET /api/project/{id}/artifact/{stage}`
- `POST /api/project/{id}/execute/{stage}`
- `POST /api/project/{id}/intervene`
- `POST /api/project/{id}/continue`
- `POST /api/creative/render` (Phase 5.5)
- `POST /api/voice_dub` (v3.1)

**7 stage agents** (all extend `BaseAgent`):
- `ScriptWriterAgent` (LLM) → logline + beat sheet + script
- `CharacterDesignerAgent` (LLM) → character list + traits + voice_id per character
- `StoryboardAgent` (LLM) → shot list (index/duration/visual_prompt)
- `ReferenceGeneratorAgent` (Image) → first-frame images
- `VideoDirectorAgent` (Video) → MP4 clips (max 6 shots/run)
- `VoiceDirectorAgent` (TTS) → per-shot MP3 voice tracks (v3.1)
- `EditorAgent` (LLM) → SRT captions + edit decisions

**5 workflow modules** (Phase 5.5 creative workflow — no LLM needed):
- `camera_moves.ts` — 15 MiniMax bracket instructions + verb→move rule
- `script_parser.ts` — md script → { title, characters, setting, acts }
- `shot_decomposer.ts` — acts → shots (one per direction, duration snaps to 6s or 10s)
- `prompt_builder.ts` — shot + script → English Hailuo prompt + [指令]
- `creative_pipeline.ts` — end-to-end orchestrator (parse → submit → poll → download)

## Configuration

`dsh-aigc-video/config.yaml` (project root or CWD):

```yaml
server:
  host: 127.0.0.1
  port: 8000
session:
  data_dir: code/data
pipeline:
  video_provider: hailuo-2.3
  planner_enabled: false
  planner_model: isigning-llm
  tts_provider: hailuo-tts
providers:
  hailuo-2.3:
    api_key: ${MINIMAX_API_KEY}
    base_url: https://api.minimaxi.com
    model_name: MiniMax-Hailuo-2.3
    concurrency: 3
  hailuo-tts:
    api_key: ${MINIMAX_API_KEY}
    base_url: https://api.minimaxi.com
    model_name: speech-2.8-hd
    concurrency: 4
  minimax-llm:
    api_key: ${MINIMAX_API_KEY}
    base_url: https://api.minimaxi.com/v1
    model_name: abab6.5s-chat
    concurrency: 1
```

`${VAR}` is expanded from `process.env` at lookup time. Plugin loads `config.yaml` lazily on first tool call.

Both `models:` and `providers:` keys are accepted (Python backend used `models:`; canonicalised to `providers:`).

## Key Constraints

1. **Hailuo-2.3 only accepts duration 6s or 10s** — `shot_decomposer.estimateDuration()` snaps to the nearest valid value.
2. **PowerShell `Start-Process` mangles non-ASCII args** — copy script to ASCII path (`fox.md`) or pass via stdin.
3. **DSH runtime lacks `ctx.http.mount`** — the plugin spawns its own `node:http` server inside `apply()` as a workaround. Set `AIGC_HTTP_DISABLED=1` to skip.
4. **Node ≥ 22.15** (per DSH baseline); **ffmpeg/ffprobe required** on PATH for Phase 5/6/7 functionality.

## DSH Runtime Integration

```bash
# Once DSH runtime is available
dsh plugin add ./dsh-aigc-video
pnpm dsh web --patch ./dsh-aigc-video/cordis.patch.yml
```

Expected DSH startup log:
```
[dsh-aigc-video] plugin loaded; tools registered: aigc_video_generate, aigc_mix, aigc_smart_edit, aigc_pipeline_run, aigc_creative_to_video, aigc_voice_dub
[dsh-aigc-video] HTTP server listening on http://127.0.0.1:8000 (12 endpoints)
```

## Documentation Map

| File | Purpose |
|---|---|
| `README.md` | Top-level project overview |
| `AGENTS.md` | AI assistant guidance (any agent) |
| `CLAUDE.md` | Claude Code specific guidance (this file) |
| `dsh-aigc-video/README.md` | Plugin full docs (~400 lines) |
| `dsh-aigc-video/AGENTS.md` | Plugin-scoped AI guidance |
| `doc/4-DSH插件架构设计.md` | v3 DSH architecture design |
| `doc/4-Rust重构与混剪智剪设计.md` | Rust re-architecture proposal |