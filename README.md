# MiniVu Desktop

MiniVu is a macOS-first local image Q&A assistant built with Tauri, React, TypeScript, and Rust. It runs from the menu bar and opens a compact always-on-top quick panel for asking questions about one image at a time.

## What It Does

- Opens a quick panel near the cursor with a global shortcut.
- Accepts one image per temporary session from paste, drag and drop, file picker, or macOS region capture.
- Runs OCR locally with macOS Vision.
- Answers questions locally through a bundled Metal-enabled inference service.
- Uses the bundled llama.cpp runtime with selectable MiniCPM-V 4.6 GGUF variants + mmproj by default, with optional MLX VLM as an advanced experimental acceleration package.
- Streams answers into a linear transcript and supports follow-up questions about the same image.
- Exports a session manually as Markdown plus the image attachment.
- Keeps settings, model management, onboarding, and privacy information in the main window.

## Privacy Model

MiniVu is local-first:

- Images, OCR text, prompts, answers, filenames, exports, and chat history are not uploaded.
- Network access is used only after an explicit user action, such as model download, model update, optional MLX setup, or mirror speed testing.
- Conversation history is not saved by default.
- Exports are written only to a user-selected local directory.

See [local-first-policy.md](../../docs/privacy/local-first-policy.md) for the detailed policy.

## App Surfaces

- `quick-panel`: compact 380 x 620 window, frameless, transparent, always on top, resizable. It owns image intake, OCR, chat, export, and temporary session state.
- `main`: settings and onboarding window. The app centers it as a wider product console when presenting from Rust window commands.
- Floating entry: closing/collapsing the quick panel turns it into a small 56 x 56 launcher that can reopen the panel.

## Development

```bash
npm install
npm run dev
npm run tauri dev
```

Useful checks:

```bash
npm run build
npm test
```

## Important Paths

- React entry: `src/App.tsx`
- Quick panel: `src/app-shell/QuickPanelShell.tsx`, `src/chat/ChatPanel.tsx`
- Session hook: `src/chat/useImageSession.ts`
- Model IPC client: `src/model/modelClient.ts`
- Tauri command registration: `src-tauri/src/lib.rs`
- Inference session orchestration: `src-tauri/src/inference/session.rs`
- Bundled Metal runtime: `src-tauri/resources/llama/`

## Current Product Scope

MiniVu v0.1 is focused on single-image local Q&A for macOS Apple Silicon. It does not include accounts, sync, cloud inference fallback, default history, mobile support, or multi-image chat.
