# 5. AIGC 竞品分析与优化路线

> 调研时间：2026-08-20
> 调研范围：2026 年 AI 视频生成产品格局（可灵/海螺/Veo/Runway/Sora/Seedance/Wan）+ 生产级 AI 视频管线工程架构 + 开源项目模式
> 结论：**产品骨架（7 阶段全自动管线）领先，但"素材质量闭环"缺失——参考图没回填、无质量评估、无 provider 路由、无重试分级。这正是 2026 年市场从"能生成"转向"能稳定交付"的关键差距。**

---

## 1. 2026 年市场格局

### 1.1 竞争焦点已转移

**"能不能生成一段视频" → "能不能生成稳定、可控、可剪辑、可交付的素材"。**

四个代表性路线的差异化定位：

| 产品 | 路线 | 核心能力 | 单段上限 | 原生音频 | 角色一致性 |
|---|---|---|---|---|---|
| **Kling 3.0** | 中文短视频/分镜控制 | 多镜头叙事、6 镜头多场系统、运镜画笔、8 语言唇形同步 | ~3min（Extend） | 部分 | 元素一致性 ⭐⭐⭐⭐⭐ |
| **Runway Gen-4.5** | 专业创作工作台 | 平台化控制、素材管理、团队协作 | 5-10s（可延 16s） | 无 | 面部一致性良好 ⭐⭐⭐⭐ |
| **Veo 3.1 / Flow** | 导演级 | 物理模拟、原生音频+对白、Flow 串角色/场景/镜头 | 8s | **有（对白+音效）** | 中等 ⭐⭐⭐ |
| **Hailuo 2.3（当前在用）** | 高性价比批量 | 复杂动作、微表情、风格化 | 6s/10s | 无 | 中等 ⭐⭐⭐ |
| **Sora 2** | 生态型 | 物理模拟 + 同步对白/音效 | 4-12s | 有 | —（web/app 已停服，API 2026-09-24 停） |
| **Seedance 2.0** | 通用型 | **12 文件多模态输入、极强角色一致性** | — | 无 | ⭐⭐⭐⭐⭐ |
| **Wan 2.7** | 运镜/竖屏 | 电影感运镜、9:16、5 视频+9 图像参考 | — | 无 | ⭐⭐⭐⭐ |

### 1.2 三个明确趋势（与本产品强相关）

1. **原生音频 + 口型同步成为卖点**（Veo 3.1 对白、Kling 唇形同步、Sora 音画同步）——我们正用外部 TTS 补这块，方向正确但落后于原生方案。
2. **参考图 > 文字描述的一致性锚点**（Seedance 12 文件多模态、Kling Element Library、Wan 多参考）——我们只做了"参考图生成"但没做"参考图回填进视频 prompt"。
3. **工程架构从"调最好的模型" → "provider 路由 + 异步任务 + 质量评估 + 草稿先行"**。

### 1.3 工程最佳实践（生产级 AI 视频系统标准架构）

```
API Gateway → Prompt Compiler → Provider Router → Worker Queue（异步）
   → Quality Evaluator（CLIP/FVD/光流/美学分）→ Asset Store → Webhook
```

关键工程决策：
- **异步任务**：webhook 优于轮询；UI 展示 queued/generating/evaluating/ready 状态；轮询作为兜底 reconcile。
- **草稿先行成本控制**：Kling 草稿 → 自动评分 → 仅最优升级 Veo；不要每条 prompt 都发最贵模型。
- **质量评估**：CLIP-Score（语义对齐）、FVD（分布级真实感）、光流一致性（运动平滑）、美学分（视觉质量）、安全分类器。
- **provider 路由**：按质量/延迟/预算/可用性路由；供应商故障可切换降级。
- **prompt 版本化/缓存**：相同 prompt 重跑有缓存层（客户端），避免重复计费。
- **retry 预算**：防止无限重试；失败分级（配额/5xx/4xx 不同处理）。

---

## 2. 当前产品定位盘点

**dsh-aigc-video 的独特定位**（相对竞品）：把"脚本→成片"压缩成**一个 md 文件 + 一条命令**的全自动管线，7 阶段（脚本/角色/分镜/参考图/视频/配音/剪辑），支持零 LLM 的纯规则创意路径。

- 多数开源项目（MoneyPrinterTurbo 等）偏单点工具或教程
- 多数商业产品（Runway/Veo）偏单镜头生成 + 人工剪辑
- 本产品的"全自动成片"完整度在市场里少见

---

## 3. 当前产品缺陷分析（按严重度排序）

### 🔴 严重缺陷（影响核心价值交付）

**D1. 参考图生成了但没回填 —— 一致性链路断裂**
- 现状：`reference_generation` 阶段生成首帧参考图 → 但 `video_director`/`prompt_builder` 只用**文字**构建 Hailuo prompt，参考图没有作为 `image` 输入传给视频 API。
- 后果：跨镜头角色/场景一致性无保障（调研反复强调：**参考图 > 文字**，这是跨镜头一致性第一杠杆）。
- 对照：Kling Element Library 绑定主体、Wan 9 图像参考、Seedance 12 文件多模态——竞品全部做参考图回填。

**D2. 无质量评估环节 —— 生成即交付**
- 现状：Hailuo 片段下载即用，无任何自动质量门禁（CLIP-Score 对齐、清晰度、运动一致性、失败帧检测）。
- 后果：坏镜头直接进混剪，用户只能人工检查 9 个停点。
- 对照：生产级系统标配 Quality Evaluator（拒绝→重试/降级）。

**D3. Token Plan 配额硬伤（2056）**
- 现状：MiniMax Token Plan Max 配额耗尽时 API 直接拒绝，管线无降级/路由策略。
- 后果：整个产品在配额耗尽时不可用。

### 🟡 中等缺陷（影响体验与效率）

**D4. 异步任务只有轮询没有 webhook/队列**
- 现状：`creative_pipeline.ts` 逐个 submit→poll→download，串行、无任务队列、无持久化任务状态。
- 后果：20 个镜头 = 20 次长轮询，崩溃即丢进度。

**D5. 单模型单供应商锁定**
- 现状：video 只走 Hailuo-2.3，TTS 只走 MiniMax Speech，LLM 只走 isigning。
- 对照：生产级系统必备 Provider Router。调研结论：**"没有单一赢家，组合才是答案"**（1 主模型 + 1 补位 + 1 后期）。

**D6. 无重试预算与失败分级**
- 现状：`catch(() => [])` 静默吞错（smart_edit 里 scene/speech/beats 全静默降级）；视频 API 失败无分级重试。
- 后果：用户拿到空决策/缺失片段却不知道为什么。

**D7. 角色一致性仅靠 LLM 文字描述 voice_id**
- 现状：角色有 voice_id（音频一致），但视觉角色没有持久化 identity（无角色图库、无多角度参考、无 seed 复用）。
- 对照：调研三杠杆（参考图 > 固定风格句 > seed 复用）——一个都没做。

### 🟢 轻微缺陷（打磨项）

- **D8** 无 prompt 缓存/版本化（Hailuo prompt_optimizer 是服务端缓存，客户端无层）。
- **D9** 无成本估算/预算控制（提交前不知道会消耗多少 token）。
- **D10** 无竖屏(9:16)适配（Wan 2.7/Pixverse 主打 9:16，抖音/Reels 场景缺失）。
- **D11** 无自动字幕翻译/多语言（TTS 支持 36 语言，但管线无多语言字幕分支）。

---

## 4. 可优化点与实施路线（按 ROI 排序）

### P0 — 立即可做（纯代码，无新依赖）

| # | 优化 | 做法 | 价值 |
|---|---|---|---|
| 1 | **参考图回填视频 prompt** | `prompt_builder.ts` 生成 prompt 时把 ref image 路径写入 Hailuo API 的 `image` 字段（图生视频）；`video_director` 同样回填 | 一致性从 0→有，市场对标 |
| 2 | **错误分级处理** | 替换静默 `catch(() => [])`：区分"文件不存在/ffmpeg 缺失/分析无结果"；视频 API 失败按错误码分级（2056 配额→明确提示+暂停；5xx→重试 2 次退避；4xx→直接报错） | 可诊断性大幅提升 |
| 3 | **成本预估算** | 提交前计算：镜头数 × 时长档 + 台词数 × TTS 字符 → 输出预估 token/费用 | 用户决策前置 |
| 4 | **质量门禁（轻量版）** | ffmpeg 探测：片段时长/分辨率/帧数合法性 + 黑帧检测（`blackdetect` filter）；不达标自动重提交 1 次 | 坏素材拦截 |

### P1 — 中期（需要设计）

| # | 优化 | 做法 | 价值 |
|---|---|---|---|
| 5 | **Provider 路由层** | 抽象 `VideoRouter`：按预算/质量/可用性选 Hailuo(便宜) / Wan(运镜) / Kling(一致性) / Veo(音频)；TTS 同理 | 解锁多供应商、解决 2056 硬伤 |
| 6 | **任务队列 + 持久化** | 用 `node:worker_threads` 或简单 fs 队列：任务状态（queued/generating/ready/failed）+ 断点续跑 + 进度事件（NDJSON 已有基础） | 长批量不崩溃 |
| 7 | **角色视觉 identity 库** | 首帧参考图沉淀为角色图库（`code/result/chars/<name>/`），后续镜头全部回填 + 固定风格句注入每条 prompt + seed 复用 | 跨镜头一致性第二三杠杆 |
| 8 | **9:16 竖屏支持** | Hailuo/Wan 竖屏参数 + 模板化出片尺寸 | 抖音/Reels 市场 |

### P2 — 远期（产品化）

| # | 优化 | 做法 |
|---|---|---|
| 9 | **自动质量评估** | 接 CLIP-Score（`@xenova/transformers` 已安装，正是干这个的）+ 光流一致性评分，坏镜头自动重生成 |
| 10 | **原生音频尝试** | 调研 Hailuo 新版本/竞品是否支持视频内嵌对白；当前 TTS 外挂方向正确，但关注 Kling 唇形同步/Veo 原生音频趋势 |
| 11 | **Webhook 回调** | HTTP server 增加任务完成回调注册（`POST /api/tasks/{id}/webhook`） |

---

## 5. 调研来源

- AI Stack Nav《2026 AI 视频模型能力对比：可灵、Runway、Sora、海螺怎么选？》https://aistacknav.com/2026-ai-video-models-kling-runway-sora-hailuo-comparison/
- AI Stack Nav《最值得关注的 AI 视频生成工具推荐》https://aistacknav.com/ai-video-generation-tools-recommendation/
- Inkfox Blog《Best AI Video Generators in 2026》https://inkfox.app/blog/best-ai-video-generators-2026
- ImageToVideoAI《AI image to video comparison 2026》https://imagetovideoai.net/blog/ai-image-to-video-generator-comparison-2026
- QubitTool《AI Video Generation Engineering Guide》https://qubittool.com/blog/ai-video-generation-engineering-veo3-kling
- ForVideo AI《Best Text-to-Video AI in 2026》https://forvideo.ai/blog/best-text-to-video-ai-2026
- Atlas Cloud《2026 年 5 大 AI 视频 API 对比》https://www.atlascloud.ai/zh/blog/case-studies/Top-5-ai-video-apis-compared-speed-latency-and-cost-per-second-2026
- AI 工具指南《从剧本到 AI 视频：一套镜头级工作流》https://aitoolsguidebook.com/zh/articles/ai-video-from-script-workflow/