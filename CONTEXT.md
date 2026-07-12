# MiniVu 领域术语

MiniVu 是 Tauri、React 和 Rust 实现的本地识图问答应用。前后端共用的术语和约束以本文为准。

## ImageSession

快捷面板内的一次临时会话，包含一张图片、OCR 文本、对话和推理状态。

- Hook：`chat/useImageSession.ts`
- 选择图片后立即并行启动本地 OCR 和模型预热。
- 关闭快捷面板时触发 `quick-panel-closing`，清空临时会话。
- 用户主动导出时，才把 Markdown 和图片写入所选目录。

## InferenceBackend

| 值 | 含义 | 侧车端口 |
|---|---|---:|
| `llama` | 默认路径：内置 llama.cpp + Metal + MiniCPM-V 4.6 GGUF | 18765 |
| `mlx` | 可选实验路径：MLX VLM，需另装运行时和权重 | 18766 |

面向用户时把 `llama` 称为“内置 Metal”。运行时随应用提供，首次使用只需下载 GGUF 模型和共用的视觉组件。

## EnvironmentStatus

环境可用性的单一判定来源：

- `onboardingComplete`：首次配置已完成。
- `runtimeReady`：当前后端的运行时可用。
- `modelReady`：当前后端的模型文件可用。
- `environmentReady`：以上三项均满足。

Rust：`environment::EnvironmentStatus`，命令：`get_environment_status`、`is_app_environment_ready`。

## GGUF 档位

三个档位共用 1,108,746,944 字节的 `mmproj`：

| 值 | 产品名 | 主模型字节数 | 与 mmproj 合计 |
|---|---|---:|---:|
| `q4_k_m` | 均衡 | 529,101,504 | 1,637,848,448（约 1.53 GiB） |
| `q5_k_m` | 清晰 | 577,802,944 | 1,686,549,888（约 1.57 GiB） |
| `q6_k` | 高质量 | 629,548,224 | 1,738,295,168（约 1.62 GiB） |

常量来源：Rust `model_cache::GGUF_MODEL_SPECS`、`EXPECTED_MMPROJ_BYTES`；前端镜像在 `shared/modelConstants.ts`。修改体积时两处必须同步。

`ggufModelVariant` 是唯一 active 档位。切换成功后清理其他档位的正式文件、`.part` 和来源元数据，因此稳定状态只保留一个主模型。`modelStorageBytes` 统计受管目录中的正式模型、共用 mmproj 和未完成下载，显示实际占用。

## 严格校验

GGUF 正式文件必须同时满足：

- 是常规文件，不接受符号链接；
- 字节数与档位常量完全一致；
- 文件头为 `GGUF`。

下载先写入 `.part`。通过校验后才原子提升为正式文件；替换已有文件时先保留备份，提升失败会恢复原文件。

## 下载与续传

- 取消会刷新并保留 `.part`，后续可继续尝试。
- 续传要求下载地址相同、已有 ETag 或 Last-Modified，且服务器返回匹配的 `Content-Range`。
- ModelScope 路径当前禁用续传，不对用户承诺 ModelScope 断点续传。
- 自动模式切换下载源前会清理旧 `.part`，新源可能从头下载。
- 同一时间只有一个 GGUF 下载任务；任务用 `taskId + variant` 标识，旧事件不能覆盖新任务状态。

## 安全切换与回滚

安装或切换由 `model_lifecycle` 串行执行：

1. 拒绝并发下载、并发切换和生成中的切换。
2. 下载并严格校验目标主模型与共用 mmproj。
3. 停止旧侧车，提交新档位，启动新侧车并等待健康检查。
4. 新档位失败时恢复旧设置；旧档有效时重新启动旧侧车。
5. 新档位健康后才清理旧档。清理不完整以 warning 返回，不回滚已成功的切换。

`remove_installed_models` 同样受生命周期锁保护。它先确认侧车停止，再移除所有受管 GGUF 档位、共用 mmproj、`.part` 和来源元数据。它不删除内置 llama 运行时或 MLX 缓存。

## QuickPanelMode

| 值 | 含义 |
|---|---|
| `expanded` | 完整快捷面板，靠近鼠标打开并置顶 |
| `pet` | 56 x 56 悬浮入口 |
| `hidden` | 隐藏窗口，并清空临时会话 |

Rust：`window::QuickPanelMode`，事件：`quick-panel-mode`、`quick-panel-closing`。

## 模型预热

`warmup_model_for_user_image` 不受“启动时预加载”设置影响。只要模型就绪，用户选择图片后就后台启动侧车并等待健康检查；OCR 同时进行。应用启动预热仍由 `preloadModel` 控制。

## 首次使用流程

1. 首次配置默认选择 `q4_k_m`，按钮文案为“下载均衡模型并完成配置（约 1.6 GiB）”。
2. 检查内置 Metal 运行时，下载主模型和 mmproj，注册默认快捷键 `⌃⌥Space`。
3. 配置成功后写入 `onboardingComplete`。
4. 用户用快捷键唤起面板并选择图片，MiniVu 在后台预热模型并执行本地 OCR。
5. 首次提问复用已启动的模型；会话默认不持久化。

## 隐私与联网边界

OCR、识图问答和对话在本机完成。截图临时文件和 OCR 临时文件读取后删除。联网只由用户主动下载、安装、测速或检查更新触发，可能访问 ModelScope、Hugging Face、PyPI 或 GitHub。主动导出的文件由用户自行保留。

用户说明见 `docs/privacy/local-first-policy.md`。

## 进度事件

| 事件 | 用途 |
|---|---|
| `model-download-progress` | GGUF / MLX 下载，包含任务身份和字节进度 |
| `setup-progress` | 首次配置各阶段 |
| `sidecar-load-progress` | 模型载入内存 |
| `model-stream` | 回答流式输出 |

前端用 `shared/downloadProgress` 按字节计算单文件进度；`app-shell/onboardingProgress.ts` 负责首次配置的多阶段总进度。

## 模块边界

```text
environment/          环境就绪判断
model_cache.rs        模型规格、路径、严格校验与占用统计
model_download/       下载任务、续传、切源和文件提升
model_lifecycle.rs    安装、切换、回滚、清理和移除
inference/            会话编排、后端、健康检查与流式输出
sidecar/              进程生命周期、预热和空闲卸载
setup/                首次配置
```

前端入口：

- `model/modelClient.ts`：模型 IPC。
- `model/modelLifecycle.ts`：模型页动作和任务身份判断。
- `settings/ModelPanel.tsx`：档位安装、切换、取消和移除。
- `app-shell/EnvironmentSetupPanel.tsx`：首次配置。
- `chat/useImageSession.ts`：图片会话、OCR 和图片选择后的预热。
