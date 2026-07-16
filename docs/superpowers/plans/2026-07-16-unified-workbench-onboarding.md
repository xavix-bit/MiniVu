# Unified Workbench And First Capture Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make screenshot controls distinct, keep Settings inside the workbench frame, and lead new users through a real screenshot before offering an on-demand model install.

**Architecture:** `MainWindowShell` owns a persistent rail and three shell modes (`welcome`, `workbench`, `settings`). The workbench and settings surfaces remain mounted so selection, drafts, zoom, and scroll survive navigation. Pure viewport math, first-run presentation, settings navigation, and model-required routing live in focused modules with component and integration tests.

**Tech Stack:** React 19, TypeScript, CSS, Lucide React, Tauri 2, Rust/Serde settings, Vitest, Testing Library.

---

## File Map

- Create `src/workbench/canvasViewport.ts`: pure zoom, fit, and centering calculations.
- Modify `src/workbench/CaptureCanvas.tsx`: connect real fit and 1:1 controls to the canvas.
- Create `src/app-shell/AppRail.tsx`: permanent recent, pinned, and settings navigation.
- Create `src/app-shell/SettingsNavigationPane.tsx`: compact settings category list.
- Create `src/app-shell/FirstRunWelcome.tsx`: first screenshot welcome and permission recovery.
- Create `src/settings/ModelPreferencesPanel.tsx`: model engine and download-source preferences extracted from general settings.
- Modify `src/app-shell/MainWindowShell.tsx`: own shell mode, settings section, capture onboarding, and return context.
- Modify `src/workbench/WorkbenchShell.tsx`: accept external scope, model readiness, and onboarding tip state.
- Modify `src/workbench/CaptureInspector.tsx`: expose contextual tips and model-required action without attempting inference.
- Modify `src/settings/SettingsPanel.tsx`: render only general or shortcut preferences.
- Modify `src/settings/ModelPanel.tsx`: report full status after installation and expose runtime repair.
- Modify `src/settings/settingsStore.ts` and `src-tauri/src/settings.rs`: persist contextual-tip completion with backward-compatible defaults.
- Modify `src/image/captureScreen.ts`: classify cancellation and permission errors and open System Settings only on explicit action.
- Modify `src/styles/workbench.css`, `src/styles/settings.css`, and `src/styles/polish.css`: shared shell, compact settings, onboarding, transitions, and reduced motion.
- Modify `tests/WorkbenchShell.test.tsx` and `tests/MainWindowShell.test.tsx`: navigation, first-run, tips, and model-routing behavior.
- Create `tests/canvasViewport.test.ts`: viewport unit coverage.
- Create `tests/captureScreen.test.ts`: screenshot error classification.

### Task 1: Distinct Canvas Viewport Controls

**Files:**
- Create: `src/workbench/canvasViewport.ts`
- Modify: `src/workbench/CaptureCanvas.tsx`
- Modify: `src/styles/workbench.css`
- Create: `tests/canvasViewport.test.ts`

- [x] **Step 1: Write failing viewport tests**

```ts
import { describe, expect, it } from "vitest";
import { clampZoom, fitViewport, oneToOneViewport } from "../src/workbench/canvasViewport";

describe("canvas viewport", () => {
  it("fits a landscape image inside the stage with an inset", () => {
    expect(fitViewport({ width: 1600, height: 900 }, { width: 800, height: 600 }, 32)).toEqual({
      zoom: 0.46,
      offset: { x: 0, y: 0 },
    });
  });

  it("fits portrait images by height and clamps supported zoom", () => {
    expect(fitViewport({ width: 600, height: 1200 }, { width: 900, height: 700 }, 32).zoom).toBeCloseTo(0.53, 3);
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(0.1)).toBe(0.4);
  });

  it("returns a centered one-to-one viewport", () => {
    expect(oneToOneViewport()).toEqual({ zoom: 1, offset: { x: 0, y: 0 } });
  });
});
```

- [x] **Step 2: Run the test and verify it fails**

Run: `npm test -- tests/canvasViewport.test.ts`

Expected: FAIL because `canvasViewport.ts` does not exist.

- [x] **Step 3: Implement pure viewport math**

```ts
export type CanvasSize = { width: number; height: number };
export type CanvasViewport = { zoom: number; offset: { x: number; y: number } };

export function clampZoom(value: number) {
  return Math.min(4, Math.max(0.4, value));
}

export function fitViewport(image: CanvasSize, stage: CanvasSize, inset = 32): CanvasViewport {
  const availableWidth = Math.max(1, stage.width - inset * 2);
  const availableHeight = Math.max(1, stage.height - inset * 2);
  return {
    zoom: clampZoom(Math.min(availableWidth / image.width, availableHeight / image.height)),
    offset: { x: 0, y: 0 },
  };
}

export function oneToOneViewport(): CanvasViewport {
  return { zoom: 1, offset: { x: 0, y: 0 } };
}
```

- [x] **Step 4: Connect the canvas UI**

In `CaptureCanvas.tsx`, keep refs for the stage and image natural size. On image load and on `record.id` changes, call `fitViewport`. Replace the clickable percentage with:

```tsx
<output className="capture-canvas__zoom" aria-label="当前缩放比例">
  {Math.round(viewport.zoom * 100)}%
</output>
<button type="button" title="适合窗口" aria-label="适合窗口" onClick={fitImage}>
  <Maximize2 size={16} />
</button>
<button type="button" className="capture-canvas__actual" title="原始大小" aria-label="原始大小" onClick={() => setViewport(oneToOneViewport())}>
  1:1
</button>
```

Use `ResizeObserver` to re-fit only while the current viewport is in automatic-fit mode. Manual zoom or pan exits that mode. Remove `RotateCcw` and its duplicate handler.

- [x] **Step 5: Run focused tests and build**

Run: `npm test -- tests/canvasViewport.test.ts tests/WorkbenchShell.test.tsx && npm run build`

Expected: viewport tests pass and TypeScript/Vite build succeeds.

- [x] **Step 6: Commit**

```bash
git add src/workbench/canvasViewport.ts src/workbench/CaptureCanvas.tsx src/styles/workbench.css tests/canvasViewport.test.ts
git commit -m "fix: distinguish screenshot viewport controls"
```

### Task 2: Permanent Rail And Unified Navigation

**Files:**
- Create: `src/app-shell/AppRail.tsx`
- Create: `src/app-shell/SettingsNavigationPane.tsx`
- Modify: `src/workbench/WorkbenchShell.tsx`
- Modify: `src/app-shell/MainWindowShell.tsx`
- Modify: `src/styles/workbench.css`
- Modify: `src/styles/settings.css`
- Modify: `tests/WorkbenchShell.test.tsx`
- Modify: `tests/MainWindowShell.test.tsx`

- [x] **Step 1: Add failing shell navigation tests**

Add assertions that the `工作台导航` element remains the same DOM node after opening Settings, that Settings marks its rail button active, and that clicking `固定` while Settings is visible returns to the workbench with pinned scope.

```ts
const rail = await screen.findByRole("navigation", { name: "工作台导航" });
fireEvent.click(screen.getByRole("button", { name: "设置" }));
expect(await screen.findByRole("navigation", { name: "设置导航" })).toBeVisible();
expect(screen.getByRole("navigation", { name: "工作台导航" })).toBe(rail);
expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("aria-current", "page");
fireEvent.click(screen.getByRole("button", { name: "固定" }));
expect(screen.getByTestId("workbench-instance")).toBeVisible();
```

- [x] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/MainWindowShell.test.tsx tests/WorkbenchShell.test.tsx`

Expected: FAIL because the rail is still owned by `WorkbenchView` and Settings renders a separate sidebar.

- [x] **Step 3: Create the permanent rail**

Implement `AppRail` with this public contract:

```ts
export type AppRailMode = "recent" | "pinned" | "settings";

type AppRailProps = {
  active: AppRailMode;
  disabled?: boolean;
  onNavigate: (mode: AppRailMode) => void;
};
```

Render the existing logo and Lucide `Clock3`, `Pin`, and `Settings` controls. Use `aria-current="page"` on the active command and preserve tooltips.

- [x] **Step 4: Externalize workbench scope**

Change `WorkbenchViewProps` to receive:

```ts
scope: "recent" | "pinned";
onScopeChange: (scope: "recent" | "pinned") => void;
```

Remove the rail and local scope state from `WorkbenchView`. Keep drafts, active requests, library state, and selection mounted inside `WorkbenchShell`.

- [x] **Step 5: Create compact settings navigation**

`SettingsNavigationPane` exports:

```ts
export type SettingsSection = "general" | "model" | "shortcut" | "privacy";

type SettingsNavigationPaneProps = {
  active: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
};
```

Render exactly `通用`, `模型`, `快捷键`, and `隐私` in a 260-pixel pane using the same title, border, active inset, focus, and spacing language as `CaptureList`.

- [x] **Step 6: Recompose MainWindowShell**

Use one shell grid:

```tsx
<div className="unified-app-shell">
  <AppRail active={railMode} disabled={mode === "welcome"} onNavigate={handleRailNavigate} />
  <div className="unified-app-shell__content">
    <section className={surfaceClass("workbench")} inert={mode !== "workbench"}>...</section>
    <section className={surfaceClass("settings")} inert={mode !== "settings"}>
      <SettingsNavigationPane ... />
      <main className="unified-settings-detail">...</main>
    </section>
  </div>
</div>
```

Delete the product top bar and stop rendering `SettingsSidebar`. Preserve both surfaces and focus the active main region with `preventScroll`.

- [x] **Step 7: Add shared-frame motion and reduced-motion handling**

Animate only opacity and `translateX(6px)` for 180–220 ms. The rail never transitions. Add a `@media (prefers-reduced-motion: reduce)` override that sets transform to none and duration to `1ms`.

- [x] **Step 8: Run focused tests and commit**

Run: `npm test -- tests/MainWindowShell.test.tsx tests/WorkbenchShell.test.tsx && npm run build`

Expected: tests pass, one rail stays mounted, and the frontend build succeeds.

```bash
git add src/app-shell/AppRail.tsx src/app-shell/SettingsNavigationPane.tsx src/app-shell/MainWindowShell.tsx src/workbench/WorkbenchShell.tsx src/styles/workbench.css src/styles/settings.css tests/MainWindowShell.test.tsx tests/WorkbenchShell.test.tsx
git commit -m "feat: unify workbench and settings navigation"
```

### Task 3: Compact Settings Content

**Files:**
- Create: `src/settings/ModelPreferencesPanel.tsx`
- Modify: `src/settings/SettingsPanel.tsx`
- Modify: `src/settings/ModelPanel.tsx`
- Modify: `src/app-shell/MainWindowShell.tsx`
- Modify: `src/styles/settings.css`
- Modify: `tests/MainWindowShell.test.tsx`

- [x] **Step 1: Add failing settings-category tests**

Verify each category displays only its relevant controls:

```ts
fireEvent.click(screen.getByRole("button", { name: "快捷键" }));
expect(screen.getByText("全局快捷键")).toBeVisible();
expect(screen.queryByText("自动保留")).not.toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "通用" }));
expect(screen.getByText("自动保留")).toBeVisible();
expect(screen.queryByText("GGUF 模型与下载")).not.toBeInTheDocument();
```

- [x] **Step 2: Run the test and verify failure**

Run: `npm test -- tests/MainWindowShell.test.tsx`

Expected: FAIL because one legacy panel currently mixes appearance, shortcut, inference, capture, and download controls.

- [x] **Step 3: Split general and shortcut preferences**

Give `SettingsPanel` a required `view: "general" | "shortcut"` prop. General renders theme, retention, and background preparation. Shortcut renders only `ShortcutRecorder`. Both retain the existing save operation and success feedback.

- [x] **Step 4: Extract model preferences**

Move engine selection, MLX source/runtime actions, mirror selection, and mirror benchmark into `ModelPreferencesPanel`. Its public contract is:

```ts
type ModelPreferencesPanelProps = {
  onSaved?: () => void;
};
```

Use user-facing labels (`默认`, `实验加速`, `下载来源`) and keep model IDs and exact sizes where they help the user make a choice. Remove `GGUF`, sidecar, Metal, and path language from visible labels and status summaries.

- [x] **Step 5: Make ModelPanel report installation completion**

Change `onStatusChange` to `(status: ModelStatusResponse) => void`, make `refresh()` return the fetched status, and call the callback with the refreshed result after successful downloads. Replace file-path summaries with model name, installed size, and availability.

- [x] **Step 6: Render category content inside the unified detail**

Map `general` to `<SettingsPanel view="general" />`, `shortcut` to `<SettingsPanel view="shortcut" />`, `model` to `ModelPreferencesPanel` plus `ModelPanel`, and `privacy` to `PrivacyNotice`. Runtime repair expands `EnvironmentSetupPanel` inside Model rather than navigating to a hidden setup page.

- [x] **Step 7: Apply compact styles**

Use a maximum readable width of 760 pixels, 16–20 pixel section padding, eight-pixel radii, one-pixel borders, no decorative page-header illustration, and no nested cards. Keep inputs at least 40 pixels high and actions at least 44 pixels.

- [x] **Step 8: Run tests and commit**

Run: `npm test -- tests/MainWindowShell.test.tsx tests/settingsStore.test.ts && npm run build`

Expected: category tests pass and the build succeeds.

```bash
git add src/settings/ModelPreferencesPanel.tsx src/settings/SettingsPanel.tsx src/settings/ModelPanel.tsx src/app-shell/MainWindowShell.tsx src/styles/settings.css tests/MainWindowShell.test.tsx
git commit -m "refactor: simplify settings around user tasks"
```

### Task 4: First Screenshot Onboarding

**Files:**
- Create: `src/app-shell/FirstRunWelcome.tsx`
- Modify: `src/image/captureScreen.ts`
- Modify: `src/app-shell/MainWindowShell.tsx`
- Modify: `src/styles/workbench.css`
- Create: `tests/captureScreen.test.ts`
- Modify: `tests/MainWindowShell.test.tsx`

- [x] **Step 1: Write failing screenshot classification tests**

Mock Tauri `invoke` and verify cancellation, permission, and unknown errors map to stable classes:

```ts
await expect(captureScreenRegion()).rejects.toMatchObject({ code: "cancelled" });
await expect(captureScreenRegion()).rejects.toMatchObject({ code: "permission-denied" });
expect(invoke).not.toHaveBeenCalledWith("open_screen_recording_settings");
```

- [x] **Step 2: Write failing first-run shell tests**

With `onboardingComplete: false`, expect `开始截图` and `稍后进入`. A successful capture should call `create_capture_record`, save `onboardingComplete: true`, and reveal the workbench. Cancellation should keep the welcome visible without an alert. Permission denial should show `打开系统设置` and `重试`.

- [x] **Step 3: Run tests and verify failure**

Run: `npm test -- tests/captureScreen.test.ts tests/MainWindowShell.test.tsx`

Expected: FAIL because first launch currently enters environment setup and capture errors are untyped.

- [x] **Step 4: Classify capture errors**

Export:

```ts
export class CaptureError extends Error {
  constructor(public code: "cancelled" | "permission-denied" | "unknown", message: string) {
    super(message);
  }
}

export function openScreenRecordingSettings() {
  return invoke("open_screen_recording_settings");
}
```

Map `已取消截图` to `cancelled` and screen-recording/permission text to `permission-denied`. Do not open System Settings inside `captureScreenRegion`.

- [x] **Step 5: Implement FirstRunWelcome**

Use concise props:

```ts
type FirstRunWelcomeProps = {
  shortcut: string;
  capturing: boolean;
  permissionDenied: boolean;
  onCapture: () => void;
  onSkip: () => void;
  onOpenPermissionSettings: () => void;
};
```

Render one heading, one sentence, one primary action, formatted shortcut, and a quiet skip action. Permission state replaces the sentence and actions with `打开系统设置` and `重试`. Crop corners animate once using transform/opacity.

- [x] **Step 6: Replace setup-gated startup**

In `MainWindowShell`, load settings and choose `welcome` when `onboardingComplete` is false, regardless of model state. On successful capture, create the record, dispatch OCR, save onboarding completion, and switch to workbench. Skip saves completion and opens the empty workbench. Cancellation changes no persistent state.

- [x] **Step 7: Add reduced-motion and stable layout styles**

Reserve dimensions before animation, animate only crop-corner transforms and opacity for at most 320 ms, and disable spatial movement under reduced motion.

- [x] **Step 8: Run tests and commit**

Run: `npm test -- tests/captureScreen.test.ts tests/MainWindowShell.test.tsx && npm run build`

Expected: all focused tests pass and first-run no longer depends on model readiness.

```bash
git add src/app-shell/FirstRunWelcome.tsx src/image/captureScreen.ts src/app-shell/MainWindowShell.tsx src/styles/workbench.css tests/captureScreen.test.ts tests/MainWindowShell.test.tsx
git commit -m "feat: onboard with a real first screenshot"
```

### Task 5: Contextual Tips And On-Demand Model Routing

**Files:**
- Modify: `src/settings/settingsStore.ts`
- Modify: `src-tauri/src/settings.rs`
- Modify: `src/workbench/WorkbenchShell.tsx`
- Modify: `src/workbench/CaptureInspector.tsx`
- Modify: `src/app-shell/MainWindowShell.tsx`
- Modify: `src/settings/ModelPanel.tsx`
- Modify: `src/styles/workbench.css`
- Modify: `tests/settingsStore.test.ts`
- Modify: `tests/WorkbenchShell.test.tsx`
- Modify: `tests/MainWindowShell.test.tsx`

- [x] **Step 1: Add failing persistence and routing tests**

Assert `createDefaultSettings().workbenchTipsComplete` is false. Deserialize a legacy Rust settings JSON without the field and expect false. In the workbench, submitting a question with `modelReady={false}` must not call `onAsk`; it must call `onRequireModel` with record ID and prompt and keep the draft visible.

```ts
fireEvent.change(screen.getByPlaceholderText("问这张截图…"), { target: { value: "解释这个错误" } });
fireEvent.click(screen.getByRole("button", { name: "发送" }));
expect(ask).not.toHaveBeenCalled();
expect(requireModel).toHaveBeenCalledWith({ recordId: "one", prompt: "解释这个错误" });
expect(screen.getByDisplayValue("解释这个错误")).toBeVisible();
```

- [x] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/settingsStore.test.ts tests/WorkbenchShell.test.tsx tests/MainWindowShell.test.tsx`

Expected: FAIL because tip persistence and model-required interception do not exist.

- [x] **Step 3: Add backward-compatible tip persistence**

Add `workbenchTipsComplete: boolean` to TypeScript defaults and this Rust field:

```rust
#[serde(default)]
pub workbench_tips_complete: bool,
```

Set it to `false` in `Default`. Existing installations with `onboardingComplete: true` bypass the welcome; tips appear only after the next newly created capture unless already dismissed.

- [x] **Step 4: Add two dismissible contextual tips**

`WorkbenchShell` receives `showTips` and `onTipsComplete`. After a selected capture has OCR ready, show compact anchored hints beside the Text tab and composer. Advancing or dismissing the second hint calls `onTipsComplete`; neither hint traps focus or blocks its target.

- [x] **Step 5: Intercept AI before inference**

Add to `WorkbenchViewProps`:

```ts
modelReady: boolean;
onRequireModel: (context: { recordId: string; prompt: string }) => void;
```

At the start of `ask`, if the model is unavailable, store the prompt in `drafts[record.id]`, call `onRequireModel`, and return before writing a message or creating a request ID.

- [x] **Step 6: Route to Model and return to the capture**

`MainWindowShell` stores `{ recordId, prompt } | null`, switches to Settings/Model, and passes ModelPanel a completion callback. When refreshed status reports `modelReady`, switch to workbench recent scope and select the originating record. Because WorkbenchShell stays mounted, its draft remains intact and is not sent automatically.

- [x] **Step 7: Run frontend and Rust tests**

Run: `npm test -- tests/settingsStore.test.ts tests/WorkbenchShell.test.tsx tests/MainWindowShell.test.tsx && cargo test --manifest-path src-tauri/Cargo.toml settings`

Expected: routing and legacy settings tests pass.

- [x] **Step 8: Commit**

```bash
git add src/settings/settingsStore.ts src-tauri/src/settings.rs src/workbench/WorkbenchShell.tsx src/workbench/CaptureInspector.tsx src/app-shell/MainWindowShell.tsx src/settings/ModelPanel.tsx src/styles/workbench.css tests/settingsStore.test.ts tests/WorkbenchShell.test.tsx tests/MainWindowShell.test.tsx
git commit -m "feat: install models when question tools need them"
```

### Task 6: Product Polish And Full Verification

**Files:**
- Modify: `src/styles/workbench.css`
- Modify: `src/styles/settings.css`
- Modify: `src/styles/polish.css`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-16-unified-workbench-onboarding.md`

- [x] **Step 1: Audit visible copy and interaction states**

Search visible frontend strings:

Run: `rg -n 'Metal|GGUF|sidecar|运行时|环境就绪|模型就绪|技术预览|实验模型' src --glob '*.tsx'`

Replace user-facing technical status with task language, while preserving concrete model names, file sizes, memory estimates, and deliberate `实验加速` labeling where users are choosing a backend.

- [x] **Step 2: Complete visual state coverage**

Check hover, active, focus-visible, disabled, loading, error, narrow-window, and reduced-motion rules for the rail, settings rows, welcome actions, canvas toolbar, contextual tips, and model install state. Verify text contrast and 44-pixel effective hit targets.

- [x] **Step 3: Run the complete test suite**

Run: `npm test -- --run`

Expected: all test files and tests pass with zero failures.

- [x] **Step 4: Run production builds**

Run: `npm run build`

Expected: TypeScript and Vite production build succeed.

Run: `npm run tauri build -- --debug`

Expected: Tauri debug application and DMG build successfully, including bundled OCR and model runtime resources.

- [ ] **Step 5: Launch and visually inspect**

Launch the debug application and inspect welcome, successful capture, cancelled capture, permission recovery, empty workbench, selected capture, settings transitions, model-required routing, and reduced-motion behavior. Check desktop and the narrowest supported window width. Confirm fit and 1:1 visibly produce different results on a large screenshot.

- [ ] **Step 6: Update README screenshots or workflow copy only when behavior changed**

Document first-run capture and on-demand model installation without adding technical setup prose to the product UI.

- [ ] **Step 7: Mark plan complete and commit final polish**

```bash
git add src/styles/workbench.css src/styles/settings.css src/styles/polish.css README.md docs/superpowers/plans/2026-07-16-unified-workbench-onboarding.md
git commit -m "polish: finish unified MiniVu experience"
```
