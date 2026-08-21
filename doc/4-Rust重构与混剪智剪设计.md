# AIGC-Claw 重构设计文档 — 全栈 Rust 化 + 视频混剪/智剪

> **文档版本**：v2.0 · **日期**：2026-08-18 · **范围**：整体架构全栈 Rust 重构 + 两项新功能
>
> 在保留原 AIGC-Claw 6 阶段管线 + 9 停点工作流 + 10 REST/NDJSON API 契约基础上：
> 1. **后端整体从 Python 迁移到 Rust**（FastAPI → axum；asyncio → tokio；Pydantic → serde）
> 2. 以 **`E:\code\ai\dsh-client-shell`**（Tauri 2 + Rust 1.96 + WebView2）作为桌面壳基座
> 3. 新增 **视频混剪（mixing）** 与 **智能剪辑（smart editing）** 两个核心模块
>
> **v1 → v2 变化**：v1 设计保留 Python 后端，新功能用 Rust；v2 改为**全部用 Rust**，Python 后端彻底退役。

---

## 0. 一句话架构

> **纯 Rust AIGC 后端（axum）+ dsh-shell 桌面壳（Tauri 包装拉起）+ 新功能（混剪/智剪）100% Rust 实现 + 新 Tauri UI 替代 iframe**。

具体：`dsh-shell` 启动时拉起 Rust AIGC 后端（端口 8000）+ 渲染新前端（Svelte/TS UI，WebView2 内）→ 前端通过 Tauri command 调用 Rust 实现的混剪/智剪 + 后端 6 阶段 agent → 后端调 LLM/Image/Video provider → 资产落盘 → Rust 模块调 ffmpeg/Whisper 产出最终视频。

---

## 1. 现状盘点

### 1.1 AIGC-Claw（**待迁移**：Python 后端 + Next.js 前端）

| 层 | 内容 |
|---|---|
| **后端**（待 Rust 化） | FastAPI（端口 8000），10 端点 + NDJSON 流 |
| 前端 | Next.js 15 + TS + Tailwind v4（端口 3000）— 短期保留，最终被 Tauri UI 取代 |
| 入口 | `aigc-claw/backend/main.py` → 迁移到 `aigc-claw/backend-rs/src/main.rs` |
| Agent | 6 个 BaseAgent：script_writer / character_designer / storyboard / reference_generator / video_director / editor → 迁移到 `aigc-agents` crate |
| 工作流 | 由 `aigc-director/SKILL.md` 驱动，9 停点（OpenClaw Agent 调用模式）— **SKILL.md 与 API 契约不变** |
| Provider | 4 类抽象：LLM / Image / Video / VLM → 迁移到 `aigc-providers` crate（reqwest HTTP） |
| 后处理 | `agents/editor.py`：`ffmpeg` 子进程拼接 + crossfade + 字幕烧录 + BGM 注入 → 迁移到 Rust |

**关键观察**：
- ✅ Provider 抽象清晰，每个阶段只调 `provider.xxx()` 接口 → Rust 用 trait + async fn 同样实现
- ✅ 后处理已用 ffmpeg 子进程模式（**不是 Python ffmpeg binding**） → Rust 沿用 subprocess 即可
- ✅ 9 停点逻辑全部在 SKILL.md（Prompt 驱动），后端只暴露 REST API → **SKILL.md 与 10 端点契约不变**
- ✅ Session JSON 格式（`code/data/sessions/{id}.json`）保持兼容（旧 session 可继续编辑）
- ⚠️ 现有 `editor.py` 仅做：归一化 → 拼接 → crossfade → 字幕烧录 → 输出
- ❌ 没有：scene 检测、silence 检测、beat sync、take scoring、自动选片 → 新增 Rust 模块

### 1.2 Rust 后端技术栈（迁移目标）

| 用途 | Crate | 版本 | 替代什么 |
|---|---|---|---|
| HTTP 框架 | **axum** | 0.8.x | FastAPI |
| 异步运行时 | **tokio** | 1.x | asyncio |
| HTTP 客户端 | **reqwest** | 0.12.x（含 JSON / multipart / stream） | httpx |
| 序列化 | **serde** + **serde_json** | 1.x / 1.x | Pydantic |
| 校验 | **garde** 或自定义 derive | latest | Pydantic validator |
| 错误处理 | **anyhow** + **thiserror** | 1.x | 自定义异常 |
| Tower 中间件 | **tower** / **tower-http** | latest | FastAPI middleware |
| 日志 | **tracing** + **tracing-subscriber** | latest | loguru |
| 配置 | **config** 或 **figment** | latest | pydantic-settings + YAML |
| 原子文件写 | **tempfile** + **tokio::fs** | latest | os.replace |
| 并发限流 | **tokio::sync::Semaphore** | — | asyncio.Semaphore |
| 重试 | **backoff** 或 **retry** | latest | tenacity |
| JSON Schema 校验 | **jsonschema** | latest | Pydantic schema |

**关键 Rust 优势**（对比 Python）：
- ⚡ tokio + axum 性能远高于 asyncio + FastAPI（10x+）
- 📦 单文件二进制，部署简单（无 pip/venv 问题）
- 🔒 类型安全 + 编译时校验（消灭 Pydantic runtime check 的开销）
- 🔌 与 dsh-shell 共享 Rust 工具链与生态
- ⚠️ 学习/迁移成本（团队 Rust 熟练度）

### 1.3 dsh-client-shell（Tauri 2 + Rust）

| 层 | 内容 |
|---|---|
| Rust 主进程 | `src-tauri/src/main.rs`（516 行）：`DshState { child, owned, phase, launch_error }` + 窗口/托盘/进程管理 |
| 前端 | `src/index.html`（180 行）：最小启动画面 + iframe 嵌入 WebView2 |
| 依赖 | `tauri 2`、`serde`、`serde_json`（仅 3 个核心 crate） |
| 打包 | MSI + NSIS，~1.5MB，无内嵌 Chromium |
| 关键模式 | spawn 子进程 + TCP 探测存活 + 监听 RunEvent::Exit 关闭 owned 进程 + 进度事件 emit |

**可复用资产**：
- ✅ 子进程拉起模式（直接套用到 AIGC Python 后端）
- ✅ TCP 探测端口存活
- ✅ 托盘 + GUI 子系统 + 关闭拦截
- ✅ Tauri 2 命令注册 + 进度事件 emit
- ✅ 中文 CSP + MSI 中文代码页（`language: ["zh-CN"]`）
- ⚠️ 当前只支持单服务（DSH on 3080），需扩展支持多服务/多端口

---

## 2. 架构设计

### 2.1 总体架构（全栈 Rust，axum 后端 + Tauri 壳）

```
┌─────────────────────────────────────────────────────────────────────┐
│            AIGC-Claw Desktop Shell (Tauri 2 + Rust)                  │
│                                                                     │
│  ┌──────────────────────────┐   ┌────────────────────────────────┐  │
│  │  Tauri 主进程 (Rust)      │   │  WebView2 前端 (Svelte/TS)    │  │
│  │  · 窗口/托盘/生命周期      │   │  · 6 阶段管线 UI              │  │
│  │  · AIGC 后端拉起          │   │  · 混剪/智剪可视化编辑器       │  │
│  │  · Tauri Commands         │   │  · 时间线 + 拖拽 + 预览       │  │
│  │    - mix_videos           │◄──┤                                │  │
│  │    - smart_edit           │   └────────────────┬───────────────┘  │
│  │    - cancel_job, etc.     │                    │ invoke()        │
│  └────────────┬─────────────┘                    │                  │
│               │ spawn (tokio::process::Command)  │                  │
│               ▼                                  │                  │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ★ AIGC Rust 后端 (axum, tokio) — 替代原 Python 后端             │ │
│  │  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐    │ │
│  │  │ 6 Stage Agents   │ │ Providers       │ │ Pipeline        │    │ │
│  │  │ script_writer    │ │ LLM (reqwest)   │ │ StateMachine    │    │ │
│  │  │ character_design │ │ Image           │ │ PipelineOrch    │    │ │
│  │  │ storyboard       │ │ Video (Hailuo v1/v2, Kling, Wan)   │ │
│  │  │ reference_gen    │ │ VLM (Qwen-VL, Gemini-VL)           │ │
│  │  │ video_director   │ │                                       │ │
│  │  │ editor           │ │                                       │ │
│  │  └─────────────────┘ └─────────────────┘ └─────────────────┘    │ │
│  │  ┌─────────────────────────────────────────────────────────┐   │ │
│  │  │ SessionManager: atomic JSON (tokio::fs + tempfile)        │   │ │
│  │  └─────────────────────────────────────────────────────────┘   │ │
│  │  HTTP: axum + NDJSON streaming via axum::body::Body::Stream       │ │
│  └────────┬─────────────────────────────────────────────────────────┘ │
│           │ HTTP (localhost:8000) + Tauri command proxy               │
│           ▼                                                            │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ★ 新 Rust 模块（同进程，与后端共享状态）                         │  │
│  │  ┌──────────────────────┐  ┌──────────────────────────────┐    │  │
│  │  │ video_mixer (混剪)    │  │ smart_editor (智剪)          │    │  │
│  │  │  · ffmpeg subprocess  │  │  · whisper-rs (本地转录)    │    │  │
│  │  │  · transitions (8+)   │  │  · silero-vad (静音检测)    │    │  │
│  │  │  · captions burn-in   │  │  · scene-detector (ffmpeg)  │    │  │
│  │  │  · BGM overlay        │  │  · beat-sync (symphonia)     │    │  │
│  │  └──────────────────────┘  └──────────────────────────────┘    │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  ┌──────────────────────────────┐
                  │  本地资源                       │
                  │  · code/result/ (Rust 写入)    │
                  │  · ~/.aigc-claw/models/        │ ← 首次启动下载
                  │    - ggml-base.bin (Whisper)  │
                  │    - silero_vad.onnx          │
                  │    - qwen2-vl-2b-instruct (v2)│
                  └──────────────────────────────┘
```

**架构变化（v1 → v2）**：
- ❌ ~~AIGC Python 后端（FastAPI）~~ → ✅ AIGC Rust 后端（axum）
- ✅ dsh-shell 仍是桌面壳，拉起 Rust 后端（同进程组，spawn 模式）
- ✅ 混剪/智剪仍在 Rust 内（与后端共享 tokio runtime + 进程内状态，避免 HTTP 跨进程）

### 2.2 数据流（典型混剪场景）

```
[前端时间线 UI]
   │ 拖拽 5 个视频片段 + 选 crossfade + 选 BGM + 自动字幕
   ▼
[invoke('mix_videos', payload)]
   │  {clips, transitions, bgm, captions, output_resolution}
   ▼
[Tauri Command: mix_videos]
   │  spawn tokio task
   ▼
[video_mixer.rs]
   │  Step 1: ffprobe 所有片段 → 获取 codec/resolution/duration
   │  Step 2: 并行 normalize (scale+pad, libx264, aac)
   │  Step 3: concat with xfade filter (concat demuxer + xfade)
   │  Step 4: burn SRT captions (subtitles filter)
   │  Step 5: mix BGM (audio filter, sidechain ducking)
   │  emit("mix_progress", {phase, percent, eta})
   ▼
[输出 MP4 → settings.video_dir]
   │  emit("mix_done", {output_path})
   ▼
[前端] 显示结果 + 下载链接
```

### 2.3 数据流（典型智剪场景）

```
[前端选择 "智剪"]
   │  上传 5 个 raw 片段 + 粘贴脚本文本
   ▼
[invoke('smart_edit', payload)]
   │  {clips, script_text, output_duration}
   ▼
[smart_editor.rs]
   │  Step 1: 并行对每个 clip 调用：
   │          - ffprobe 探测时长
   │          - silero-vad → speech segments
   │          - whisper-rs → 完整 transcript
   │          - scene-detector (ffprobe scene) → cut points
   │  Step 2: script↔transcript 对齐（diff-match-patch）
   │  Step 3: BGM beat detection (symphonia onset)
   │  Step 4: VLM 评分（对每个候选 cut 点，Qwen2-VL-2B 打分）
   │  Step 5: 拼装剪辑决策 JSON：
   │          { sequence: [{clip_id, in/out, transition, score}], bgm_cuts: [...], captions: [...] }
   │  emit("smart_progress", {phase, percent, eta})
   ▼
[前端时间线编辑器]
   │  显示决策（用户可手动调）
   ▼
[确认] → invoke('mix_videos', decisions)
   │  → 走 video_mixer 流程
```

### 2.4 模块划分

| 模块 | 语言 | 状态 | 职责 |
|---|---|---|---|
| `dsh-client-shell` 改造 | Rust | 改造 | 多服务拉起（DSH + AIGC Rust 后端）+ 进度事件 + 新 Tauri commands |
| **AIGC Rust 后端** | Rust | **迁移自 Python** | axum HTTP 服务、6 stage agents、Provider 集成、Pipeline 编排、Session 持久化 |
| `aigc-agents` crate | Rust | **新增** | 6 个 agent trait 实现 |
| `aigc-providers` crate | Rust | **新增** | LLM / Image / Video / VLM 四类 provider trait + 多厂商实现 |
| `aigc-framework` crate | Rust | **新增** | BaseAgent / StateMachine / PipelineOrchestrator / SessionManager / StreamManager |
| `video_mixer` | Rust | **新增** | ffmpeg 混剪：transitions + captions + BGM |
| `smart_editor` | Rust | **新增** | 智剪：whisper + vad + scene + beat + (v2 VLM) |
| `job_runner` | Rust | **新增** | tokio 任务调度 + 进度上报 + 取消 |
| 前端（新） | Svelte/TS | **重写** | 6 阶段 UI + 时间线编辑器 + 智剪向导 |
| ~~Python 后端~~ | ~~Python~~ | ~~退役~~ | 6 stage agents + Provider 集成 → 已迁移至 Rust |
| ~~Next.js 前端~~ | ~~TS~~ | ~~退役~~ | 短期保留供兼容，最终被 Tauri UI 取代 |
| `prompts/*.txt` | 文本 | **保留** | 29 个提示模板，编译期 `include_str!` 嵌入 Rust 二进制 |

---

## 3. Rust 技术栈选型

### 3.0 后端栈（v2 新增）

| 用途 | Crate | 版本 | 替代什么 |
|---|---|---|---|
| HTTP 框架 | **axum** | 0.8.x | FastAPI |
| 异步运行时 | **tokio** | 1.x（axum/whipser-rs/reqwest 共享） | asyncio |
| HTTP 客户端 | **reqwest** | 0.12.x（含 JSON / multipart / stream） | httpx |
| 序列化 | **serde** + **serde_json** | 1.x | Pydantic |
| 配置加载 | **figment** | 0.10.x | pydantic-settings |
| Tower 中间件 | **tower** / **tower-http** | 0.5 / 0.6 | FastAPI middleware |
| 校验 | **garde** 或自定义 derive | latest | Pydantic validator |
| 错误处理 | **anyhow** + **thiserror** | 1.x | 自定义异常 |
| 日志 | **tracing** + **tracing-subscriber** | 0.1 | loguru |
| 原子文件写 | **tempfile** + **tokio::fs** | latest | os.replace |
| 重试 | **backoff** | 0.4 | tenacity |
| JSON Schema | **jsonschema** | 0.18 | Pydantic schema |
| 时间 | **chrono** | 0.4 | datetime |
| UUID | **uuid** | 1.x | uuid（同名） |
| 路径 | **camino** | 1.x | pathlib |
| 序列化辅助 | **serde_yaml** | 0.9 | pyyaml |
| 单文件编译 | **tonic-build**（可选，gRPC 接口） | 0.12 | — |

**Cargo workspace 结构**（见 §5.1）：
```
[workspace]
members = [
  "crates/aigc-server",
  "crates/aigc-agents",
  "crates/aigc-providers",
  "crates/aigc-framework",
  "crates/aigc-video-ext",
]
[workspace.dependencies]
# 共享版本管理，避免 crate 间版本不一致
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "multipart", "rustls-tls"] }
# ...
```

### 3.1 视频处理栈

| 用途 | Crate | 版本 | 备注 |
|---|---|---|---|
| FFmpeg 绑定 | `ffmpeg-next` | 9.0.0（2026-08） | **维护模式但仍可用**，6.3M 下载 |
| FFmpeg 绑定（替代） | `ffmpeg-the-third` | 4.0.1 | ffmpeg-next 无人维护后的 fork，支持 FFmpeg 5.1-8.1 |
| **实际选型** | **`std::process::Command` + bundled ffmpeg.exe** | — | 参考 velocut/avio：**用 ffmpeg 子进程比 native binding 更稳**，可避免 LGPL/GPL 链接复杂性 + 编译时间 + MSVC 链接问题 |
| 字幕烧录 | ffmpeg `subtitles` filter | — | 已被现有 Python 代码采用 |
| 字体渲染 | `fontdue` 或 `rusttype` | latest | 烧录字幕前的字体预处理（可选） |
| 进度解析 | regex on ffmpeg stderr | — | ffmpeg 进度格式 `time=00:00:01.23` |

**关键决策：subprocess ffmpeg，不绑定**
- 优点：零编译成本、ffmpeg 升级不影响 Rust 二进制、Windows MSVC 零问题
- 缺点：需要 ffmpeg.exe 在 PATH 或 bundled
- 解决方案：bundled 在 Tauri installer 内（`src-tauri/binaries/ffmpeg.exe`，~80MB），首次启动解压到 `%LOCALAPPDATA%\aigc-claw\runtime\`
- 许可证：ffmpeg 是 LGPL 2.1+ 或 GPL 2+，**subprocess 调用不触发链接问题**（GPL only triggers when statically linking）

### 3.2 AI 推理栈

| 用途 | Crate | 版本 | 模型 |
|---|---|---|---|
| Whisper 转录 | `whisper-rs` | 0.16.0（2026-03） | ggml-base.bin (74MB) 或 ggml-small.bin (244MB) |
| 静音检测 VAD | `silero-vad-rs` 或 `ort` | latest | silero_vad.onnx (~1MB) |
| 场景检测 | ffmpeg `select='gt(scene,0.4)'` showinfo | — | ffmpeg 内置 |
| VLM 评分（可选） | `ort` | 2.x | Qwen2-VL-2B-Instruct (ONNX, ~1.5GB) — v1 跳过，先用启发式 |
| ONNX Runtime | `ort` | 2.x | 通用推理后端 |
| 节拍检测 | `symphonia` | latest（音频解码） + 自写 onset detection | librosa-style onset |

**v1 最小可行集**（避免引入 ort 的 ~1.5GB VLM 模型）：
- whisper-rs（必选）
- silero-vad-rs 或 ffmpeg silencedetect filter（必选）
- ffmpeg scene detect（必选）
- beat detection 自写（用 symphonia 解码音频后简单能量计算）

**v2 可选扩展**：
- ort + Qwen2-VL-2B（镜头评分、情绪标签）
- Real-ESRGAN Rust port（视频超分）

### 3.3 并发与异步

| 用途 | Crate | 版本 |
|---|---|---|
| 异步运行时 | `tokio` | 1.x |
| 任务调度 | `tokio::spawn` + `JoinHandle` | — |
| 进度事件 | `tauri::Emitter::emit` | tauri 2 |
| CPU 密集 | `rayon` | 1.x（v2 阶段 VLM 推理时用） |
| 取消 | `tokio::sync::watch` channel | — |

### 3.4 前端栈

| 用途 | 技术 |
|---|---|
| 框架 | **Svelte 5 + TypeScript**（轻量、编译时优化、Tauri 友好） |
| 样式 | Tailwind v4 |
| 状态 | Svelte stores（不用 Redux/Pinia） |
| 时间线 | 自实现（video 元素 + Canvas 缩略图条），或 `svelte-dnd-action` 做拖拽 |
| 视频预览 | 原生 `<video>` + `<canvas>` 合成预览 |
| 包管理 | `pnpm` |

### 3.5 不引入的依赖

| 不引入 | 原因 |
|---|---|
| `tch` / `tch-rs` | PyTorch 绑定，~2GB，不适合 desktop |
| `burn` | 框架好但生态不成熟，v1 不需要 |
| `candle` | HF Rust ML，可作 v2 备选 |
| `gstreamer-rs` | 引入 GTK/MSVC 依赖，不值得 |

---

## 4. 新功能详细设计

### 4.1 视频混剪（video_mixer）

**输入**：
```rust
struct MixRequest {
    clips: Vec<ClipInput>,           // [{path, in_point, out_point}]
    transitions: Vec<TransitionSpec>, // [{after_clip_id, kind, duration}]
    bgm: Option<BgmSpec>,            // {path, volume_db, fade_in, fade_out}
    captions: Vec<Caption>,          // [{start, end, text, style}]
    output: OutputSpec,              // {path, fps, resolution, crf}
}

struct TransitionSpec {
    kind: TransitionKind,            // Cut | Crossfade | DipToBlack | DipToWhite | Iris | Wipe | Push | BarnDoors | ClockWipe
    duration: Duration,
}
```

**输出**：`final_output.mp4`

**核心流程（**伪代码**）**：
```rust
async fn mix_videos(req: MixRequest, emit: ProgressEmitter) -> Result<PathBuf> {
    emit(0.05, "probing clips");
    let probes = stream::iter(&req.clips)
        .map(|c| ffprobe(c.path))
        .buffer_unordered(4)  // 并行探测
        .collect().await?;

    emit(0.15, "normalizing clips");
    let normalized = stream::iter(&req.clips.zip(probes))
        .map(|(c, p)| normalize_to(c, p, target_w, target_h))
        .buffer_unordered(2)  // 限制并发（CPU 密集）
        .collect().await?;

    emit(0.6, "concatenating with transitions");
    let concat_path = build_concat_with_transitions(&normalized, &req.transitions);

    emit(0.75, "mixing audio (BGM)");
    let with_bgm = mix_bgm(&concat_path, &req.bgm)?;

    emit(0.9, "burning captions");
    burn_captions(&with_bgm, &req.captions, &req.output.path)?;

    emit(1.0, "done");
    Ok(req.output.path)
}
```

**转场实现**（参考 velocut + ffmpeg filter）：
- Crossfade: `xfade=transition=fade:duration=0.5:offset=...`
- DipToBlack: `xfade=transition=fadeblack:duration=...`
- DipToWhite: `xfade=transition=fadewhite:duration=...`
- Iris: `xfade=transition=iris:duration=...`
- Wipe: `xfade=transition=wipeleft:duration=...`
- Push: 需 ffmpeg overlay filter 自实现（xfade 无 push）
- BarnDoors: 自实现（overlay + crop）
- ClockWipe: `xfade=transition=clock:duration=...`

**进度解析**（参考 velocut）：
- parse ffmpeg stderr `time=00:00:01.23` → 估算 percent
- 100% 时 done
- emit 频率限制：每 500ms 最多一次

**取消实现**：
- tokio task 持有 `Child` handle
- 取消时 `child.kill().await`
- Windows: `taskkill /PID /T /F` 杀进程树

### 4.2 智能剪辑（smart_editor）

**输入**：
```rust
struct SmartEditRequest {
    clips: Vec<ClipInput>,
    script_text: String,             // 完整剧本
    output_duration: Option<Duration>, // 用户期望的输出时长（可选）
    bpm_target: Option<f32>,          // 期望的 BGM 节奏（可选）
}

struct EditDecision {
    sequence: Vec<SequenceItem>,
    bgm_sync_points: Vec<f32>,        // seconds, beat-aligned cut points
    captions: Vec<Caption>,
    total_duration: Duration,
    confidence: f32,
}

struct SequenceItem {
    clip_id: String,
    in_point: Duration,
    out_point: Duration,
    transition: TransitionKind,
    transition_duration: Duration,
    score: f32,                       // 0-1, VLM 或启发式评分
    reason: String,                   // 为什么选这个片段
}
```

**核心流程**：

#### Phase 1: 特征提取（并行）
```rust
struct ClipFeatures {
    clip_id: String,
    duration: Duration,
    transcript: String,             // Whisper
    transcript_segments: Vec<Segment>, // [{start, end, text}]
    vad_segments: Vec<Range>,      // silero-vad 语音段
    scene_changes: Vec<f32>,       // 秒时间戳
    motion_energy: Vec<f32>,       // 每秒运动能量（ffmpeg select filter）
    audio_energy: Vec<f32>,        // 每秒音频能量
    peak_moments: Vec<f32>,        // 综合能量峰
}

async fn extract_features(clips) -> Vec<ClipFeatures> {
    stream::iter(clips).map(|c| async move {
        let transcript = whisper_transcribe(&c.path).await?;
        let vad = silero_vad(&c.path).await?;
        let scenes = ffmpeg_scene_detect(&c.path).await?;
        let motion = ffmpeg_motion_energy(&c.path).await?;
        let audio = ffmpeg_audio_energy(&c.path).await?;
        Ok(ClipFeatures { ... })
    }).buffer_unordered(2).collect().await
}
```

#### Phase 2: 剧本对齐
```rust
fn align_script_to_transcripts(
    script: &str,
    features: &[ClipFeatures],
) -> Vec<ScriptMatch> {
    // 用 diff-match-patch 或简单文本相似度
    // 把剧本的每句话匹配到最可能的 (clip_id, segment)
    // 输出: [{script_sentence, matched_clip, matched_segment, confidence}]
}
```

#### Phase 3: 综合评分（v1 启发式，v2 VLM）
```rust
fn score_candidate_segments(matches: Vec<ScriptMatch>) -> Vec<ScoredCandidate> {
    // 启发式评分公式（v1）：
    // score = 0.5 * script_alignment  // 剧本匹配度
    //       + 0.2 * motion_energy      // 视觉动感
    //       + 0.2 * audio_energy       // 音频能量
    //       + 0.1 * position_score     // 在原 clip 中的位置（首尾通常不如中间）
    for m in matches {
        let s = 0.5 * m.alignment_confidence
              + 0.2 * motion_at(matched_time) / max_motion
              + 0.2 * audio_at(matched_time) / max_audio
              + 0.1 * (1.0 - (position_ratio - 0.5).abs() * 2.0);
        scored.push(s);
    }
}
```

#### Phase 4: 节拍检测（BGM 同步）
```rust
fn detect_bpm(features: &[ClipFeatures]) -> Vec<f32> {
    // 用 symphonia 解码音频
    // 计算 onset strength envelope（短时能量变化率）
    // 自相关找主频 → BPM
    // 输出 beat times 数组
}
```

#### Phase 5: 拼装决策
```rust
fn build_decisions(
    scored: Vec<ScoredCandidate>,
    beats: Vec<f32>,
    target_duration: Duration,
) -> EditDecision {
    // 按 score 降序选片段直到累计时长 ≥ target
    // 按原剧情顺序排列（不按 score 排，保持叙事连贯）
    // 转场时间对齐到最近的 beat
    // 输出 EditDecision JSON
}
```

**输出**：EditDecision JSON → 传给 video_mixer 执行

### 4.3 关键决策点

| 决策 | 选项 | 推荐 | 理由 |
|---|---|---|---|
| ffmpeg 调用方式 | subprocess / ffmpeg-next binding | **subprocess** | 0 编译成本，无 LGPL 风险，参考 velocut |
| Whisper 模型 | tiny (39MB) / base (74MB) / small (244MB) | **base** | 速度+精度平衡（中文+英文 OK） |
| VLM 评分 | 用 ort + Qwen2-VL / 启发式 | **v1 启发式，v2 VLM** | ort + 2B 模型 ~1.5GB 不值得 v1 引入 |
| Beat detection | 自写 onset + BPM / 跳过 | **自写（简单）** | 只需 onset 时间点，不需复杂算法 |
| BGM 来源 | 内置库 / 用户上传 / 自动搜索 | **v1 用户上传** | 自动搜索需要授权 API（v2） |
| 字幕生成 | LLM（沿用现有） / Whisper 转录 | **LLM 沿用** | 剧本已有，LLM 时间对齐更准 |

---

## 5. 集成方案

### 5.1 AIGC Rust 后端 monorepo 结构

将 `aigc-claw/backend/`（Python）迁移为 `aigc-claw/backend-rs/`（Rust workspace）：

```
aigc-claw/backend-rs/                     ← 替换原 backend/
├── Cargo.toml                            ← workspace
├── crates/
│   ├── aigc-server/                      ← axum 二进制入口
│   │   ├── Cargo.toml
│   │   ├── src/main.rs                   ← axum::serve + 端口 8000
│   │   └── src/router.rs                 ← 10 端点路由
│   │
│   ├── aigc-agents/                      ← 6 stage agents
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── base.rs                   ← BaseAgent trait
│   │       ├── script_writer.rs
│   │       ├── character_designer.rs
│   │       ├── storyboard.rs
│   │       ├── reference_generator.rs
│   │       ├── video_director.rs
│   │       └── editor.rs
│   │
│   ├── aigc-providers/                   ← 多厂商 model 接入
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── llm/                      ← DeepSeek/Qwen/GLM/Kimi/iSigning/MiniMax
│   │       ├── image/                    ← Wan/Jimeng/Seedream
│   │       ├── video/                    ← Kling/Wan/Hailuo v1/Hailuo v2/SelfHost
│   │       └── vlm/                      ← Qwen-VL/Gemini-VL
│   │
│   ├── aigc-framework/                   ← 复用基础设施层
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── state_machine.rs          ← StateMachine<T>
│   │       ├── pipeline.rs               ← PipelineOrchestrator
│   │       ├── session.rs                ← SessionManager (atomic JSON)
│   │       ├── streaming.rs              ← NDJSON via axum::body::Body::Stream
│   │       ├── prompts.rs                ← 提示模板加载（include_str!）
│   │       ├── scheduler.rs              ← 并发治理
│   │       └── governance/               ← CircuitBreaker / Retry / Guard
│   │
│   └── aigc-video-ext/                   ← ★ 视频混剪/智剪（同进程共享 tokio runtime）
│       ├── Cargo.toml
│       └── src/
│           ├── mixer.rs
│           ├── smart.rs
│           ├── job_runner.rs
│           └── ffmpeg.rs                 ← subprocess wrapper
│
├── prompts/                              ← 29 个 .txt 文件原样保留
│   ├── character/
│   ├── logline/
│   ├── reference/
│   ├── script/
│   ├── setting/
│   ├── storyboard/
│   └── video/
│
├── config.yaml                           ← 与原 backend/config.yaml 兼容
├── .env                                  ← API keys（同位置）
└── code/                                 ← 运行产物（向后兼容）
    ├── data/sessions/                    ← JSON 格式不变
    └── result/                           ← script / image / video
```

### 5.2 dsh-client-shell 改造点

**目标**：让 dsh-shell 支持拉起 AIGC Rust 后端（端口 8000）+ 新 Tauri commands。

**改造清单**：
| 文件 | 改造 |
|---|---|
| `src-tauri/Cargo.toml` | 加 tokio / reqwest / serde_json / anyhow / symphonia / whisper-rs 等 |
| `src-tauri/src/main.rs` | 引入 AIGC 状态机 + 拉起 Rust 后端 + 多服务管理 |
| `src-tauri/src/state.rs` (新) | `AppState` 统一管理：DSH 进程 + AIGC 进程 + jobs + progress channels |
| `src-tauri/src/commands/` (新) | 拆 main.rs：mix_videos / smart_edit / start_aigc / aigc_status / cancel_job |
| `src-tauri/src/aigc_runner.rs` (新) | Rust 后端进程管理（同 DSH 模式） |
| `src-tauri/src/video_mixer.rs` (新) | video_mixer 模块（**与后端共享 aigc-video-ext crate**，避免重复实现） |
| `src-tauri/src/smart_editor.rs` (新) | smart_editor 模块（同上） |
| `src-tauri/src/job_runner.rs` (新) | tokio 任务调度 + 进度上报 + 取消 |
| `src-tauri/Cargo.toml` | bundled ffmpeg.exe 资源声明 |
| `src-tauri/tauri.conf.json` | 调整 capabilities（开 fs 读写、shell exec） |
| `src/` 前端 | 全量替换（见 §6） |

### 5.3 数据接口（Tauri Commands）

```rust
// Tauri Command 暴露给前端
#[tauri::command]
async fn mix_videos(
    request: MixRequest,
    state: State<'_, AppState>,
) -> Result<JobId, String>;

#[tauri::command]
async fn smart_edit(
    request: SmartEditRequest,
    state: State<'_, AppState>,
) -> Result<JobId, String>;

#[tauri::command]
async fn get_job_status(job_id: JobId) -> JobStatus;

#[tauri::command]
async fn cancel_job(job_id: JobId) -> ();

#[tauri::command]
async fn preview_at(job_id: JobId, timestamp_ms: u32) -> PreviewHandle;

// 进度事件（emit 到前端）
"mix_progress" -> { phase: String, percent: f32, eta_secs: u32, message: String }
"mix_done" -> { output_path: String, duration_secs: f32 }
"smart_progress" -> { phase: String, percent: f32, eta_secs: u32, found_candidates: u32 }
"smart_done" -> { decision: EditDecision }
"job_error" -> { error: String, recoverable: bool }
```

### 5.4 API 契约兼容性（关键）

**保持完全不变**：
- ✅ 10 REST 端点路径与请求/响应 schema（OpenClaw Agent 调用兼容）
- ✅ NDJSON 流式协议（`event`/`data` 字段，4 种事件类型）
- ✅ Session JSON 格式（`code/data/sessions/{id}.json`）— 旧 session 可继续编辑
- ✅ 制品落盘路径（`code/result/{script|image|video}/{session_id}/`）
- ✅ config.yaml schema（含 `models.{provider}.{api_key,base_url,...}` 与 `pipeline.{video_provider,planner_enabled,...}`）
- ✅ .env 变量名（`MINIMAX_API_KEY`、`DASHSCOPE_API_KEY` 等）
- ✅ 9 停点 SKILL.md 协议（Agent 不需修改）

**变化的内部实现**（对用户透明）：
- HTTP 服务器从 uvicorn/FastAPI → axum
- 数据模型从 Pydantic → serde derive
- LLM Provider 从 httpx → reqwest
- NDJSON 从 FastAPI StreamingResponse → axum::body::Body::stream()
- 异步从 asyncio → tokio
- 持久化从 aiofiles → tokio::fs
- 配置从 pydantic-settings → figment

### 5.5 资源目录约定

```
%LOCALAPPDATA%\aigc-claw\
├── runtime\
│   ├── aigc-server.exe       ← Rust 后端二进制
│   ├── ffmpeg.exe            ← bundled 解压
│   └── ffprobe.exe
├── models\
│   ├── ggml-base.bin         ← Whisper base model
│   └── silero_vad.onnx       ← VAD model
├── jobs\                     ← in-progress job state
├── cache\                    ← 缩略图、临时音频能量
└── logs\                     ← ffmpeg / 后端 stderr 日志
```

**会话数据路径**（与 Python 版兼容）：
```
%LOCALAPPDATA%\aigc-claw\code\
├── data/sessions/{session_id}.json    ← SessionManager 原子写
└── result/
    ├── script/{session_id}/
    ├── image/{session_id}/
    └── video/{session_id}/
```

### 5.6 打包与安装

| 项 | 大小 | 来源 |
|---|---|---|
| dsh-shell base | ~1.5MB | 已有 |
| + Rust 后端二进制（aigc-server.exe + aigc-video-ext） | ~10MB | 编译产物（release with LTO） |
| + ffmpeg.exe + ffprobe.exe | ~80MB | bundled in installer |
| + silero_vad | ~1MB | bundled（很小） |
| **总安装包** | **~92MB** | 一次性下载 |
| **首次启动** | + ~80MB（Whisper） | 网络下载，进度提示 |

vs Python 版（v1）：安装包 ~85MB → ~92MB（+7MB Rust 二进制），换来：
- ✅ 无 Python 解释器依赖
- ✅ 启动更快（无 venv 初始化）
- ✅ 性能更好（tokio vs asyncio）
- ✅ 部署简单（单文件复制即运行）

---

## 6. 前端设计（新 UI）

### 6.1 路由结构

```
/                       → 首页（项目列表）
/project/:id            → 项目详情（6 阶段管线 UI，沿用 AIGC-Claw 现有视觉）
/project/:id/mix        → 混剪工作台（新）
/project/:id/smart      → 智剪向导（新）
/settings               → 设置（API keys、模型下载状态）
```

### 6.2 混剪工作台 UI

```
┌────────────────────────────────────────────────────────────────┐
│  ← 返回    混剪工作台 / 雨夜跑车短片                    [导出]   │
├────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────┐ ┌────────────────────────────────┐ │
│ │  片段库                 │ │  时间线                         │ │
│ │  ┌────┬────┬────┐      │ │  ▶ ━━●━━━━━━━━━━━━━━━━━━     │ │
│ │  │clip│clip│clip│      │ │  00:00       00:30      01:00  │ │
│ │  │ 1  │ 2  │ 3  │      │ │  ┌──┐  ┌──┐  ┌──┐              │ │
│ │  └────┴────┴────┘      │ │  │A1│  │B2│  │A3│  ← 拖拽排序   │ │
│ │  [+ 添加文件]          │ │  └──┘  └──┘  └──┘              │ │
│ └────────────────────────┘ └────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │  设置                                                       │ │
│ │  · 转场：crossfade ▼  · BGM：[上传]  · 字幕：[生成]  · 输出：1080P ▼ │ │
│ └────────────────────────────────────────────────────────────┘ │
│ 进度: ████████░░ 78%  (converting)         [取消]             │
└────────────────────────────────────────────────────────────────┘
```

### 6.3 智剪向导 UI

```
步骤: ① 上传片段 → ② 选择剧本 → ③ 智能分析 → ④ 确认方案 → ⑤ 导出
```

---

## 7. 实施路线图（**v2 全栈 Rust 化**）

### Phase 1：基础设施 + 后端骨架（2 周）

| 任务 | 工作量 | 依赖 |
|---|---|---|
| 创建 `aigc-claw/backend-rs/` Cargo workspace | 0.5 天 | — |
| aigc-framework 基础（StateMachine、SessionManager、Pipeline） | 3 天 | — |
| axum router 骨架 + 10 端点 stub | 2 天 | framework |
| config.yaml + .env 加载（兼容原 schema） | 1 天 | — |
| NDJSON streaming 基础设施（axum::body::Body::stream） | 1 天 | axum |
| prompts/ 嵌入（`include_str!`）+ 加载器 | 0.5 天 | — |
| PipelineOrchestrator + BaseAgent trait | 2 天 | framework |
| **单元测试**：10 端点返回正确 schema | 1 天 | 上述 |
| **集成测试**：axum 启动后 6 阶段 e2e（agent 用 mock provider） | 1 天 | 上述 |

### Phase 2：Provider Rust 化（2-3 周）

| 任务 | 工作量 | 依赖 |
|---|---|---|
| LLM Provider trait + OpenAI 兼容基类（reqwest） | 2 天 | Phase 1 |
| LLM Provider 6 家：DeepSeek / Qwen / GLM / Kimi / iSigning / MiniMax(text) | 3 天 | trait |
| Image Provider trait + Wan / Jimeng / Seedream | 3 天 | trait |
| Video Provider trait + Kling / Wan | 2 天 | trait |
| Video Hailuo v1（MiniMax v1 API）— 已有设计 | 2 天 | trait |
| Video Hailuo v2（H3）— 已有设计 | 2 天 | trait |
| Video SelfHost（sglang/vllm）— 已有设计 | 1 天 | trait |
| VLM Provider trait + Qwen-VL / Gemini-VL（multipart） | 2 天 | trait |
| **单元测试**：每个 Provider mock HTTP server 测试 | 3 天 | 上述 |
| **集成测试**：真实 API smoke（Hailuo 已跑通） | 1 天 | 上述 |

### Phase 3：6 Stage Agents Rust 化（2-3 周）

| 任务 | 工作量 | 依赖 |
|---|---|---|
| ScriptWriterAgent（含 suggest_expand / logline_selection / mode_selection） | 2 天 | Phase 2 LLM |
| CharacterDesignerAgent（LLM 分析 → Image 生成） | 2 天 | Phase 2 LLM+Image |
| StoryboardAgent（分镜 + visual prompt） | 2 天 | Phase 2 LLM |
| ReferenceGeneratorAgent（首帧图 + 多图评估） | 3 天 | Phase 2 LLM+Image |
| VideoDirectorAgent（含 preview_first 两阶段） | 3 天 | Phase 2 Video |
| VideoEditorAgent（SRT 生成 + ffmpeg 拼接 + crossfade + 字幕烧录） | 3 天 | Phase 2 LLM+Video |
| **跨阶段同步**（storyboard → reference → video） | 1 天 | 上述 |
| 9 停点逻辑（Intervention 协议） | 2 天 | 上述 |
| **集成测试**：6 阶段 e2e 真实 API（视频生成端到端） | 2 天 | 上述 |

### Phase 4：壳集成 + bundled ffmpeg（1-2 周）

| 任务 | 工作量 | 依赖 |
|---|---|---|
| dsh-shell 改造：拉起 Rust 后端（同 AIGC 后端进程管理） | 2 天 | — |
| bundled ffmpeg.exe 解压（首次启动） | 2 天 | — |
| 新 Tauri commands 骨架（mix_videos / smart_edit stub） | 1 天 | — |
| aigc-video-ext crate 独立编译验证 | 1 天 | — |
| 验证：壳启动 → 拉起 Rust 后端 → 10 端点可达 | 2 天 | 上述 |

### Phase 5：video_mixer（2-3 周）

| 任务 | 工作量 |
|---|---|
| MixRequest/MixResponse 类型 + Tauri command + 后端 HTTP 代理 | 1 天 |
| ffprobe 探测 + normalize（tokio 并行） | 3 天 |
| concat with transitions（8 种转场） | 5 天 |
| 字幕烧录（沿用现有 SRT） | 1 天 |
| BGM 混音 + 音量曲线 | 2 天 |
| 进度事件（emit + HTTP NDJSON） + 取消（tokio + 子进程） | 2 天 |
| 单元测试（每个转场） | 2 天 |
| E2E smoke test（CLI 入口） | 1 天 |

### Phase 6：smart_editor 启发式（2 周）

| 任务 | 工作量 |
|---|---|
| Whisper-rs 集成（首次启动下载模型） | 2 天 |
| silero-vad 或 ffmpeg silencedetect | 2 天 |
| ffmpeg scene-detect | 1 天 |
| 剧本↔transcript 对齐 | 3 天 |
| 综合评分（启发式公式） | 2 天 |
| 剪辑决策拼装 + EditDecision JSON | 2 天 |

### Phase 7：beat sync + BGM（1 周）

| 任务 | 工作量 |
|---|---|
| symphonia 解码音频 | 1 天 |
| onset 检测（能量变化率 + 自相关） | 2 天 |
| cut 对齐 beats | 1 天 |
| 评分加成 | 1 天 |

### Phase 8：新 UI（2 周）

| 任务 | 工作量 |
|---|---|
| Svelte 项目初始化 + Tailwind v4 + 路由 | 1 天 |
| 6 阶段管线 UI | 3 天 |
| 混剪工作台 | 4 天 |
| 智剪向导 | 3 天 |
| 设置页 | 1 天 |

### Phase 9：打包发布（1 周）

| 任务 | 工作量 |
|---|---|
| MSI/NSIS 打包 | 2 天 |
| 自动更新（Tauri Updater） | 2 天 |
| 用户文档 | 2 天 |

### Phase 10（可选，v2）：VLM 镜头评分

- ort + Qwen2-VL-2B 集成（ONNX）
- 替代启发式评分
- 视频超分（Real-ESRGAN Rust port）

### 总工作量估算：14-18 周（1 名全职 Rust 工程师 + 1 名前端）

vs 原 Python 方案：v1 设计 10-12 周；v2（Rust 化整个后端）增加 4-6 周。
风险评估：Rust 学习曲线 + 异步模式（tokio）+ Provider 多厂商 HTTP 兼容性测试是主要成本。

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| ffmpeg subprocess 进度解析脆弱 | 中 | 单元测试覆盖各种 ffmpeg 版本 + 容错（解析失败时不阻塞） |
| Whisper 模型首次下载失败 | 中 | 失败重试 + 离线安装包（可选） |
| bundled ffmpeg.exe 80MB 安装包过大 | 低 | 用户可选择仅下载精简版 ffmpeg |
| **Rust 迁移工作量超预期** | **高** | 分阶段：Phase 1-3 是后端迁移，Phase 4-7 是壳集成 + 新功能；任一阶段可独立 ship |
| **Provider HTTP 兼容性** | **高** | mock HTTP server 全量测试 + 真实 API 烟测（Hailuo 已跑通） |
| **tokio 异步陷阱**（Python 思维惯性） | 中 | 现有 dsh-shell 已用 tokio；Phase 1 培训 + pair programming |
| **OpenClaw Agent SKILL.md 兼容性** | **低** | API 契约保持不变；SKILL.md 不需修改 |
| **Session JSON 向后兼容** | **低** | 字段名不变；新代码读旧 session JSON 兼容 |
| tokio 任务取消不彻底（Windows 子进程） | 中 | `taskkill /T /F` + Job Object API |
| VLM 模型体积（v2 Phase 10） | 高 | v1 不引入；v2 用量化 ONNX |
| WebView2 老版 Windows 兼容性 | 低 | Win10+ 自带 WebView2 |

---

## 9. 验收标准

### 9.1 功能验收

- [ ] **壳启动** → 自动拉起 **Rust** AIGC 后端（端口 8000）+ 显示主窗口
- [ ] **Rust 后端独立运行**：`cargo run -p aigc-server` 可单独启动，**不依赖壳**
- [ ] 现有 6 阶段流程不变（端到端可生成完整视频，产出与 Python 版一致）
- [ ] 现有 OpenClaw Agent 可继续调用（SKILL.md 不修改）
- [ ] 旧 session JSON 可继续编辑
- [ ] 混剪：上传 3+ 片段 → 选转场 → 选 BGM → 选字幕 → 输出 1080P MP4，进度可取消
- [ ] 智剪：上传 3+ 片段 + 粘贴剧本 → 自动分析 → 输出剪辑决策 → 一键导出
- [ ] 8 种转场全部可用
- [ ] 字幕烧录可正确显示（字体清晰，无乱码）
- [ ] BGM 混音可调音量 + 自动 ducking
- [ ] 进度事件 ≤ 500ms 一次，前端进度条平滑
- [ ] 取消能立即停止 ffmpeg 子进程
- [ ] **API 兼容性**：用 Python 版 API 测试脚本调 Rust 版应得到相同响应

### 9.2 非功能验收

- [ ] 安装包 ≤ 85MB（dsh 1.5MB + ffmpeg 80MB + 小模型 + Rust 后端 ~3MB）
- [ ] 首次启动下载 Whisper 模型有进度提示
- [ ] Windows 10/11 + WebView2 兼容
- [ ] 中文 UI + 中文 SRT 字幕无乱码
- [ ] MSI + NSIS 双格式安装包
- [ ] **Rust 后端单文件部署**：无 Python 依赖
- [ ] **编译产物可重现**：`cargo build --release` 产出固定二进制

### 9.3 性能验收（目标）

- 6 阶段完整管线 ≤ Python 版同等场景时间（基准对比）
- 单 agent 调用延迟 ≤ Python 版（tokio 异步应更优）
- 5 个 6s 片段混剪（1080P crossfade + 字幕）≤ 60 秒
- 智剪 5 个 6s 片段 ≤ 30 秒（不含导出）
- Whisper 转录 6s 音频 ≤ 10 秒（base 模型，CPU）
- 内存峰值 ≤ 1GB

### 9.4 兼容性验收

- [ ] **API 契约**：用 Python 后端版本的 SKILL.md 测试 Rust 后端，所有 9 停点正常
- [ ] **Session 格式**：用旧 Python 产生的 session.json，Rust 后端可读可写
- [ ] **配置兼容**：原 config.yaml + .env 无需修改即可被 Rust 后端读取
- [ ] **制品路径**：原 `code/result/...` 路径不变
- [ ] **LLM Provider**：DeepSeek/Qwen/GLM/Kimi/iSigning 全部烟测通过
- [ ] **Video Provider**：Hailuo v1 / Hailuo v2 / Kling / Wan 至少 1 家烟测通过

---

## 10. 附录

### 10.1 关键参考实现

| 项目 | URL | 借鉴 |
|---|---|---|
| dsh-client-shell | `E:\code\ai\dsh-client-shell` | 子进程拉起 + 端口探测 + 进度 emit + 中文 CSP |
| velocut | https://github.com/Eric-Lautanen/velocut | Rust 视频编辑器完整参考：8 转场、HW 编码优先级、滤镜管线 |
| avio | https://github.com/itsakeyfut/avio | Rust FFmpeg 安全封装，HW 加速 |
| whisper-rs | https://docs.rs/whisper-rs | 本地转录 |
| OpusClip | https://www.opus.pro/clipanything | 智剪产品参考（多模态 AI、auto-reframe、scene detect） |

### 10.2 决策日志

| 决策 | 替代方案 | 理由 |
|---|---|---|
| **后端全栈 Rust**（v2 升级） | 保留 Python 后端 | 用户明确要求 + Rust 性能/部署优势 |
| **axum 0.8** web 框架 | actix-web / rocket | 异步优先、tower 中间件、tokio 原生集成 |
| **reqwest 0.12** HTTP 客户端 | hyper / ureq | 事实标准、multipart/stream 全支持 |
| **serde** 数据模型 | Pydantic | 编译时校验、零运行时开销 |
| **figment** 配置加载 | config-rs | YAML/TOML/env 多源合并 |
| **tokio 异步运行时** | async-std / smol | Rust 异步生态事实标准、与 axum/reqwest/whipser-rs 全兼容 |
| ffmpeg subprocess | ffmpeg-next binding | 0 编译成本、避开 LGPL 风险、velocut/avio 验证可行 |
| Svelte 5 前端 | React/Vue | Tauri 友好、bundle 小、编译时优化 |
| whisper-rs base | small/medium | 速度+精度平衡、中文支持 |
| v1 启发式评分（v2 VLM） | ort + Qwen2-VL | 模型 1.5GB 不值得 v1 引入 |
| **aigc-video-ext 与后端同进程** | 独立进程 | 共享 tokio runtime、进度事件直发 Tauri、资产路径共享 |
| **AIGC 后端独立进程（与壳分离）** | Tauri 内嵌 | 兼容现有部署模式、可独立运行、未来可云化 |
| **API 契约保持不变** | 重新设计 REST | OpenClaw Agent SKILL.md 不修改、零迁移成本 |

### 10.3 关联文档

- `doc/3-架构设计.md`：原架构（本设计为扩展）
- `aigc-director/SKILL.md`：OpenClaw Agent 工作流规则
- `aigc-director/aigc-claw/backend/docs/api.md`：现有 API 文档
- dsh-client-shell/README.md：壳设计模式

---

*文档结束*
*下一步：等待用户确认本设计 → 进入 Phase 1 实施*