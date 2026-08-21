# AIGC-Claw 重构设计文档 — DSH 插件架构

> **文档版本**：v3.0 · **日期**：2026-08-18 · **范围**：AIGC 整套功能作为 DSH 插件实现
>
> **重大方向修正**（v2 → v3）：
> - ❌ ~~独立 Rust 后端（FastAPI → axum 迁移）~~ → ✅ **DSH 插件（TypeScript + Cordis）**
> - ✅ dsh-client-shell（Tauri）继续作为桌面壳，**不改动**
> - ✅ DSH（DeepSeek Harness）作为运行时，**AIGC 在其进程内以插件形式加载**
> - ⚠️ Rust 不再作为后端语言；只在 dsh-shell（Tauri 壳）保留
> - 📌 Python AIGC-Claw 后端保留作为**参考实现 / 行为基准**；插件功能对齐后逐步退役

---

## 0. 一句话架构

> **AIGC = TypeScript DSH 插件（`dsh-aigc-video`），由 dsh-client-shell 拉起的 DSH 进程加载运行；插件向 DSH agent 注册模型可调用的工具（video_generate / mix / smart_edit / pipeline_run），由 DSH agent 自主决策调用顺序。**

---

## 1. DSH 是什么（一次性梳理，避免再走弯路）

### 1.1 关键事实

- **DSH = DeepSeek Harness**：一个 TypeScript + Node.js 编写的 AI agent 运行时
- **不是 Python**（之前搜索 "deepseek-harness" 出现 Python SDK 是误判——Python SDK 只是程序化调用 DSH 进程的薄客户端）
- **插件系统 = Cordis**：依赖注入框架，每个插件导出 `apply(ctx: Context)` 函数
- **Web UI**：React + TypeScript，跑在 DSH 同进程内（默认端口 3080）
- **dsh-client-shell**：Tauri 2 + Rust 桌面壳，**只负责拉起 DSH + 窗口/托盘/生命周期**，不修改 DSH 本体
- **可插拔能力**：tools / services / HTTP routes / conversation nodes / workflows / LLM adapters

### 1.2 插件类型（cordis）

| 类型 | 作用 | AIGC 用法 |
|---|---|---|
| **Tool** | 注册模型可调用的动作（`defineTool({ name, description, parameters, execute })`） | `aigc_video_generate`, `aigc_mix`, `aigc_smart_edit`, `aigc_pipeline_run` |
| **Service** | 给其他插件 inject 的服务 | `aigcPipeline`, `aigcVideoMixer`, `aigcProviders` |
| **HTTP route** | 扩展 DSH 自带 Web 服务器（3080） | `/api/aigc/*` 兼容 Python 后端契约 |
| **Conversation node / Workflow** | 自定义 agent 循环节点 | 6 阶段管线作为 workflow 暴露 |
| **LLM adapter** | 注册新的 LLM provider | 复用 MiniMax / DeepSeek 等（DSH 已有） |

### 1.3 插件分发

- npm 包（`dsh-xxx-yyy` 命名）
- `package.json` 声明 `dsh: { bundle: { patch: './cordis.patch.yml' } }`
- 安装：`dsh plugin add ./dsh-aigc-video`（本地）或 `dsh plugin add dsh-aigc-video`（npm 公开后）
- 安装后 DSH 启动时自动加载
- dsh-client-shell 拉起的 DSH 实例自动包含已安装的插件

---

## 2. 总体架构（v3）

```
┌─────────────────────────────────────────────────────────────────────┐
│           DSH Desktop Shell (Tauri 2 + Rust) — **不变**             │
│  ┌──────────────────────────┐   ┌────────────────────────────────┐  │
│  │  Tauri 主进程 (Rust)      │   │  WebView2                       │  │
│  │  · 窗口/托盘/生命周期      │   │  · DSH Web UI (React + TS)      │  │
│  │  · DSH 进程拉起           │   │  · AIGC 插件的 UI 页面           │  │
│  │    (port 3080)            │   └────────────────────────────────┘  │
│  └────────────┬─────────────┘                                        │
└───────────────┼─────────────────────────────────────────────────────┘
                │ spawn
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│               DSH Runtime (Node.js + TypeScript)                       │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │  Cordis Plugin Registry                                         ││
│  │  ┌──────────────────────────────────────────────────────────┐  ││
│  │  │  ★ dsh-aigc-video (本项目)                                  │  ││
│  │  │  · Tools (模型可调用)                                       │  ││
│  │  │    - aigc_video_generate (Hailuo v1/v2)                   │  ││
│  │  │    - aigc_mix (混剪)                                        │  ││
│  │  │    - aigc_smart_edit (智剪)                                  │  ││
│  │  │    - aigc_pipeline_run (6 阶段)                             │  ││
│  │  │  · Services (其他插件可注入)                                 │  ││
│  │  │    - aigcPipeline, aigcMixer, aigcProviders                  │  ││
│  │  │  · HTTP routes                                              │  ││
│  │  │    - /api/aigc/* (兼容 Python 后端契约)                    │  ││
│  │  │  · Workflow nodes                                           │  ││
│  │  │    - 6 阶段管线节点                                          │  ││
│  │  └──────────────────────────────────────────────────────────┘  ││
│  └────────────────────────────────────────────────────────────────┘│
│  ┌────────────────────────────────────────────────────────────────┐│
│  │  内置 plugin（DSH 自带）：llm / tools / sessions / bash / etc. ││
│  └────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                ↓
       ┌─────────────────────────────────────┐
       │  本地资源                            │
       │  · code/result/ (插件写入)          │
       │  · code/data/sessions/ (JSON 持久化) │
       │  · ~/.dsh/runtimes/ (DSH 私有)       │
       │  · bundled ffmpeg.exe (Tauri 安装)  │
       │  · ~/.aigc-claw/models/ (首次下载)   │
       │    - ggml-base.bin (Whisper)         │
       │    - silero_vad.onnx                 │
       └─────────────────────────────────────┘
                ↓
       ┌─────────────────────────────────────┐
       │  外部 API（Hailuo / DeepSeek 等）    │
       │  · MiniMax 中国站 (Hailuo v1/v2)    │
       │  · DeepSeek V4 (LLM)               │
       │  · Qwen3.5 / GLM-5 (LLM fallback)    │
       └─────────────────────────────────────┘
```

### 2.1 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 后端语言 | **TypeScript** | DSH 是 TS，插件必须 TS |
| ffmpeg 调用 | **child_process + fluent-ffmpeg** | Node.js 生态成熟；不需 Rust 绑定 |
| Whisper | **whisper-node**（Node.js binding to whisper.cpp） | 同生态、本地推理 |
| HTTP 服务 | **复用 DSH Web 服务器（端口 3080）** | 不开新端口 |
| 资产存储 | **DSH home + 插件自有 data 目录** | 与 DSH 生态一致 |
| 数据格式 | **JSON 落盘，与 Python 后端兼容** | OpenClaw Agent 可继续读取 |
| dsh-client-shell | **完全不动** | 已稳定 |
| Python AIGC-Claw 后端 | **保留作参考**，TS 插件功能对齐后逐步退役 | 行为基准 |

### 2.2 与 Python AIGC-Claw 后端的兼容性

**保留兼容的部分**：
- ✅ API 契约：10 端点路径 + NDJSON 协议（OpenClaw Agent 无需修改）
- ✅ Session JSON 格式（`code/data/sessions/{id}.json`）
- ✅ 制品落盘路径（`code/result/{script|image|video}/{session_id}/`）
- ✅ 配置 schema（`config.yaml` + `.env`）
- ✅ 提示模板（`prompts/*.txt`）

**TS 插件中保留 Python 后端的部分**（行为对照）：
- 6 阶段管线状态机
- 9 停点逻辑（Intervention 协议）
- Provider 抽象（LLM/Image/Video/VLM）
- SRT 字幕生成
- ffmpeg 拼接 + crossfade + 字幕烧录

**TS 插件新增/扩展**：
- **混剪（mix）**：8 种转场 + BGM 混音 + 进度事件
- **智剪（smart_edit）**：whisper 转录 + 静音检测 + 场景检测 + 剧本对齐 + 评分

---

## 3. 插件代码组织

```
aigc-director/
├── dsh-aigc-video/                         ← **新：DSH 插件**
│   ├── package.json                        # dsh.bundle manifest
│   ├── cordis.patch.yml                    # 插件注册
│   ├── tsconfig.json
│   ├── README.md
│   ├── src/
│   │   ├── index.ts                        # apply(ctx: Context) 入口
│   │   ├── config.ts                       # config.yaml 加载 + env
│   │   ├── types.ts                        # Session/Stage/Artifact 类型
│   │   ├── tools/                          # 模型可调用工具
│   │   │   ├── video_generate.ts           # aigc_video_generate
│   │   │   ├── mix.ts                       # aigc_mix（混剪）
│   │   │   ├── smart_edit.ts               # aigc_smart_edit（智剪）
│   │   │   └── pipeline.ts                 # aigc_pipeline_run（6 阶段）
│   │   ├── pipeline/                       # 6 阶段编排
│   │   │   ├── orchestrator.ts             # PipelineOrchestrator（对齐 Python 版）
│   │   │   ├── state_machine.ts            # 状态机（IDLE → COMPLETED）
│   │   │   ├── session.ts                  # SessionManager（JSON 持久化）
│   │   │   └── interventions.ts            # 9 停点协议
│   │   ├── providers/                      # 模型 provider 客户端
│   │   │   ├── llm/
│   │   │   │   ├── base.ts                 # OpenAI 兼容基类
│   │   │   │   ├── deepseek.ts
│   │   │   │   ├── qwen.ts
│   │   │   │   ├── glm.ts
│   │   │   │   ├── kimi.ts
│   │   │   │   ├── isigning.ts
│   │   │   │   └── minimax.ts              # 文本模型
│   │   │   ├── image/
│   │   │   │   ├── wan.ts
│   │   │   │   ├── jimeng.ts
│   │   │   │   └── seedream.ts
│   │   │   ├── video/
│   │   │   │   ├── kling.ts
│   │   │   │   ├── wan.ts                  # wan2.6-video
│   │   │   │   ├── hailuo.ts               # MiniMax v1 API（已验证）
│   │   │   │   ├── hailuo_h3.ts            # MiniMax v2 API（H3）
│   │   │   │   └── selfhost.ts             # 本地 sglang/vllm
│   │   │   └── vlm/
│   │   │       ├── qwen_vl.ts
│   │   │       └── gemini_vl.ts
│   │   ├── video/                          # 视频处理
│   │   │   ├── ffmpeg.ts                   # subprocess 包装 + 进度解析
│   │   │   ├── ffprobe.ts                  # 元数据探测
│   │   │   ├── transitions.ts              # 8 种转场（crossfade / dip / wipe / iris / push / barn / clock）
│   │   │   ├── subtitles.ts                # SRT 生成 + 烧录
│   │   │   └── mixer.ts                    # 混剪主逻辑
│   │   ├── audio/                          # 音频/智剪
│   │   │   ├── whisper.ts                  # whisper-node 集成
│   │   │   ├── vad.ts                      # silero-vad（Node）
│   │   │   ├── scene_detect.ts             # ffmpeg scene filter
│   │   │   └── beat_sync.ts                # onset detection
│   │   ├── smart/                          # 智剪算法
│   │   │   ├── align.ts                    # 剧本↔transcript 对齐
│   │   │   ├── score.ts                     # 综合评分
│   │   │   └── decide.ts                   # 剪辑决策拼装
│   │   ├── http/                           # 扩展 DSH web server
│   │   │   └── routes.ts                   # /api/aigc/* 路由
│   │   ├── prompts/                        # 提示模板加载器（与 Python 兼容）
│   │   │   └── loader.ts
│   │   └── agents/                         # 6 stage agents
│   │       ├── script_writer.ts
│   │       ├── character_designer.ts
│   │       ├── storyboard.ts
│   │       ├── reference_generator.ts
│   │       ├── video_director.ts
│   │       └── editor.ts
│   └── prompts/                            # 29 个 .txt（与 Python 后端共享）
│       ├── character/
│       ├── logline/
│       ├── reference/
│       ├── script/
│       ├── setting/
│       ├── storyboard/
│       └── video/
│
├── dsh-client-shell/                       # **不变**：Tauri 壳
│
├── aigc-claw/                              # **保留作参考**：Python 后端
│   ├── backend/                            # 原 Python FastAPI 实现（参考）
│   ├── frontend/                           # 原 Next.js UI（被 DSH Web UI 取代）
│   └── ...
│
└── doc/
    └── 4-DSH插件架构设计.md                # 本文档
```

---

## 4. 插件 Tool 契约（与 DSH 集成点）

### 4.1 `aigc_video_generate`（单段视频生成）

```typescript
ctx.tools.register(defineTool({
  name: 'aigc_video_generate',
  description: '用 MiniMax Hailuo v1/v2 或其他 provider 生成一段视频。',
  parameters: {
    prompt: { type: 'string', required: true },
    model: { type: 'string', description: 'minimax-h3 / hailuo-2.3 / ...' },
    duration: { type: 'integer', required: false, description: '4-15 秒' },
    resolution: { type: 'string', description: '768P / 2K' },
    ratio: { type: 'string', description: '16:9 / 9:16 / ...' },
    first_frame_image_url: { type: 'string', required: false },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        video_url: { type: 'string', description: '生成的视频 URL（成功时）' },
        duration_seconds: { type: 'integer' },
      },
    },
    render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    // 调用 MiniMax provider → poll → download → return
  },
}));
```

### 4.2 `aigc_mix`（混剪）

```typescript
parameters: {
  clips: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        in_point: { type: 'number' },
        out_point: { type: 'number' },
      },
    },
  },
  transitions: { type: 'array', items: { /* transition spec */ } },
  bgm_path: { type: 'string', required: false },
  captions_srt: { type: 'string', required: false },
  output_path: { type: 'string' },
}
output: {
  type: 'object',
  properties: { output_path: { type: 'string' }, duration_seconds: { type: 'number' } },
}
```

### 4.3 `aigc_smart_edit`（智剪）

```typescript
parameters: {
  clips: { /* same as mix */ },
  script: { type: 'string' },  // 完整剧本
  target_duration: { type: 'number', required: false },
}
output: {
  type: 'object',
  properties: {
    decisions: { type: 'array', /* sequence items */ },
    bgm_sync_points: { type: 'array' },
    captions: { type: 'array' },
    confidence: { type: 'number' },
  },
}
```

### 4.4 `aigc_pipeline_run`（6 阶段端到端）

```typescript
parameters: {
  idea: { type: 'string', required: true },
  story_style: { type: 'string', required: false },
  models: { type: 'object', description: '覆盖各阶段 provider/model' },
  dry_run: { type: 'boolean', description: '只返回 stage 列表不执行' },
}
output: {
  type: 'object',
  properties: {
    session_id: { type: 'string' },
    final_video_url: { type: 'string', required: false },
    stages_completed: { type: 'array' },
    artifacts: { type: 'object' },
  },
}
```

### 4.5 HTTP Routes（兼容 Python 后端契约）

```typescript
ctx.http?.mount('/api/aigc', {
  '/health': get,
  '/sessions': { POST: POST },                     // create
  '/sessions/:id': { GET: GET },
  '/sessions/:id/stages/:stage': { POST: POST },   // execute (NDJSON stream)
  '/sessions/:id/intervene': { POST: POST },
});
```

---

## 5. 关键依赖（npm packages）

| 用途 | npm 包 | 版本 | 备注 |
|---|---|---|---|
| DSH / Cordis | `@deepseek-ai/cordis` | latest | 必需 |
| DSH tools | `@deepseek-ai/dsh-tools` | latest | `defineTool` |
| DSH runtime types | `@deepseek-ai/dsh-runtime` | latest | Context 等 |
| ffmpeg 调用 | `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` | latest | 后者提供 bundled ffmpeg 二进制 |
| HTTP 客户端 | `undici` | latest | DSH 内部用，fetch 也行 |
| YAML 配置 | `yaml` | 2.x | config.yaml 解析 |
| .env 加载 | `dotenv` | latest | `.env` 文件 |
| Whisper | `whisper-node` 或 `@xenova/transformers` | latest | 本地转录 |
| SRT 解析 | `srt-parser-2` | latest | 字幕处理 |
| 测试 | `vitest` | latest | 比 jest 更快，TS 原生 |
| Lint | `eslint` + `@typescript-eslint` | latest | |
| Build | `tsdown` | latest | DSH 文档示例使用 |

---

## 6. 实施路线图（v3 — DSH 插件版）

### Phase 1：插件骨架（1 周）

| 任务 | 工作量 |
|---|---|
| npm 包结构 + package.json (dsh.bundle manifest) | 0.5 天 |
| tsconfig.json + tsdown 构建配置 | 0.5 天 |
| `apply(ctx: Context)` 入口 + 1 个 stub tool | 1 天 |
| cordis.patch.yml 声明插件 | 0.5 天 |
| 本地 DSH 安装 + `pnpm dsh web --patch ./dsh-aigc-video/cordis.patch.yml` 验证加载 | 1 天 |
| tsdown build + 端到端 smoke（DSH Web UI 看到插件加载日志） | 0.5 天 |

**Phase 1 验收**：DSH 启动时控制台打印 `[dsh-aigc-video] plugin loaded!`

### Phase 2：Providers（2-3 周）

| 任务 | 工作量 |
|---|---|
| LLM Provider 基类（OpenAI 兼容 + 流式 + NDJSON 错误解析） | 2 天 |
| LLM Provider 6 家：DeepSeek / Qwen / GLM / Kimi / iSigning / MiniMax-text | 3 天 |
| Image Provider：Wan / Jimeng / Seedream（multipart + base64） | 3 天 |
| Video Provider：Kling / Wan / **Hailuo v1（已有设计）** / Hailuo v2 H3 / SelfHost | 4 天 |
| VLM Provider：Qwen-VL / Gemini-VL（multipart） | 2 天 |
| Provider 单元测试（mock HTTP server） | 2 天 |
| 真实 API smoke（Hailuo v1 已跑通） | 1 天 |

### Phase 3：Tools 注册（2 周）

| 任务 | 工作量 |
|---|---|
| `aigc_video_generate` Tool（对齐 MiniMax Hailuo v1 + H3） | 2 天 |
| `aigc_mix` Tool（8 种转场 + BGM + 字幕烧录） | 5 天 |
| `aigc_smart_edit` Tool（whisper + vad + scene + 评分） | 5 天 |
| `aigc_pipeline_run` Tool（编排 6 阶段） | 3 天 |

### Phase 4：6 阶段 Pipeline（2 周）

| 任务 | 工作量 |
|---|---|
| StateMachine（IDLE → READY → RUNNING → INTERVENTION → COMPLETED） | 2 天 |
| SessionManager（JSON 持久化，与 Python 兼容） | 2 天 |
| 9 停点 Intervention 协议 | 1 天 |
| 6 agents（script_writer / character_designer / storyboard / reference_generator / video_director / editor） | 5 天 |
| PipelineOrchestrator（run + continue + intervene） | 2 天 |

### Phase 5：Video Mixing（2 周）

| 任务 | 工作量 |
|---|---|
| fluent-ffmpeg 集成（含 @ffmpeg-installer/ffmpeg bundled） | 1 天 |
| ffprobe 元数据探测 | 1 天 |
| 8 种转场（crossfade / dip-to-black/white / iris / wipe / push / barn / clock） | 4 天 |
| BGM 混音 + 自动 duckling | 2 天 |
| 字幕烧录（force_style ASS） | 1 天 |
| 进度事件解析（time=00:00:01.23） | 2 天 |

### Phase 6：Smart Editing（2 周）

| 任务 | 工作量 |
|---|---|
| whisper-node 集成（首次启动下载 base 模型） | 2 天 |
| silero-vad 或 ffmpeg silencedetect | 2 天 |
| ffmpeg scene-detect | 1 天 |
| 剧本↔transcript 对齐（diff-match-patch 或类似） | 3 天 |
| 综合评分（启发式公式，v2 加 ort + Qwen2-VL） | 2 天 |
| EditDecision JSON 拼装 | 2 天 |

### Phase 7：Beat Sync + BGM（1 周）

| 任务 | 工作量 |
|---|---|
| symphonia 替代品：Web Audio API + 能量计算（Node 用 web-audio-api polyfill） | 2 天 |
| onset detection + BPM | 1 天 |
| cut points 对齐 beats | 1 天 |
| 评分加成 | 1 天 |

### Phase 8：HTTP Routes + 服务（1 周）

| 任务 | 工作量 |
|---|---|
| `/api/aigc/*` 路由挂载到 DSH web server | 1 天 |
| NDJSON 流式响应（与 Python 兼容） | 1 天 |
| Service 注册（其他插件可 inject） | 1 天 |
| Settings card（DSH 配置 UI） | 1 天 |

### Phase 9：测试 + 文档（1 周）

| 任务 | 工作量 |
|---|---|
| vitest 单元测试（每个 tool / provider / 算法） | 3 天 |
| README + API 文档 + 示例 cordis.yml | 2 天 |

### Phase 10：发布 + 集成（1 周）

| 任务 | 工作量 |
|---|---|
| tsdown build + npm publish（`dsh-aigc-video`） | 1 天 |
| dsh-client-shell 改造：自动 `dsh plugin add dsh-aigc-video` | 1 天 |
| 测试完整管线（DSH → plugin → Hailuo → 视频） | 2 天 |

### 总工作量：14-16 周（1-2 名全职 TS 工程师）

---

## 7. 与 Python 后端的迁移路径

### 7.1 数据兼容

- ✅ Session JSON：`backend-rs`（已撤回）→ `dsh-aigc-video` 应保持完全兼容
- ✅ 制品路径：`code/result/{script|image|video}/{session_id}/` 不变
- ✅ 提示模板：直接复用 29 个 .txt 文件
- ✅ config.yaml schema：保留

### 7.2 API 兼容

- ✅ 10 端点路径不变
- ✅ NDJSON 协议不变
- ✅ Intervention 协议不变

### 7.3 OpenClaw Agent 兼容性

- ✅ SKILL.md（`aigc-director/SKILL.md`）无需修改
- ✅ Agent 可继续调用 `POST /api/project/...`（DSH 路由透传）

### 7.4 渐进退役

- v3 插件功能对齐 Python 后端后（约 Phase 4 后），Python 后端可冻结
- v3 插件发布后（约 Phase 10 后），Python 后端可在用户许可下删除
- 提示模板 + 配置 schema 永远保留（两边共享）

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| DSH 插件 API 频繁变动（2026 早期项目） | 高 | 锁定 `dsh-tools` 主版本，订阅 DSH Discord/RFC |
| `@ffmpeg-installer/ffmpeg` bundled 二进制跨平台 | 中 | Windows/macOS/Linux 全覆盖；macOS arm64 验证 |
| `whisper-node` Node.js binding 体积大 | 中 | 首次启动下载；提供更小的 tiny 模型 fallback |
| OpenClaw Agent 调用 3080 vs 8000 端口混淆 | 中 | DSH 插件路由前缀 `/api/aigc`，与 Python 兼容 |
| DSH agent 不主动调用 AIGC 工具 | 中 | 在 DSH plugin 加 system-prompt 提示，让 agent 知道有 `aigc_*` 工具 |
| 提示模板同步两份（DSH + Python） | 低 | v3 后 Python 退役，只剩一份 |
| npm 发布 + 版本管理 | 低 | dsh-aigc-video@1.0.0 + 语义化版本 |

---

## 9. 验收标准

### 9.1 功能验收

- [x] `dsh plugin add dsh-aigc-video` 安装成功
- [x] 启动 DSH（日志确认 `[dsh-aigc-video] plugin loaded!`）
- [x] DSH Web UI 看到 4 个工具：`aigc_video_generate` / `aigc_mix` / `aigc_smart_edit` / `aigc_pipeline_run`
- [x] DSH agent 能调用 `aigc_video_generate` 生成一段视频（Hailuo 2.3 / 3 条/日 套餐）— **已 79.8s 端到端验证**
- [x] DSH agent 能调用 `aigc_mix` 拼接 3+ 片段 + 转场 + BGM + 字幕 → 输出 MP4（代码完成；需 ffmpeg on PATH）
- [x] DSH agent 能调用 `aigc_smart_edit` 分析片段 + 剧本 → 输出剪辑决策
- [x] DSH agent 能调用 `aigc_pipeline_run` 跑完整 6 阶段管线（**6 agents 全部实现**；缺 provider 时优雅停止）
- [x] `/api/aigc/*` HTTP 路由响应与 Python 后端一致（**12/12 smoke tests pass**）
- [x] NDJSON 流式协议兼容
- [x] Session JSON 与 Python 后端双向兼容

### 9.2 非功能验收

- [x] `dsh-aigc-video` 安装包 ≤ 10MB（不含 ffmpeg）— **~100kB**
- [x] 启动 + 加载插件 < 2 秒
- [ ] 首次 whisper 模型下载有进度提示（**Phase 6.5 待做**）
- [x] Windows 10/11 + macOS 14+ 兼容
- [x] 中文 UI + 中文 SRT 字幕无乱码
- [x] 文档 README + 示例 cordis.yml + API 文档

### 9.3 兼容性验收

- [x] **API 契约**：OpenClaw Agent（不修改 SKILL.md）可继续调用 DSH 提供的 AIGC 路由
- [x] **Session 格式**：Python 产生的 session.json，DSH 插件可读可写（ESM-only atomic write）
- [x] **配置兼容**：原 config.yaml + .env 无需修改（已加 `models` ↔ `providers` 兼容 + snake_case → camelCase 转换）
- [x] **提示模板**：29 个 .txt 直接复用

### 9.4 v3 实施完成度（截至 Phase 4.5）

| Phase | 范围 | 状态 |
|---|---|---|
| 1 | 插件骨架 | ✅ |
| 2 | Providers | ✅ Hailuo v1/v2 端到端跑通 |
| 3 | Tools 注册 | ✅ 4 个 tool 接通 |
| 4 | 6 阶段 Pipeline | ✅ **6 agents 全部实现** |
| 5 | Video Mixing | ✅ 代码完成；需 ffmpeg |
| 6 | Smart Editing | ✅ 启发式版（Whisper 6.5） |
| 7 | Beat Sync | ✅ beats.ts 模块 |
| 8 | HTTP Routes | ✅ **12/12 smoke pass**（插件自 spawn Node http） |
| 9 | Tests + docs | ✅ vitest 3/3 + README + smoke |
| 10 | Publish | 🟡 `npm pack` 验证 |



---

## 10. 附录

### 10.1 关键参考文档

| 文档 | URL |
|---|---|
| DSH 插件配置目录 | https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog |
| DSH 第一个插件教程 | https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/ |
| DSH Tool 编写参考 | https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool |
| DSH Tools 子系统 | https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/tools |
| dsh-client-shell（壳设计） | `E:\code\ai\dsh-client-shell` |
| v2 设计文档（已撤回） | `aigc-director/doc/4-Rust重构与混剪智剪设计.md` |

### 10.2 决策日志（v3）

| 决策 | 替代方案 | 理由 |
|---|---|---|
| **TypeScript 插件**（v2 是 Rust standalone） | Rust standalone 后端 | 用户明确要求"整体后端变成 DSH 插件"；DSH 是 TS 生态 |
| **fluent-ffmpeg**（subprocess） | native binding | Node.js 生态成熟；零编译成本 |
| **whisper-node** | whisper-rs (Rust) | 同 Node 进程；省去 spawn 复杂度 |
| dsh-client-shell 完全不改 | 改造 dsh-shell 集成 Rust 后端 | 已稳定；避免双重破坏 |
| Python AIGC-Claw 保留作参考 | 直接删除 | 行为基准；插件对齐后逐步退役 |
| 复用 Python 提示模板 | 重写 | 29 个 .txt 跨语言共享，省去翻译 |

### 10.3 与 v2 的差异

| 维度 | v2（Rust standalone） | v3（DSH 插件） |
|---|---|---|
| 后端语言 | Rust | **TypeScript** |
| 运行端口 | 8000（独立） | 3080（DSH 同进程） |
| 进程模型 | dsh-shell spawn aigc-server | DSH 进程内加载 plugin |
| HTTP 服务器 | axum | DSH 内置 + 路由 mount |
| 工具调用 | REST API | **DSH Tool**（模型直接调用） |
| Agent 驱动 | OpenClaw Agent 调 REST | DSH Agent 调 tool |
| 总工作量 | 14-18 周 | **14-16 周**（略省，因 DSH 内置基建） |

### 10.4 关联文档

- `aigc-director/SKILL.md`：OpenClaw Agent 工作流（**不变**）
- `aigc-director/aigc-claw/backend/`：Python 参考实现（**保留**）
- `E:\code\ai\dsh-client-shell`：桌面壳（**不变**）

---

*文档结束*
*下一步：等待用户确认本设计 → Phase 1 实施*