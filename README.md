# MiniVu Desktop

MiniVu is a local image Q&A app for macOS Apple Silicon. It runs from the menu bar and opens a compact panel for one-image sessions.

## What it does

- Opens the quick panel with `⌃⌥Space` by default.
- Accepts an image from paste, drag and drop, file picker, or macOS region capture.
- Runs OCR, image Q&A, and follow-up chat locally.
- Starts loading the model in the background as soon as an image is selected.
- Uses the bundled Metal-enabled llama.cpp runtime by default. MLX VLM remains an optional experimental backend.
- Exports a session as Markdown with its image only when the user asks.

## First use

1. Open MiniVu and choose **下载均衡模型并完成配置（约 1.6 GiB）**.
2. Wait for the bundled runtime check and the Q4 model download to finish.
3. Press `⌃⌥Space` to open the quick panel.
4. Paste, drop, choose, or capture an image, then ask a question.

macOS asks for screen recording access only when region capture needs it. After granting access under **System Settings > Privacy & Security > Screen & System Audio Recording**, quit MiniVu completely and reopen it.

## Model management

The built-in Metal backend supports three MiniCPM-V 4.6 GGUF variants:

| Variant | Product label | Main model | Main model + shared mmproj |
|---|---|---:|---:|
| Q4_K_M | 均衡 | 529,101,504 bytes | about 1.53 GiB |
| Q5_K_M | 清晰 | 577,802,944 bytes | about 1.57 GiB |
| Q6_K | 高质量 | 629,548,224 bytes | about 1.62 GiB |

Only one variant is active. A downloaded file must be a regular GGUF file with the exact expected size and header before MiniVu can use it.

Switching is staged: MiniVu validates the target, starts it, and waits for a health check. If that fails, it restores the previous valid model. Old variants are removed only after a successful switch; a cleanup failure is reported without hiding the successful switch.

Canceling keeps a partial download. A later download can resume only from the same source when that source returns compatible validators and byte ranges. ModelScope downloads are restarted, and changing sources may also restart the file.

The model page reports total managed GGUF storage, including shared mmproj and partial files. **移除本地模型** stops the model service first, then removes all managed GGUF variants, shared mmproj, and partial download files. It does not remove the bundled runtime or optional MLX files.

See [Model management](docs/model-management.md) for the full behavior and disk details.

## Privacy

Images, OCR, questions, answers, and chat stay on this Mac. MiniVu connects to the network only when the user starts a download or install, runs a mirror speed test, or checks for updates. Manual exports stay in the selected local directory.

See [Local-first policy](docs/privacy/local-first-policy.md). Common fixes are in [Troubleshooting](docs/troubleshooting.md).

## App surfaces

- `quick-panel`: image intake, OCR, chat, export, and temporary session state.
- `main`: first-use setup, settings, model management, and privacy information.
- Floating entry: collapsing the quick panel leaves a small launcher that can reopen it.

## Development

```bash
npm install
npm run dev
npm run tauri dev
```

Checks:

```bash
npm test
npm run build
cd src-tauri && cargo fmt --check && cargo check
```

Important paths:

- React entry: `src/App.tsx`
- Quick panel: `src/app-shell/QuickPanelShell.tsx`, `src/chat/ChatPanel.tsx`
- Session hook: `src/chat/useImageSession.ts`
- Model lifecycle: `src-tauri/src/model_lifecycle.rs`
- Model cache and size constants: `src-tauri/src/model_cache.rs`
- Inference orchestration: `src-tauri/src/inference/session.rs`
- Bundled runtime: `src-tauri/resources/llama/`

## Current scope

MiniVu v0.1 supports single-image local Q&A on macOS Apple Silicon. It has no accounts, sync, cloud inference fallback, default history, mobile support, or multi-image chat.
