# MiniVu

MiniVu is a screenshot workbench for macOS. Capture part of the screen, copy its text, keep useful shots, or ask a question without leaving the app you are using.

[Download MiniVu v0.3.0 for Apple Silicon](https://github.com/xavix-bit/MiniVu/releases/download/v0.3.0/MiniVu_0.3.0_aarch64.dmg)

Open the DMG and drag MiniVu into Applications. On first launch, Control-click MiniVu, choose **Open**, then confirm once. macOS 13 or later is recommended.

## Start With A Screenshot

1. Open MiniVu and choose **开始截图**. macOS may ask for screen-recording permission once.
2. Frame any part of the screen. The screenshot is saved to the workbench and its text is recognized automatically.
3. Copy the recognized text or ask a question about the image.
4. The first question opens the model page only when a model is missing. After installation, MiniVu returns to the same screenshot and keeps the question you typed.

The floating launcher stays out of the way and provides three quick actions: `截图`, `粘贴`, and `最近`. The same global shortcut can start a capture from any app.

## Workbench

- Search recent screenshots or pin the ones you want to keep.
- Zoom, fit, view at 1:1, and drag large screenshots around the canvas.
- Switch between image questions and recognized text without losing the current draft.
- Choose a MiniCPM-V model by exact model name, download size, and memory estimate.
- Keep records for 24 hours by default, or choose no history, 7 days, or permanent retention. Pinned screenshots do not expire.

## Privacy

- Screenshots, OCR text, prompts, and answers stay on this Mac.
- Capture records live under the application data directory and are cleaned according to the selected retention policy.
- Network access is used only when you choose to download or update a model, install optional acceleration, or test a download source.
- There is no cloud inference fallback or account sync.

See [local-first-policy.md](docs/privacy/local-first-policy.md) for the detailed policy.

## Development

```bash
npm install
npm run tauri dev
```

Useful checks:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --debug
```

## Important Paths

- Workbench: `src/workbench/`
- Capture repository: `src/captures/`
- Quick panel and launcher: `src/app-shell/QuickPanelShell.tsx`
- Local capture store: `src-tauri/src/capture_store.rs`
- macOS region capture: `src-tauri/src/screenshot.rs`
- OCR/session runtime: `src/chat/useImageSession.ts`
- Model IPC client: `src/model/modelClient.ts`
- Inference orchestration: `src-tauri/src/inference/`
- Sidecar lifecycle: `src-tauri/src/sidecar/`

## Current Scope

MiniVu v0.3.0 targets Apple Silicon macOS. It includes screenshot history, text recognition, per-screenshot conversations, pinning, search, and optional local image questions. It does not include accounts, sync, cloud inference, annotation editing, or multi-image comparison.
