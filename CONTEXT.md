# MiniVu 领域上下文

MiniVu 是 screenshot-first 的本地截图工作台（Tauri + React + Rust）。截图是持久化领域对象，OCR 与 AI 是对截图记录的异步增强。

## CaptureRecord

每次截图、粘贴、拖入或选择文件都创建独立记录：

- `id`, `source`, `title`
- `ocrText`, `ocrState`
- `messages`
- `createdAtMs`, `updatedAtMs`, `expiresAtMs`
- `pinned`

Rust 唯一负责持久化，目录为：

```text
<app-data>/captures/<record-id>/
  image.png
  thumbnail.jpg
  metadata.json
```

`metadata.json` 经临时文件、`sync_all`、rename 原子替换。默认保留 24 小时，固定记录不清理；启动和创建新记录时清理过期数据。前端通过 `capture-record-changed` 同步两个 Webview，事件不携带 base64 图片。

Rust: `capture_store.rs`

Frontend: `captures/types.ts`, `captureClient.ts`, `useCaptureLibrary.ts`

## QuickPanelMode

同一个 `quick-panel` 物理窗口在四种模式间切换：

| 值 | 用途 |
|---|---|
| `hidden` | 完全隐藏 |
| `pet` | 56 x 56 可拖动悬浮入口 |
| `launcher` | 横向 `截图 / 粘贴 / 最近` 工具条 |
| `expanded` | 当前截图的轻量结果面板 |

全局快捷键在配置完成后发出 `capture-requested`，直接进入系统框选，不先展示空面板。截图取消恢复之前的窗口模式；并发框选由 Rust guard 拒绝。

Rust: `window.rs`, `shortcut.rs`, `screenshot.rs`

Frontend: `app-shell/QuickPanelShell.tsx`

## Workbench

主窗口完成 onboarding 后进入三列工作台：

- 64px rail：最近、固定、设置
- 260px searchable list：缩略图、标题/OCR 摘要、时间
- flexible detail：截图画布 + 320px AI/文字 inspector

每条记录拥有独立消息。AI 只保留一个 composer `问这张截图…` 和一个默认动作 `帮我看懂`。不建立翻译、总结、问图等并列模式。

Frontend: `workbench/`

## InferenceBackend

内部仍保留 `llama | mlx` 两种后端。用户主流程称为「默认」与「实验加速」，不暴露 Metal、运行时、端口或侧车状态。

- `llama`: bundled llama.cpp + MiniCPM-V 4.6 GGUF + mmproj，端口 18765
- `mlx`: optional MLX VLM，端口 18766

流式事件携带 `recordId + requestId`，两个 Webview 只消费匹配请求的 token。

## Model Lifecycle

- 应用启动不加载 VLM。
- 图片先渲染，OCR IPC 先发出，随后才可选后台 warmup。
- `backgroundWarmup` 控制截图后准备；显式提问始终可以冷启动。
- active warmup/inference 通过 `SidecarActivity` 计数，绝不会被 idle unloader 中断。
- 最后一个 activity 结束时重置 idle 计时；空闲 10 分钟后释放进程。

Rust: `sidecar/process.rs`, `sidecar/lifecycle.rs`, `model_sidecar/mod.rs`

Frontend: `chat/useImageSession.ts`, `captures/processCapture.ts`

## Settings

用户可见核心设置：

- `shortcut`
- `theme`
- `captureRetention`: `none | 24h | 7d | forever`
- `backgroundWarmup`
- model selection/download and optional acceleration

旧字段 `modelWarmMinutes`, `saveHistoryByDefault`, `preloadModel` 暂留在序列化结构中用于升级兼容，但不再驱动用户界面或模型生命周期。

## 模块边界

```text
src/captures/             前端记录 IPC 与 library state
src/workbench/            主截图工作台
src/chat/                 快捷结果面板会话
src-tauri/src/capture_store.rs
                          图片/缩略图/metadata 持久化与清理
src-tauri/src/screenshot.rs
                          macOS 交互框选
src-tauri/src/inference/  请求构造、健康检查、流式输出
src-tauri/src/sidecar/    问图进程与 10 分钟生命周期
src-tauri/src/settings.rs 设置序列化与迁移默认值
```

## 不在 v0.1 范围

- 云端推理或账号同步
- 完整标注编辑器
- 多截图比较
- 跨截图 AI 记忆
- 自动 AI 标签或标题
