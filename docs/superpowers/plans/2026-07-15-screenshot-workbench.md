# Screenshot Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MiniVu a screenshot-first local workbench with durable 24-hour capture records, a direct-capture shortcut, a horizontal floating launcher, isolated per-screenshot OCR/AI sessions, and nonblocking model warmup.

**Architecture:** Rust owns screenshot files, metadata, retention, and window orchestration under the app data directory. React owns the selected-record view and optimistic UI state through a small capture repository API backed by Tauri commands and events. The existing inference engine remains intact, but its lifecycle gains guarded activity tracking and screenshot-triggered warmup.

**Tech Stack:** Tauri 2, Rust/Serde/Tokio, React 19, TypeScript, Vitest/Testing Library, lucide-react, CSS.

---

## File Map

- Create `src-tauri/src/capture_store.rs`: record schema, atomic metadata writes, image persistence, retention, CRUD commands, tests.
- Modify `src-tauri/src/screenshot.rs`: return captured bytes to the record store and expose cancellation distinctly.
- Modify `src-tauri/src/lib.rs`: register capture-store state and commands, run startup cleanup.
- Create `src/captures/types.ts`: frontend record and retention contracts.
- Create `src/captures/captureClient.ts`: typed Tauri command/event boundary.
- Create `src/captures/useCaptureLibrary.ts`: selected record, filtering, optimistic mutation, OCR generation guards.
- Create `src/workbench/WorkbenchShell.tsx`: three-column recent/pinned/settings workspace.
- Create `src/workbench/CaptureList.tsx`, `CaptureCanvas.tsx`, `CaptureInspector.tsx`: focused workbench surfaces.
- Create `src/styles/workbench.css`: stable responsive workbench dimensions and states.
- Modify `src/app-shell/MainWindowShell.tsx`: preserve onboarding/settings, replace dashboard home with workbench.
- Modify `src/app-shell/SettingsSidebar.tsx`: compact 64px workbench rail rather than dashboard navigation.
- Modify `src/app-shell/QuickPanelShell.tsx`, `src/styles/quick-panel.css`, `src-tauri/src/window.rs`: pet, horizontal launcher, and result modes.
- Modify `src-tauri/src/shortcut.rs`: direct capture on shortcut press.
- Modify `src/chat/useImageSession.ts`, `src/chat/ChatPanel.tsx`: bind the result panel to a durable record and avoid blocking on OCR/warmup.
- Modify `src-tauri/src/sidecar/process.rs`, `src-tauri/src/sidecar/lifecycle.rs`, `src-tauri/src/model_sidecar/mod.rs`: guarded 10-minute lifecycle and single-flight warmup.
- Modify `src/model/modelClient.ts`, `src-tauri/src/inference/stream.rs`: correlate streamed inference by record and request ID across Webviews.
- Modify `src-tauri/src/settings.rs`, `src/settings/settingsStore.ts`, `src/settings/SettingsPanel.tsx`: retention and background-warmup settings.
- Add focused frontend tests under `tests/` and Rust unit tests in the owning modules.

### Task 1: Durable Capture Records

**Files:**
- Create: `src-tauri/src/capture_store.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: `src-tauri/src/capture_store.rs`

- [ ] **Step 1: Write failing pure-store tests**

Cover create/load ordering, atomic update, title/OCR search, pinning, deletion, expiration, and pinned retention using a temporary directory. The contract is:

```rust
pub struct CaptureRecord {
    pub id: String,
    pub source: CaptureSource,
    pub title: Option<String>,
    pub ocr_text: String,
    pub ocr_state: OcrState,
    pub messages: Vec<CaptureMessage>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub expires_at_ms: Option<i64>,
    pub pinned: bool,
}
```

- [ ] **Step 2: Run the Rust tests and verify failure**

Run: `cargo test capture_store --manifest-path src-tauri/Cargo.toml`

Expected: compile failure because `capture_store` does not exist.

- [ ] **Step 3: Implement storage and Tauri commands**

Implement `list_capture_records`, `read_capture_image`, `create_capture_record`, `update_capture_record`, `delete_capture_record`, and `cleanup_capture_records`. Persist `image.png`, `thumbnail.jpg`, and `metadata.json`; write metadata to `metadata.json.tmp` and rename. Validate IDs before joining paths.

- [ ] **Step 4: Register commands and startup cleanup**

Add `mod capture_store`, register commands in `generate_handler!`, and run cleanup once after setup. Add only the image/ID dependency needed by this module.

- [ ] **Step 5: Run tests and commit**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml && cargo test capture_store --manifest-path src-tauri/Cargo.toml`

Commit: `feat: add durable screenshot records`

### Task 2: Frontend Capture Repository

**Files:**
- Create: `src/captures/types.ts`
- Create: `src/captures/captureClient.ts`
- Create: `src/captures/useCaptureLibrary.ts`
- Test: `tests/useCaptureLibrary.test.tsx`

- [ ] **Step 1: Write failing hook tests**

Mock the client and prove newest-first loading, normalized title/OCR search, selected-record retention, pin/delete mutations, isolated messages, and stale OCR rejection after a newer record is selected.

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- --run tests/useCaptureLibrary.test.tsx`

Expected: module-not-found failure.

- [ ] **Step 3: Implement typed client and hook**

Keep IPC in `captureClient.ts`. The hook exposes:

```ts
type CaptureLibrary = {
  records: CaptureRecordSummary[];
  selected: CaptureRecord | null;
  query: string;
  setQuery(value: string): void;
  select(id: string): Promise<void>;
  create(input: NewCaptureInput): Promise<CaptureRecord>;
  update(patch: CaptureRecordPatch): Promise<void>;
  remove(id: string): Promise<void>;
  refresh(): Promise<void>;
};
```

Use a monotonically increasing request token before applying OCR or record-detail results.

- [ ] **Step 4: Run frontend tests and commit**

Run: `npm test -- --run tests/useCaptureLibrary.test.tsx`

Commit: `feat: add screenshot library state`

### Task 3: Direct Capture And Horizontal Launcher

**Files:**
- Modify: `src-tauri/src/shortcut.rs`
- Modify: `src-tauri/src/screenshot.rs`
- Modify: `src-tauri/src/window.rs`
- Modify: `src/app-shell/QuickPanelShell.tsx`
- Modify: `src/styles/quick-panel.css`
- Test: `tests/QuickPanelShell.test.tsx`

- [ ] **Step 1: Add failing behavior tests**

Prove the pet click requests launcher mode, launcher contains only `截图`, `粘贴`, `最近`, Escape/click-away collapses it, and screenshot success opens result mode while cancellation creates nothing and stays collapsed.

- [ ] **Step 2: Implement window state machine**

Extend the mode contract to `expanded | launcher | pet | hidden`. Use a stable horizontal size, expand toward available screen space, retain the existing drag threshold, and place the result panel near the pointer without covering the pointer hot spot.

- [ ] **Step 3: Route shortcut directly to capture**

The shortcut handler starts `capture_screen_region`, creates the record, emits `capture-record-created`, and presents the result panel. Keep setup gating: an unconfigured install opens setup instead.

- [ ] **Step 4: Implement launcher UI**

Use lucide `ScanLine`, `ClipboardPaste`, and `History` icons with short labels. `最近` opens and focuses the workbench; `粘贴` creates a record from clipboard image data; icon button dimensions must not change between hover/pressed states.

- [ ] **Step 5: Test and commit**

Run: `npm test -- --run tests/QuickPanelShell.test.tsx && cargo test shortcut --manifest-path src-tauri/Cargo.toml`

Commit: `feat: make capture the primary entry action`

### Task 4: Three-Column Screenshot Workbench

**Files:**
- Create: `src/workbench/WorkbenchShell.tsx`
- Create: `src/workbench/CaptureList.tsx`
- Create: `src/workbench/CaptureCanvas.tsx`
- Create: `src/workbench/CaptureInspector.tsx`
- Create: `src/styles/workbench.css`
- Modify: `src/app-shell/MainWindowShell.tsx`
- Modify: `src/app-shell/SettingsSidebar.tsx`
- Modify: `src/styles.css`
- Test: `tests/WorkbenchShell.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover empty library, recent/pinned filters, search, record selection, AI/OCR tabs, copy text, pin/delete, per-record messages, and narrow-layout back navigation.

- [ ] **Step 2: Build the workbench surfaces**

Use a 64px rail, 260px list, flexible canvas, and 320px inspector. The screenshot is the largest visual object. The inspector has only `AI` and `文字`; AI empty state has `帮我看懂` and composer `问这张截图…`. Keep setup, models, preferences, and privacy as settings subviews rather than dashboard cards.

- [ ] **Step 3: Add canvas behavior and responsive layout**

Provide fit, zoom in/out/reset, wheel zoom, and drag pan with lucide controls and tooltips. Below the desktop breakpoint, detail replaces list and shows a back icon. Use constrained tracks and no nested cards.

- [ ] **Step 4: Connect record updates**

OCR and assistant messages write back to the selected record. Switching selection restores that record's state. Closing the quick panel must not reset/delete the durable conversation.

- [ ] **Step 5: Test, build, and commit**

Run: `npm test -- --run tests/WorkbenchShell.test.tsx tests/useImageSession.test.tsx && npm run build`

Commit: `feat: replace dashboard with screenshot workbench`

### Task 5: Nonblocking OCR And Safe Model Lifecycle

**Files:**
- Modify: `src/chat/useImageSession.ts`
- Modify: `src/chat/ChatPanel.tsx`
- Modify: `src-tauri/src/sidecar/process.rs`
- Modify: `src-tauri/src/sidecar/lifecycle.rs`
- Modify: `src-tauri/src/model_sidecar/mod.rs`
- Modify: `src-tauri/src/inference/stream.rs`
- Modify: `src/model/modelClient.ts`
- Modify: `src-tauri/src/lib.rs`
- Test: `tests/useImageSession.test.tsx`
- Test: Rust tests in `src-tauri/src/sidecar/process.rs`

- [ ] **Step 1: Add failing timing and lifecycle tests**

Prove image state commits before OCR resolves, OCR IPC is dispatched before warmup IPC, warmup is not awaited, stale OCR is ignored, streamed tokens only reach their matching `recordId + requestId`, 9:59 remains loaded, 10:00 idle unloads, and active work cannot unload.

- [ ] **Step 2: Make image intake nonblocking**

Release the capture button as soon as a record exists. Start OCR with a request generation token, then schedule warmup. Do not let a stale OCR response overwrite a newer record.

- [ ] **Step 3: Add sidecar activity guards**

Track active jobs and update `last_activity` when the final guard drops. `should_unload` returns true only when `active_jobs == 0` and idle time reaches 600 seconds. Share model startup readiness through one in-flight operation and reject stale generation completion.

Add `recordId` and `requestId` to stream/progress events and request-scoped cancellation. Both Webviews filter events before updating state; cancelling one record never cancels a different record.

- [ ] **Step 4: Remove startup preload**

Stop calling `spawn_model_warmup` during app startup. Screenshot-triggered warmup checks the background-warmup setting; explicit AI requests always cold-start if necessary.

- [ ] **Step 5: Test and commit**

Run: `npm test -- --run tests/useImageSession.test.tsx && cargo test sidecar --manifest-path src-tauri/Cargo.toml`

Commit: `perf: warm the model after capture without blocking`

### Task 6: Retention And Warmup Preferences

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src/settings/settingsStore.ts`
- Modify: `src/settings/SettingsPanel.tsx`
- Modify: `tests/settingsStore.test.ts`

- [ ] **Step 1: Add failing migration/default tests**

Default retention is `24h`, background warmup defaults off below 16 GB, and model idle timeout is fixed at 10 minutes. Existing `preloadModel` migrates to the new background-warmup meaning without startup preload.

- [ ] **Step 2: Implement settings contract**

Add `captureRetention: "none" | "24h" | "7d" | "forever"` and `backgroundWarmup: boolean`. Remove the user-facing 5/15/30/never model-retention control. Keep JSON defaults backward compatible with existing settings files.

- [ ] **Step 3: Simplify settings copy**

Present `截图保留` and `截图后提前准备识图` with one-line consequences. Avoid engine names, memory implementation details, and readiness jargon in primary UI.

- [ ] **Step 4: Test and commit**

Run: `npm test -- --run tests/settingsStore.test.ts && cargo test settings --manifest-path src-tauri/Cargo.toml`

Commit: `feat: add screenshot retention preferences`

### Task 7: Documentation, Full Verification, And Release Branch

**Files:**
- Modify: `README.md`
- Modify: `CONTEXT.md`
- Modify: relevant docs under `docs/`

- [ ] **Step 1: Update product documentation**

Describe MiniVu as a screenshot-first local workbench. Document shortcut capture, launcher actions, 24-hour history, pinning, OCR, and optional AI without exposing backend implementation in the user flow.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --debug
```

Expected: all commands pass and a debug macOS bundle is produced.

- [ ] **Step 3: Perform visual QA**

Open the packaged app and verify launcher, capture cancellation, fresh result, OCR-ready, AI answer, recent list, pinned list, settings, and narrow window. Check text contrast, clipping, scroll behavior, draggable launcher, and that no technical status copy appears in the primary workflow.

- [ ] **Step 4: Commit and push**

Commit: `docs: describe screenshot-first workflow`

Push the completed branch to `origin/codex/current-ui` and confirm the GitHub workflow starts.

## Self-Review

- Spec coverage: direct shortcut, cancellation, durable records, 24-hour retention, pinning, search, isolated conversations, horizontal launcher, three-column workbench, nonblocking OCR/warmup, 10-minute unload, settings, docs, build, and visual QA are assigned above.
- Scope remains intentionally without annotations, cloud inference, multi-image comparison, automatic AI tags, or cross-record memory.
- Type names are consistent across Rust and TypeScript boundaries; persistence is owned by Rust and UI state by the capture hook.
