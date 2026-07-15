# MiniVu Desktop

MiniVu is a macOS-first screenshot workbench built with Tauri, React, TypeScript, and Rust. Capture is the primary workflow; local OCR and optional local AI operate on durable screenshot records after capture.

[Download MiniVu v0.2.0 for Apple Silicon](https://github.com/xavix-bit/MiniVu/releases/download/v0.2.0/MiniVu_0.2.0_aarch64.dmg)

Open the DMG and drag MiniVu into Applications. On first launch, Control-click MiniVu, choose **Open**, then confirm once. macOS 13 or later is recommended.

## Product Flow

- Press the global shortcut to start macOS region capture immediately.
- Click the draggable floating launcher to open `截图`, `粘贴`, and `最近` actions.
- Each successful capture creates an independent local record with its own image, OCR text, title, pin state, and conversation.
- OCR starts automatically. AI preparation may run in the background but never blocks capture or OCR.
- The main window is a three-column workbench: navigation, searchable screenshot list, and screenshot detail with AI/text inspector.
- Records are retained for 24 hours by default. Users may choose no history, 24 hours, 7 days, or permanent retention; pinned records never expire.

## Privacy

- Screenshots, OCR text, prompts, and answers stay on this Mac.
- Capture records live under the application data directory and are cleaned according to the selected retention policy.
- Network access is used only for explicit model download, update, optional acceleration setup, or mirror testing.
- There is no cloud inference fallback or account sync.

See [local-first-policy.md](docs/privacy/local-first-policy.md) for the detailed policy.

## App Surfaces

- `quick-panel`: one physical Tauri window with `hidden`, `pet`, `launcher`, and `expanded` modes. Pet is 56 x 56; launcher is a compact horizontal toolbar; expanded mode shows the latest capture result.
- `main`: onboarding/settings until setup is complete, then the screenshot workbench.
- Capture store: `<app-data>/captures/<record-id>/image.png`, `thumbnail.jpg`, and atomically written `metadata.json`.

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

MiniVu v0.2.0 targets Apple Silicon macOS. It includes local screenshot history, OCR, isolated per-screenshot conversations, pinning, search, and optional local image Q&A. It does not include accounts, sync, cloud inference, annotation editing, multi-image comparison, or cross-screenshot AI memory.
