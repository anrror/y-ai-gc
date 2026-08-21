# 🎬 dsh-aigc-video

**DSH 插件** —— TypeScript 端到端 AI 视频生成管线，把"剧本 markdown + 参考图"压缩成一条命令产出 `final.mp4`。

```text
剧本 (md) → 角色 → 分镜 → 参考图 → 视频(Hailuo) → 配音(TTS) → 后期 → final.mp4
                              │
                              └── quality engineering: gate + variation + audit
```

> **🎯 给谁用**：AI 工程师 / prompt 工程师 / DSH 生态开发者。  
> 你需要懂 TypeScript、Node.js ≥22、有命令行习惯、有 API key。  
> **❌ 不是**：面向普通创作者的低代码平台、零基础可用工具、SaaS 产品。

## 你拿到什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 7 阶段管线 | ✅ | script → character → storyboard → reference → video → voice → post |
| 主体一致性（参考图） | ✅ | first_frame + identity hint 文本双重提示 |
| 配音（TTS） | ✅ | MiniMax Speech 2.8，11 模型21+ 内联标签 |
| 字幕（dialog/act-title/auto） | ✅ | 无对白剧本也能烧字幕 |
| 默认 final.mp4 | ✅ | ffmpeg 缺失时降级 manifest.json |
| 进度可见 | ✅ | 4 phase + 时间戳 + 进度条 + ETA + 5s 心跳 |
| 质量工程层（v3.2） | ✅ | QualityReport + Decision Agent + Variation + Audit |
| Python sidecar（v3.3） | ✅ | DINOv2 + ArcFace 主体一致性 ML 评分 |
| **Web 控制台 / Provider Router** | ❌ | P1，未实现 |

## Quick start

```powershell
# 一次性准备
git clone ... && cd y-ai-gc\dsh-aigc-video
npm install
npm run build

# 可选: 装 ffmpeg 让 final.mp4 真的产出 (默认产物已包含 manifest.json)
winget install ffmpeg

# Dry run (不消耗 quota, 验证 pipeline 跑得通)
node bin\creative-to-video.mjs code\result\jb.md --dry-run --max-shots 4

# 真实 e2e (消耗 Hailuo quota)
$env:MINIMAX_API_KEY = "..."  # 必需
node bin\creative-to-video.mjs script.md --dub --max-shots 6 --reference face.jpg
```

→ 完整命令、API、架构见 [`dsh-aigc-video/README.md`](dsh-aigc-video/README.md)。

## 这是 / 不是

| ✅ 这是 | ❌ 不是 |
|---|---|
| DSH 插件 / TypeScript ESM 严格模式 | SaaS 产品 |
| 给有技术背景的工程师用 | 普通创作者零代码工具 |
| 把 5 步串成一条命令 | 把 5 步隐藏起来（暴露更多控制） |
| Hailuo 软约束 + 你自己处理 prompt 质量 | 黑盒 AI 一键成片 |
| 跑在你自己机器上 / 你自己 quota | 云端共享 quota |
| npm 包 / 自我托管 | 订阅制 |

---

## 目录

- [1. 产品设计](#1-产品设计)
- [2. 技术实现](#2-技术实现)
- [3. 质量工程](#3-质量工程)
- [4. 项目结构](#4-项目结构)
- [5. 快速开始](#5-快速开始)
- [6. 配置](#6-配置)
- [7. 测试与验证](#7-测试与验证)
- [8. 已知限制](#8-已知限制)
- [9. 实施状态](#9-实施状态)
- [10. 文档索引](#10-文档索引)
- [11. 历史版本](#11-历史版本)

---

## 1. 产品设计

### 1.1 解决什么问题

**面向 DSH 生态 / AI 工程师**：你写 markdown 剧本、丢几张参考图、敲一行命令 → 拿到一堆 Hailuo MP4 + 拼接好的 final.mp4 + 质量审计报告。

**不是**面向"普通创作者"的零代码工具——用户必须自己拥有：
- Node.js ≥ 22
- Hailuo API key (`MINIMAX_API_KEY`)
- 基础命令行 + 调试能力

dsh-aigc-video 把五步串成一条自动化管线，由单个 md 文件驱动。**进一步**：质量不可控是 AIGC 内容生成的根问题——同一 prompt 不同次生成的差异巨大（"unreliably good"）。本项目把质量工程做成**一等公民**：每阶段都有质量契约、失败自动变体重试、端到端 composite gate、审计日志与报告 CLI。

### 1.2 用户入口（两种路径）

| 入口 | 流程 | Token 成本 |
|---|---|---|
| **A. md 剧本**（创意工作流） | 解析 md → 拆解镜头 → 分配运镜 → 构建 Hailuo-2.3 英文 prompt → 逐个提交/轮询/下载。CLI：`bin/creative-to-video.mjs --dub --bgm music.mp3` | 1 Hailuo token / 镜头 + 配音 |
| **B. 一句话创意**（管线路径） | 7 个 LLM + 图像 + 视频 + TTS agent 依次执行，9 个干预点等待用户确认 | 视频 token / 镜头 + 图像 token / 参考图 + TTS 字符包 / 台词 |

### 1.3 产品优势

- **单一产物、单一 token 预算**。用户只需管理一个 `.md` 文件；所有中间产物持久化在 `code/result/...`，HTTP API 可随时取回。
- **无 LLM 供应商锁定**。每个 agent 声明自己需要的 provider（`llm` / `image` / `video` / `tts`），orchestrator 自动跳过缺失 provider 的阶段——半配置也能跑。
- **OpenClaw / dsh-shell 无缝兼容**。插件 HTTP API 与 Python AIGC-Claw 后端契约 1:1 对齐。
- **纯规则创意路径**。`aigc_creative_to_video` 完全不需要 LLM：解析 md、动词启发式选运镜、构建英文 prompt——在不含 LLM 的 Token Plan 档位也能工作。
- **一个 TTS API，多种声音**。MiniMax Speech 2.8 支持 8 种情绪 × 21+ 内联标签 × 300+ 系统音色 × 音色复刻 × 音色混合。
- **质量工程闭环**（**v3.2 新增**）。每阶段 QualityReport → Decision Agent → Prompt Variation → tournament 选最佳。失败不阻塞流程，但坏片绝不进入 final.mp4。

### 1.4 7 阶段管线（v3.1）

```
script_generation  →  character_design  →  storyboard  →  reference_generation
                                                              ↓
                                                       video_generation
                                                              ↓
                                                       voice_generation  ← 新增（配音）
                                                              ↓
                                                       post_production
                                                              ↓
                                                         final.mp4
```

每阶段都有**质量契约**（详见 §3）：11 个指标（duration/resolution/black-frame/temporal_flickering/motion_smoothness/subject_consistency/temporal_consistency/aesthetic/prompt_alignment/audio_sync/script_completeness）的加权 composite score 控制是否进入下一阶段。

### 1.5 配音（v3.1 新增）

`aigc_voice_dub` 读取脚本 + 分镜 + 角色列表（含 voice_id），然后：

1. 调 LLM 决定每句**谁来说、什么情绪、什么语速、哪里停顿**（`<#x#>` 标记），并插入**内联情绪标签**（`(laughs)`、`(sighs)` 等）；
2. 逐句提交 MiniMax T2A v2（`POST /v1/t2a_v2`），使用指定 `voice_id`；
3. 下载每个合成 MP3 到 `code/result/voice/<session>/shot_NNN_<character>.mp3`；
4. 后期剪辑阶段把这些音频轨与对应视频片段合成。

**MiniMax Speech 2.8 TTS 能力**（官方文档核验）：

| 能力 | 说明 |
|---|---|
| 模型 | `speech-2.8-hd` / `speech-2.8-turbo` / 2.6 / 02 / 01 系列共 7 个 |
| 情绪 | 8 种 + 21+ 内联标签（仅 2.8）|
| 系统音色 | 300+（中/英/日/粤/阿/俄…）|
| 音色复刻 | `POST /v1/voice_clone`（10s–5min 参考音频）|
| 音色混合 | 最多 4 个音色按权重混合 |
| 发音字典 | 拼音/IPA/粤语拼音 |
| 停顿控制 | 内联 `<#x#>` |
| 字幕生成 | sentence / word / word_streaming |
| 声音特效 | spacious_echo / auditorium_echo / lofi_telephone / robotic |
| 语言 | 36 种 |
| 格式 | mp3 / pcm / flac / wav / pcmu_raw / pcmu_wav / opus |

---

## 2. 技术实现

### 2.1 架构总览（v3 DSH 插件 + DDD 分层）

```
dsh-aigc-video/
├── src/
│   ├── index.ts                       # apply(ctx) — 注册 6 个 tool + 自启 HTTP server
│   ├── framework/streaming.ts         # SSEEvent（NDJSON）
│   ├── quality/                       # ★ 质量工程上下文（详见 §3）
│   │   ├── contract.ts                # QualityReport / StageOutput 契约
│   │   ├── decision.ts                # Decision Agent
│   │   ├── variation.ts               # Prompt Variation Engine
│   │   ├── retry.ts                   # qualityAwareGenerate (A+B+C 联合)
│   │   ├── pipeline.ts                # QualityPipeline.quickGate
│   │   ├── subject_consistency.ts     # subject_consistency 门禁
│   │   └── end_to_end_gate.ts         # per-shot gate + final composite gate + audit
│   ├── providers/                     # 全部模型 API 客户端（DDD: 防腐层 / 适配器）
│   ├── pipeline/                      # 状态机核心
│   ├── agents/                        # 7 个阶段 agent
│   ├── workflow/                      # 创意工作流 + 端到端 orchestrator
│   ├── video/                         # ffmpeg 混剪（8 转场 + xfade fallback）
│   ├── audio/                         # 场景检测 / VAD / 节拍检测 / Whisper
│   ├── smart/                         # 对齐 / 评分 / 剪辑决策
│   ├── http/server.ts                 # 12 端点 Node http server
│   ├── tools/                         # 6 个 model-facing tool 包装
│   ├── cost/estimator.ts              # 成本估算（USD + Token Plan credits）
│   └── providers/base.ts              # ProviderError（5 kind 错误分级）+ withProviderRetry
├── bin/                                # creative-to-video.mjs + quality-report.mjs
├── tests/                              # 129 tests / 19 files
└── config.yaml
```

### 2.2 6 个 model-facing tools

| Tool | 阶段 | Provider 依赖 | 功能 |
|---|---|---|---|
| `aigc_video_generate` | 3 | video | 单镜头 Hailuo v1/v2 生成 |
| `aigc_mix` | 5 | ffmpeg | 8 转场 + BGM + SRT 烧录 |
| `aigc_smart_edit` | 6 | ffmpeg | 场景检测 + VAD + Jaccard 对齐 + 评分 + 节拍对齐剪辑 |
| `aigc_pipeline_run` | 4 | llm + image + video + tts | 完整 7 阶段编排器 |
| `aigc_creative_to_video` | 5.5 | video | md 剧本 → N 个 Hailuo 片段（零 LLM）|
| `aigc_voice_dub` | 5.5 | tts | 逐镜头配音（MiniMax Speech 2.8）|

### 2.3 12 个 HTTP 端点

```
GET  /api/health
GET  /api/stages
POST /api/project/create
POST /api/project/start
GET  /api/project/{id}
GET  /api/project/{id}/status
GET /api/project/{id}/artifact/{stage}
POST /api/project/{id}/execute/{stage}        (NDJSON 流式)
POST /api/project/{id}/intervene
POST /api/project/{id}/continue
POST /api/creative/render                     (md 剧本 → N 片段)
POST /api/voice_dub                           (脚本 + 角色 → N 配音轨)
```

### 2.4 端到端工作流（`bin/creative-to-video.mjs --dub`）

```
md 解析 → CreativePipeline（Hailuo 视频） → 规则化 voice 分配 → MiniMax T2A v2
       → 写 SRT → VideoMixer（含独立 voice tracks + BGM + xfade + SRT 烧录）→ final.mp4
```

**零 LLM 的 voice 分配规则**（中文名启发式）：

| 输入 | voice_id |
|---|---|
| 少女/机灵/萌 | `female-shaonv` |
| 御姐/女王 | `female-yujie` |
| 熊/憨/老实 | `male-qn-qingse` |
| 精英/商务/总裁 | `male-qn-jingying` |
| 粤语+女 | `Cantonese_GentleLady` |
| 用户显式 `voice_id` | 覆盖规则（支持 cloned voice）|

### 2.5 技术优势

| 设计决策 | 为什么 |
|---|---|
| **全程 TypeScript ESM + 严格模式** | DSH 运行时是 Node 22 ESM；严格类型在 agent/tool/provider 边界提供编译期保证 |
| **Provider 抽象接口** | 换 MiniMax → OpenAI / Anthropic / ElevenLabs / Azure Speech 无需改任何 agent 代码 |
| **状态机 + 原子 JSON 会话** | 崩溃 / 9 停点工作流可恢复；`code/data/sessions/{id}.json` 可往返 |
| **纯规则创意路径** | 不含 LLM 的 Token Plan 档位可用；运镜、英文 prompt、转场时机全部由 md + 动词启发式计算 |
| **xfade 降级到纯拼接** | `FfmpegRunner.hasXfade()` 构造时探测 ffmpeg filter 列表；2018 老 ffmpeg 自动降级硬切，4.3+ 用平滑交叉淡化 |
| **Provider 错误分级** | `ProviderError` 5 kind（quota_exceeded/transient/bad_request/cancelled/network/unknown）+ `withProviderRetry` 退避；quota 硬中止不消耗重试预算 |
| **参考图回填（v3 P0-1）** | Hailuo v2 的 `first_frame` + `reference_image` role 在 video_director 自动接入角色身份图 |
| **成本估算（v3 P0-3）** | 提交前输出 USD + Token Plan credits；CLI pre/post 双打印 |
| **质量门禁（v3 P0-4）** | ffprobe + blackdetect + freezedetect 探测；不达标保留磁盘但标记失败 |
| **Whisper 转写（v3 P0-5）** | `@xenova/transformers` 懒加载接入 smart_edit；optional dep 失败时静默降级 |
| **★ Prompt Variation Engine（v3.2）** | 失败自动 2-5 变体生成 + tournament 选最佳——从"单次赌运气"到"采样+选择" |
| **★ QualityReport 契约（v3.2）** | 11 维度 + 加权 composite + 失败分类（technical/temporal/identity/aesthetic/semantic/structural/sync）|
| **★ Decision Agent（v3.2）** | 失败原因 → next_action 路由表；exhaust budget → escalate-to-human |
| **★ 端到端 audit log** | `code/quality/<session>.jsonl` append-only；`bin/quality-report.mjs` 聚合 |

---

## 3. 质量工程（v3.2 核心新增）

> 调研参考：[doc/5-AIGC竞品分析与优化路线.md](doc/5-AIGC竞品分析与优化路线.md)、[doc/6-质量工程设计.md](doc/6-质量工程设计.md)

### 3.1 为什么需要

AIGC 视频生成的输出**不可靠地好**（"unreliably good"）——同一 prompt 不同次生成差异巨大。需要把质量从"事后检查"提升为"设计阶段的契约 + 循环中的约束"。

### 3.2 三层反馈环

| 层级 | 时间 | 范围 | 机制 |
|---|---|---|---|
| **L0 微闭环** | 实时 | 技术缺陷 | 黑帧/时长/格式异常 → 立即换 strategy |
| **L1 per-shot** | 一镜头 | composite 失败 | Decision → Variation 2-5 变体 → tournament 选最佳（≤2 retries）|
| **L2 端到端** | 整 final.mp4 | composite < 阈值 | aggregateShotReports ≥80% pass → escalate-to-human |

### 3.3 11 维质量指标（VBench-lite）

| 指标 | 度量什么 | 阈值 | 来源 |
|---|---|---|---|
| `duration_ok` | 时长合规 ±20% | 0.5+ | ffprobe |
| `resolution_ok` | 分辨率 ≥ 360×360 | 0.5+ | ffprobe |
| `black_frame_ratio` | 黑帧占比 | 0.5+ | ffmpeg blackdetect |
| `temporal_flickering` | 帧间闪烁 | 0.85+ | ffmpeg freezedetect |
| `subject_consistency` | **跨镜头角色一致性**（核心）| 0.65+ | DINO/ArcFace sidecar + pHash fallback |
| `temporal_consistency` | 背景/场景一致性 | 0.85+ | CLIP 跨帧余弦 |
| `aesthetic_quality` | 审美质量 | 0.45+ | LAION aesthetic predictor |
| `prompt_alignment` | 文-图对齐 | 0.25+ | BLIP-BLEU（**不用 CLIP-Score — ρ=6.3 太低**）|
| `motion_smoothness` | 运动平滑 | 0.80+ | 帧插值模型 |
| `audio_sync` | 音画同步 | 0.90+ | ffmpeg silencedetect |
| `script_completeness` | 剧本完整度 | 0.60+ | 5-act 启发式 |

**subject_consistency 权重最高（0.20）**——是 Kling Element Library、Seedance 12-file multi-modal、Wan multi-reference 共同的设计杠杆。

### 3.4 Decision Agent 决策表

| 失败指标 | next_action | 变体 hint |
|---|---|---|
| `subject_consistency` | `retry-prompt-variation` | `reference-emphasis` |
| `temporal_flickering` / `temporal_consistency` | `retry-seed` | — |
| `aesthetic_quality` | `retry-provider` → `retry-prompt-variation` | `add-style` |
| `prompt_alignment` | `retry-prompt-variation` | `longer` |
| `duration_ok` / `resolution_ok` / `black_frame_ratio` | `fallback`（不重试）| — |
| `script_completeness` / `audio_sync` | `escalate-to-human` | — |
| retry budget 用尽 | `escalate-to-human` | — |

### 3.5 Prompt Variation Engine 5 策略

| 策略 | 添加内容 |
|---|---|
| `reference-emphasis` | "Reference identity: preserve exact face, clothing, body shape..." |
| `simpler` | "Concise: subject + action only" |
| `longer` | "Detailed scene context: lighting, environment" |
| `add-style` | "Aesthetic direction: cinematic, well-lit, harmonious colours" |
| `add-camera` | "Camera direction: [Push in]" |

借鉴 **VISTA** (CVPR 2026)、**SCMAPR**、**U-Gen Adaptive Prompt Rewriting**。选择方式：**pairwise tournament** O(N log N).

### 3.6 监控与审计

每个 session 的每镜头决策都写入 `code/quality/<session>.jsonl`：

```
{"ts":"...","session_id":"s1","shot_index":1,"decision":"retry-prompt-variation","attempt":0,"composite":0.42,"passed":false,"reasons":["subject_consistency=0.4 < 0.65"]}
```

`bin/quality-report.mjs` 聚合：

```
───── quality report ─────
sessions:       3
attempts:       47
passed:         38
failed:         9
pass rate:      80.9%
composite mean: 0.83

top failure reasons:
     12  subject_consistency=0.4 < 0.65
      5  aesthetic_quality=0.3 < 0.45

decisions:
     22  continue
      9  retry-prompt-variation
```

---

## 4. 项目结构

```
E:\code\ai\y-ai-gc/
├── README.md                              ← 本文件
├── AGENTS.md                              ← AI 助手指引
├── CLAUDE.md                              ← Claude Code 开发指引
├── .gitignore
│
├── doc/                                   ← 设计文档
│   ├── 4-DSH插件架构设计.md
│   ├── 4-Rust重构与混剪智剪设计.md
│   ├── 5-AIGC竞品分析与优化路线.md        ← 竞品调研
│   └── 6-质量工程设计.md                  ← 质量工程方案设计
│
└── dsh-aigc-video/                        ← DSH 插件（当前唯一实现）
    ├── README.md                          ← 插件完整文档（命令/API/架构）
    ├── AGENTS.md                          ← 插件 AI 助手指引
    ├── package.json
    ├── src/                               ← 见 §2.1
    ├── bin/
    │   ├── creative-to-video.mjs          ← CLI: md → final.mp4
    │   └── quality-report.mjs             ← CLI: 质量报告聚合
    ├── scripts/
    ├── tests/                              ← 129 tests / 19 files
    ├── smoke.mjs / smoke-http.mjs
    ├── config.yaml                         ← provider 配置
    └── cordis.patch.yml                    ← DSH 插件 patch
```

---

## 5. 快速开始

```bash
cd dsh-aigc-video
npm install
npm run build

# 跑测试
npm test                                   # 129/129 全绿

# 冒烟
node smoke.mjs                             # Hailuo v1 端到端（消耗 1 token）
node smoke-http.mjs                        # 12/12 HTTP 端点（不消耗 API）
node bin/creative-to-video.mjs D:/down/fox.md --dry-run   # 干跑预览
node scripts/dry-run-fox-script.mjs        # 创意工作流干跑

# 创意工作流 CLI（干跑 → 真实）
node bin/creative-to-video.mjs D:/down/fox.md --dry-run --max-shots 4
MINIMAX_API_KEY=... node bin/creative-to-video.mjs D:/down/fox.md --max-shots 6
MINIMAX_API_KEY=... node bin/creative-to-video.mjs D:/down/fox.md --dub --bgm music.mp3 --max-shots 6

# 质量报告
node bin/quality-report.mjs
node bin/quality-report.mjs --json
```

---

## 6. 配置

```powershell
# API keys（按需）
$env:MINIMAX_API_KEY   = "..."   # Hailuo 视频 + Speech 2.8（必需）
$env:DASHSCOPE_API_KEY  = "..."  # Wan 图像（可选）
$env:ISIGNING_API_KEY   = "..."  # LLM provider（可选）

# ffmpeg（视频混剪需要）
winget install ffmpeg
```

`config.yaml`（项目根或 CWD）—— `${VAR}` 从环境变量展开：

```yaml
server:
  host: "127.0.0.1"
  port: 8000
session:
  data_dir: "code/data"
pipeline:
  video_provider: "hailuo-2.3"
  tts_provider: "hailuo-tts"
  planner_model: "isigning-llm"
providers:
  hailuo-2.3:   { api_key: "${MINIMAX_API_KEY}",  base_url: "https://api.minimaxi.com",  concurrency: 3, model_name: "MiniMax-Hailuo-2.3" }
  hailuo-tts:   { api_key: "${MINIMAX_API_KEY}",  base_url: "https://api.minimaxi.com",  concurrency: 4, model_name: "speech-2.8-hd" }
  isigning-llm: { api_key: "${ISIGNING_API_KEY}", base_url: "https://prod-ai.isigning.cn/v1", concurrency: 5, model_name: "Qwen3.6-..." }
  wan:          { api_key: "${DASHSCOPE_API_KEY}", base_url: "https://dashscope.aliyuncs.com/api/v1", concurrency: 2, model_name: "wanx-v1" }
```

---

## 7. 测试与验证

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ tsc --noEmit clean |
| 构建 | `npm run build` | ✅ dist/ |
| 单元测试 | `npm test` | ✅ **129/129**（19 files）|
| npm 打包 | `npm pack` | ✅ 85.1 kB / 143 files |
| 冒烟 | `node smoke.mjs` | ✅ Hailuo v1 端到端（79.9s 成功）|
| Dry-run | `node bin/creative-to-video.mjs D:/down/fox.md --dry-run` | ✅ estimate `$3.36 / 3360 tokens` |
| 真实端到端（占位 key） | `node bin/creative-to-video.mjs ... --max-shots 1` | ✅ 1004 错误分级触发 |
| 质量报告 | `node bin/quality-report.mjs` | ✅ sessions / attempts / pass-rate |

---

## 8. 已知限制

1. **ffmpeg 不打包**——需自行安装（`winget install ffmpeg`）；老版本（<4.3 无 xfade）自动降级纯拼接。
2. **Whisper 转写**（v3 P0-5）—— `@xenova/transformers` 为 optional dep；缺失时 smart_edit fallback。
3. **reference_generation 需要 `DASHSCOPE_API_KEY`**——`wan`（通义 wanx-v1）。
4. **LLM 阶段需要可用的 LLM key**——默认 `isigning-llm`。
5. **Hailuo-2.3 只接受 6s/10s 时长**——`shot_decomposer.estimateDuration()` 自动吸附。
6. **Token Plan Max 配额有限**——耗尽返回 `status_code=2056`；质量层 `quota_exceeded` action 立即 abort。
7. **PowerShell `Start-Process` 传中文路径会 mojibake**——用 ASCII 路径。
8. **subject_consistency 生产级需要 Python sidecar**——本地 pHash fallback 是软信号。
9. **DSH `ctx.http.mount` 缺失**——插件自启 `node:http`（workaround）。

---

## 9. 实施状态（对照设计文档）

| Phase | 范围 | 状态 |
|---|---|---|
| 1 | 插件骨架 | ✅ |
| 2 | Providers | ✅ MiniMax v1/v2 + Speech 2.8 + Qwen-VL |
| 3 | `aigc_video_generate` | ✅ |
| 4 | 7 阶段管线 | ✅ |
| 5 | 视频混剪 | ✅ |
| 5.5 | 创意脚本 → N 片段 | ✅ 零 LLM |
| 5.5b | **配音**（v3.1） | ✅ |
| 6 | 智剪 | ✅ |
| 7 | 节拍同步 + BGM | ✅ |
| 8 | HTTP server | ✅ |
| 9 | 测试 + 文档 | ✅ **129 tests / 19 files** |
| **P0-1** | **参考图回填** | ✅ |
| **P0-2** | **错误分级** | ✅ |
| **P0-3** | **成本估算** | ✅ |
| **P0-4** | **质量门禁轻量版** | ✅ |
| **P0-5** | **Whisper 转写** | ✅ |
| **★ 质量工程 v3.2** | **QualityReport + Decision + Variation + Audit** | ✅ |
| 10 | npm 发布 + dsh-shell 集成 | 🟡 `npm pack` 已验证 |

---

## 10. 文档索引

| 文件 | 说明 |
|------|------|
| [README.md](README.md) | 本文件：项目全局概览 |
| [dsh-aigc-video/README.md](dsh-aigc-video/README.md) | 插件完整文档（命令/API/架构）|
| [AGENTS.md](AGENTS.md) | 项目级 AI 助手指引 |
| [CLAUDE.md](CLAUDE.md) | Claude Code 开发指引 |
| [doc/4-DSH插件架构设计.md](doc/4-DSH插件架构设计.md) | DSH 插件架构设计 v3 |
| [doc/4-Rust重构与混剪智剪设计.md](doc/4-Rust重构与混剪智剪设计.md) | Rust 重构方案 |
| [doc/5-AIGC竞品分析与优化路线.md](doc/5-AIGC竞品分析与优化路线.md) | 竞品调研 |
| [doc/6-质量工程设计.md](doc/6-质量工程设计.md) | 质量工程方案设计 |

---

## 11. 历史版本

- **v1（已删）**：`aigc-director/aigc-claw/` Python FastAPI + Next.js
- **v2（已删）**：残留在 git 历史中（commit `075528c` 之前）
- **v3.0（基线）**：`dsh-aigc-video/` DSH plugin
- **v3.1**：加入配音（7 阶段）+ P0 优化
- **v3.2（当前）**：加入完整质量工程（QualityReport + Decision + Variation + Audit）

---

## 技术栈

- **后端运行时**：Node.js ≥ 22.15
- **DSH 框架**：`@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools`
- **HTTP server**：Node `node:http` 内置
- **视频处理**：`ffmpeg` 子进程
- **语音合成**：MiniMax Speech 2.8
- **测试**：vitest（**129 tests / 19 files**）
- **构建**：TypeScript `tsc`（ESM, strict, DDD 分层）

## 许可证

MIT.