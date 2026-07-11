# MiniVu 领域术语

本地识图问答应用（Tauri + React + Rust）。以下术语在前后端共用，修改时需保持对齐。

## ImageSession

快捷面板内一次识图会话：图片、OCR、对话历史、推理状态机。

Rust: 无（纯前端）
Hook: `chat/useImageSession.ts` — `useImageSession()` 导出会话状态、`ask`、`statusBar`（模型加载 UX）

## InferenceBackend

推理后端枚举：

| 值 | 含义 | 侧车端口 | 体积与加速 |
|---|---|---|---|
| `llama` | 内置 Metal 路径：llama.cpp + MiniCPM-V 4.6 GGUF 档位 + mmproj | 18765 | 当前打包资源约 21 MB；模型约 1.6 GB；Apple Silicon 上通过 `-ngl` 使用 **Metal** |
| `mlx` | 实验加速路径：MLX VLM（Apple Silicon） | 18766 | 运行时约 300 MB（Python venv）；需额外安装与独立权重 |

**默认后端**：`llama`。产品文案对用户称为「内置 Metal 本地推理」：运行时随安装包提供，用户只下载模型。`mlx` 保留为高级/实验加速选项，不进入默认引导主路径。

Rust: `settings::InferenceBackend`  
前端: `"llama" | "mlx"`

## EnvironmentStatus

环境是否「可正常使用」的单一判定来源（替代仅检查 GGUF 的 `is_model_ready`）。

- `onboardingComplete` — 用户完成引导
- `runtimeReady` — 当前后端的推理引擎已安装（llama-server 或 MLX venv）
- `modelReady` — 当前后端的模型权重可用
- `environmentReady` — 以上全部满足

Rust: `environment::EnvironmentStatus`  
命令: `get_environment_status`, `is_app_environment_ready`

## QuickPanelMode

快捷面板窗口状态：

| 值 | 含义 |
|---|---|
| `expanded` | 380 x 620 左右的完整快捷面板，靠近鼠标打开，置顶显示 |
| `pet` | 56 x 56 的悬浮入口，点击后恢复完整面板 |
| `hidden` | 窗口隐藏；隐藏前会发出 `quick-panel-closing` 清空临时会话 |

Rust: `window::QuickPanelMode`
前端: `"expanded" | "pet" | "hidden"`
事件: `quick-panel-mode`, `quick-panel-closing`

## ModelArtifacts

| 后端 | 所需文件 |
|---|---|
| Llama | MiniCPM-V 4.6 Q4_K_M / Q5_K_M / Q6_K 主模型 + `mmproj*.gguf` |
| MLX | HuggingFace hub 缓存 |

Rust: `ModelPaths`, `MlxModelRef`  
就绪判断: `environment::models_ready_for_backend`

## 内置 llama 运行时（bundled runtime）

llama-server 及其依赖 dylib 随安装包内置，用户无需下载引擎或安装 Homebrew/Python，只需下载 GGUF 模型。面向用户时优先称为「内置 Metal 引擎」，避免把新用户暴露在后端实现细节里。

- 位置：`src-tauri/resources/llama/`（已提交入库，当前约 21 MB：`llama-server` + 9 个 `.0.dylib`）
- 链接：`@rpath` + `LC_RPATH=@loader_path` → 与同目录 dylib 平铺即可运行；Metal 已内嵌进 `libggml-metal`
- 打包：`tauri.conf.json` 的 `bundle.resources` 映射 `resources/llama/* → llama/`，落到 `<app>/Contents/Resources/llama/`
- 解析优先级：`runtime_installer::resolve_llama_server` 先查内置资源目录（去隔离 + 补可执行位），再退回下载缓存 / PATH
- 升级引擎：替换 `src-tauri/resources/llama/` 下文件并对齐 `LLAMA_RELEASE_TAG`
- MLX 不内置（Python venv 体积大且依赖系统 Python），仍为运行时可选安装

## 进度事件

| 事件名 | 用途 |
|---|---|
| `model-download-progress` | GGUF / MLX 权重下载（统一 payload） |
| `setup-progress` | 引导页各阶段（device / runtime / model / mmproj / shortcut） |
| `sidecar-load-progress` | 侧车首次加载 / 权重载入内存 |
| `model-stream` | 推理流式输出 chunk |

下载进度 percent 应在前端用 `shared/downloadProgress` 按字节单调计算，避免回跳。`onboardingProgress.ts` 负责引导多 phase 加权总体进度（消费 `downloadBytes`，不重复单文件 percent 逻辑）。

## 模块边界（Rust）

```
platform_caps/     — 硬件探测
environment/       — EnvironmentStatus、models_ready_for_backend
model_download/    — GGUF / MLX 下载 + progress 发射
inference/
  context.rs       — ActiveInferenceContext（settings + ModelCache 解析）
  session.rs       — ask_image 编排（ensure sidecar → stream → fallback）
  backends/        — SidecarBackend trait
  health.rs        — 侧车就绪轮询
  messages.rs      — 对话消息构建
  stream.rs        — SSE 流式输出
sidecar/
  process.rs       — ModelSidecar 进程生命周期
  lifecycle.rs     — 空闲卸载、预热、设置变更时 stop
model_sidecar/     — Tauri 命令 facade（薄层，委托 inference/session）
setup/             — 引导编排（安装运行时 + 下载权重）
```

## 前端 seam

- `model/modelClient.ts` — 推理与状态查询的唯一 IPC 入口：
  - 推理：`askImage` / `cancelGeneration` / `unloadWhenIdle` + `model-stream` 事件
  - 环境判定：`getEnvironmentStatus` / `isAppEnvironmentReady`（`EnvironmentStatus`，单一就绪来源）
  - 运维详情：`getModelStatus`（侧车、路径、后端细项）
  - 加载进度：`onSidecarLoadProgress`（`sidecar-load-progress` 事件）
- `model/types.ts` — 与 Rust 响应对齐的类型；`environmentReadinessPercent` 计算首页就绪度环
- `shared/modelConstants.ts` — 预期下载字节数
- `shared/downloadProgress.ts` — GGUF / MLX 单文件 percent 单调计算
- `app-shell/onboardingProgress.ts` — 引导多 phase 加权总体进度
- `image/captureScreen.ts` — 调用 Rust `capture_screen_region`，通过 macOS 本地交互截图把图片送入当前会话
- `image/imageIntake.ts` — 剪贴板、拖放、文件选择的图片读取与类型过滤
