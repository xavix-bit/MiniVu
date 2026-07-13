# Quick Panel And Product Language Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix packaged OCR, make the quick panel resilient and easy to use, and replace internal model terminology with concise user-facing language.

**Architecture:** Keep native OCR as a bundled macOS helper resolved from Tauri resources. Consolidate UI state and recovery behavior inside the existing chat hook/components, while keeping product-copy changes within their owning app-shell, settings, and privacy modules. Technical model identifiers remain available only where a compatibility choice genuinely requires them.

**Tech Stack:** React, TypeScript, Vitest, CSS, Tauri 2, Rust, Swift Vision, GitHub Actions

---

### Task 1: Lock Down Packaged OCR

**Files:**
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/src/ocr_macos.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/.gitignore`

- [ ] **Step 1: Add resolver and cleanup tests**

Cover release resource resolution, helper arguments, and temporary image deletion on success and failure in `ocr_macos.rs`.

- [ ] **Step 2: Run the focused Rust tests**

Run: `cargo test ocr_macos --manifest-path src-tauri/Cargo.toml`
Expected: tests fail before the helper is bundled and pass after implementation.

- [ ] **Step 3: Compile and bundle the native helper**

Compile `src-tauri/scripts/ocr.swift` with `xcrun swiftc` from `build.rs`, add the resulting executable to Tauri resources, and resolve it from `resource_dir()` in release builds.

- [ ] **Step 4: Verify the release app contents**

Run: `npm run tauri build -- --bundles app`
Expected: `MiniVu.app/Contents/Resources/ocr-helper` exists, is executable, and the app binary does not contain `/Users/runner/work/MiniVu` or `/usr/bin/swift`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/build.rs src-tauri/src/ocr_macos.rs src-tauri/tauri.conf.json src-tauri/.gitignore
git commit -m "fix: bundle native OCR helper"
```

### Task 2: Make Quick Panel Actions Safe And Recoverable

**Files:**
- Modify: `src/chat/ChatPanel.tsx`
- Modify: `src/chat/useImageSession.ts`
- Modify: `src/chat/PanelHeader.tsx`
- Modify: `src/chat/QuickActions.tsx`
- Modify: `src/chat/Composer.tsx`
- Modify: `src/chat/RecognizedTextPanel.tsx`
- Modify: `src/chat/TranscriptPanel.tsx`
- Modify: `src/styles/quick-panel.css`
- Test: `src/chat/*.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Add tests proving that image replacement, paste, drop, and clear are blocked while answering; recognition failure offers retry; empty recognition is visible; and a failed answer keeps the user question.

- [ ] **Step 2: Run focused frontend tests**

Run: `npm test -- --run src/chat`
Expected: new tests fail against the current behavior.

- [ ] **Step 3: Implement stable session behavior**

Guard image-changing operations while answering, keep failed questions in the transcript, expose OCR retry, and map screenshot/OCR/answer failures to short recoverable messages without raw backend output.

- [ ] **Step 4: Simplify the action hierarchy**

Render the header items as actions without a persistent selected state, use one Stop action, disable the composer until an image exists, and keep Screenshot as the primary empty-state command with Paste and Choose Image secondary.

- [ ] **Step 5: Fix compact-window layout**

Use one primary scroll region, remove per-token smooth scrolling, maintain 44px interactive targets, and keep text/image/status regions readable at the minimum panel size.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- --run src/chat`
Expected: all chat tests pass.

```bash
git add src/chat src/styles/quick-panel.css
git commit -m "fix: simplify quick panel recovery flows"
```

### Task 3: Replace Internal Terminology Across Product Surfaces

**Files:**
- Modify: `src/app-shell/HomeOverview.tsx`
- Modify: `src/app-shell/EnvironmentSetupPanel.tsx`
- Modify: `src/app-shell/Sidebar.tsx`
- Modify: `src/settings/ModelPanel.tsx`
- Modify: `src/settings/SettingsPanel.tsx`
- Modify: `src/privacy/PrivacyNotice.tsx`
- Modify: related component tests and styles only where needed

- [ ] **Step 1: Write copy assertions**

Add tests for the visible labels `本机处理`, `图片理解`, `首次设置`, `下载内容`, `文字识别`, and `已用空间`, and assert that default surfaces do not show Metal, GGUF, MLX, runtime, weights, projector, or raw errors.

- [ ] **Step 2: Run focused component tests**

Run: `npm test -- --run src/app-shell src/settings src/privacy`
Expected: new copy assertions fail before implementation.

- [ ] **Step 3: Rewrite navigation, home, and setup copy**

Describe capabilities and next actions in user terms. Map setup progress to fixed stages: `设备检查`, `应用组件`, `图片理解`, and `快捷键`; never display backend progress strings directly.

- [ ] **Step 4: Simplify model and settings surfaces**

Use `标准`, `高精度`, and `最高精度` with exact download/storage sizes. Rename storage and download controls in user terms, and place compatibility identifiers under a collapsed `高级设置` section only when selection requires them.

- [ ] **Step 5: Map errors to recovery actions**

Replace interpolated `String(error)` output with stable messages and actions such as `重试`, `打开设置`, `重新启动`, or `清理空间`.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- --run src/app-shell src/settings src/privacy`
Expected: all selected tests pass.

```bash
git add src/app-shell src/settings src/privacy
git commit -m "refactor: use product language across settings"
```

### Task 4: Full Verification And Release Artifact

**Files:**
- Verify: `.github/workflows/release.yml`
- Verify: generated `src-tauri/target/release/bundle/macos/MiniVu.app`

- [ ] **Step 1: Run all frontend checks**

Run: `npm test -- --run && npm run build`
Expected: all tests pass and the production frontend builds.

- [ ] **Step 2: Run all native checks**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check && cargo test --manifest-path src-tauri/Cargo.toml && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: formatting, tests, and checks pass.

- [ ] **Step 3: Build and inspect the macOS app**

Run: `npm run tauri build -- --bundles app`
Expected: app builds, `ocr-helper` is executable, code signing verifies, and no runner source path is embedded.

- [ ] **Step 4: Visually inspect the quick panel**

Open the built app and check empty, screenshot, recognizing, recognition failure, answering, and stopped states at the minimum window size. Expected: no overlap, clipped text, duplicate actions, or raw technical messages.

- [ ] **Step 5: Push and build in GitHub Actions**

Push `codex/model-lifecycle`, dispatch `release.yml`, download the macOS artifact, mount the DMG, and repeat the OCR helper and code-signature inspection on the downloaded artifact.

- [ ] **Step 6: Open the verified installer**

Open the downloaded DMG so the updated MiniVu build is ready for the user to install and inspect.
