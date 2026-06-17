# MiniVu 领域术语

本地识图问答应用（Tauri + React + Rust）。以下术语在前后端共用，修改时需保持对齐。

## InferenceBackend

推理后端枚举：

| 值 | 含义 | 侧车端口 |
|---|---|---|
| `llama` | llama.cpp + GGUF + mmproj | 18765 |
| `mlx` | MLX VLM（Apple Silicon） | 18766 |

Rust: `settings::InferenceBackend`  
前端: `"llama" | "mlx"`

## EnvironmentStatus

环境是否「可正常使用」的单一判定来源（替代仅检查 GGUF 的 `is_model_ready`）。

- `onboardingComplete` — 用户完成引导
- `runtimeReady` — 当前后端的推理引擎已安装（llama-server 或 MLX venv）
- `modelReady` — 当前后端的模型权重已就绪
- `environmentReady` — 以上全部满足

Rust: `environment::EnvironmentStatus`  
命令: `get_environment_status`, `is_app_environment_ready`

## ModelArtifacts

| 后端 | 所需文件 |
|---|---|
| Llama | `*.gguf` 主模型 + `mmproj*.gguf` |
| MLX | HuggingFace hub 缓存或本地 MLX 目录 |

Rust: `ModelPaths`, `MlxModelRef`  
就绪判断: `environment::models_ready_for_backend`

## 进度事件

| 事件名 | 用途 |
|---|---|
| `model-download-progress` | GGUF / MLX 权重下载（统一 payload） |
| `setup-progress` | 引导页各阶段（device / runtime / model / mmproj / shortcut） |
| `sidecar-load-progress` | 侧车首次加载 / 权重载入内存 |
| `model-stream` | 推理流式输出 chunk |

下载进度 percent 应在前端用 `shared/downloadProgress` 按字节单调计算，避免回跳。

## 模块边界（Rust）

```
platform_caps/     — 硬件探测
environment/       — EnvironmentStatus、models_ready_for_backend
model_download/    — GGUF / MLX 下载 + progress 发射
inference/         — health、messages、stream、backends trait
sidecar/           — ModelSidecar 进程生命周期
model_sidecar/     — Tauri 命令 facade（ask_image、get_model_status 等）
setup/             — 引导编排（安装运行时 + 下载权重）
```

## 前端 seam

- `model/modelClient.ts` — 推理 invoke + 事件监听
- `model/types.ts` — 与 Rust 响应对齐的类型
- `shared/modelConstants.ts` — 预期下载字节数
- `shared/downloadProgress.ts` — 进度 percent 计算
