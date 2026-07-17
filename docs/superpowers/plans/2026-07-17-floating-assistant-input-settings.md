# Floating Assistant, IME Safety, And Compact Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn MiniVu's hidden quick-panel modes into a discoverable floating screenshot assistant, prevent Chinese IME confirmation from sending messages, compact General settings, and add useful screenshot actions.

**Architecture:** Keep the existing main and quick-panel webviews. React owns launcher, composer, and settings presentation; Rust owns main-window handoff, panel geometry, visibility, and persisted position. All settings writes continue through the serialized patch API, while pure IME and geometry behavior is locked down with focused tests before integration.

**Tech Stack:** React 19, TypeScript, Testing Library, Vitest, Tauri 2, Rust, serde, lucide-react, CSS.

---

## File Map

- Create `tests/Composer.test.tsx`: Chinese IME, Enter, and Shift-Enter regression coverage.
- Modify `src/chat/Composer.tsx`: conservative composition guard and physical Enter check.
- Modify `src/chat/QuickActions.tsx`: four post-capture commands.
- Modify `src/chat/ChatPanel.tsx`: summary and explanation prompts.
- Modify `tests/ChatPanel.test.tsx`: action-to-prompt integration coverage.
- Modify `src/settings/settingsStore.ts`: floating assistant settings types and frontend defaults.
- Modify `src-tauri/src/settings.rs`: persisted assistant setting and position migration.
- Modify `tests/settingsStore.test.ts`: frontend settings contract.
- Create `src-tauri/src/window_geometry.rs`: pure default/clamp geometry functions.
- Modify `src-tauri/src/window.rs`: panel anchor state, close-to-pet policy, mode transitions, and position persistence.
- Modify `src-tauri/src/commands.rs`: reusable serialized internal settings patch.
- Modify `src-tauri/src/lib.rs`: main close, quick-panel move/focus, and exit event wiring.
- Modify `src/app-shell/QuickPanelShell.tsx`: launcher feedback and enabled-state close behavior.
- Modify `tests/QuickLauncher.test.tsx`: launcher cancellation, clipboard, and recovery behavior.
- Create `src/settings/GeneralPreferences.tsx`: segmented theme and compact preference rows.
- Modify `src/settings/SettingsPanel.tsx`: per-field autosave, retry, and explicit shortcut save.
- Modify `tests/SettingsPanel.test.tsx`: autosave and stale-response behavior.
- Modify `src/styles/settings.css`: compact, unframed General settings layout.
- Modify `src/styles/quick-panel.css`: pet/launcher motion, feedback, and four-action layout.
- Modify `tests/MainWindowShell.test.tsx`: settings contract and window handoff integration where applicable.

### Task 1: Make The Composer Safe For Chinese IME Input

**Files:**
- Create: `tests/Composer.test.tsx`
- Modify: `src/chat/Composer.tsx`

- [x] **Step 1: Write the failing IME regression tests**

Add direct component tests that control `performance.now()` and reproduce both leaked and deliberate Enter presses:

```tsx
it("does not send when Pinyin is confirmed with Shift and leaks Enter", () => {
  const onSubmit = vi.fn();
  const now = vi.spyOn(performance, "now");
  now.mockReturnValue(100);
  renderComposer({ value: "nihao", onSubmit });

  const input = screen.getByRole("textbox");
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  fireEvent.compositionEnd(input);
  now.mockReturnValue(220);
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  expect(onSubmit).not.toHaveBeenCalled();
});

it("sends once on a later physical Enter and keeps Shift-Enter as a newline", () => {
  const onSubmit = vi.fn();
  const now = vi.spyOn(performance, "now");
  now.mockReturnValue(100);
  renderComposer({ value: "你好", onSubmit });
  const input = screen.getByRole("textbox");

  fireEvent.compositionEnd(input);
  now.mockReturnValue(400);
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  expect(onSubmit).toHaveBeenCalledOnce();
});
```

Use a `renderComposer` helper with `disabled={false}`, `canSubmit`, `isAnswering={false}`, and no-op change/stop callbacks.

- [x] **Step 2: Run the focused test and verify the leak test fails**

Run: `npm test -- tests/Composer.test.tsx`

Expected: FAIL because the existing 40 ms guard allows the delayed Enter at 120 ms.

- [x] **Step 3: Implement the conservative physical-Enter guard**

Replace the 40 ms constant and helper with:

```tsx
const IME_CONFIRMATION_GUARD_MS = 250;

function isPhysicalEnter(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  return event.code === "Enter" || event.code === "NumpadEnter";
}

function isImeConfirmation(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  compositionEndedAt: number,
) {
  return event.nativeEvent.isComposing
    || event.keyCode === 229
    || performance.now() - compositionEndedAt < IME_CONFIRMATION_GUARD_MS;
}
```

In `handleKeyDown`, return for non-Enter and Shift-Enter, require `isPhysicalEnter`, then call `event.preventDefault()` and return when the event is composing or inside the confirmation guard. Call `trySubmit()` only for the unambiguous final branch.

- [x] **Step 4: Run focused and chat tests**

Run: `npm test -- tests/Composer.test.tsx tests/ChatPanel.test.tsx tests/ChatPanel.integration.test.tsx`

Expected: all tests pass with no accidental submit.

- [x] **Step 5: Commit**

```bash
git add src/chat/Composer.tsx tests/Composer.test.tsx
git commit -m "fix: prevent IME confirmation from sending"
```

### Task 2: Add Four Useful Post-Capture Actions

**Files:**
- Modify: `src/chat/QuickActions.tsx`
- Modify: `src/chat/ChatPanel.tsx`
- Modify: `tests/ChatPanel.test.tsx`
- Modify: `src/styles/quick-panel.css`

- [x] **Step 1: Add failing integration assertions for Summary and Explain**

Extend the ChatPanel test harness to click the new commands and assert the existing `ask` mock receives task-specific prompts:

```tsx
fireEvent.click(await screen.findByRole("button", { name: "总结" }));
expect(ask).toHaveBeenCalledWith(
  expect.stringContaining("概括这张截图"),
  "总结截图",
);

fireEvent.click(screen.getByRole("button", { name: "解释" }));
expect(ask).toHaveBeenCalledWith(
  expect.stringContaining("错误或警告"),
  "解释截图",
);
```

Also assert Copy Text remains disabled until OCR text is ready and all four actions disappear after a conversation begins.

- [x] **Step 2: Run the focused test and verify the controls are missing**

Run: `npm test -- tests/ChatPanel.test.tsx`

Expected: FAIL because `总结` and `解释` are not rendered.

- [x] **Step 3: Extend QuickActions without adding modes**

Add `onSummarize` and `onExplain` props and render four icon-and-text buttons using `Copy`, `Languages`, `ListCollapse`, and `CircleHelp`. Keep a single `quick-actions` grid and the existing disabled contract.

Add handlers in `ChatPanel.tsx`:

```tsx
function handleSummarizeImage() {
  handleQuickAction(
    "请简洁概括这张截图的主要内容，按重要性列出不超过 5 点，不要复述无关细节。",
    "总结截图",
  );
}

function handleExplainImage() {
  handleQuickAction(
    "请解释这张截图。若包含错误或警告，优先说明原因、影响和下一步；否则说明最值得关注的内容。",
    "解释截图",
  );
}
```

Pass both handlers to `QuickActions`. Preserve the existing model-readiness route through `handleQuickAction`.

- [x] **Step 4: Stabilize the two-by-two layout**

Set `.quick-actions` and the quick-window override to `grid-template-columns: repeat(2, minmax(0, 1fr))`, give each button a stable minimum height, and ensure long labels cannot resize the panel.

- [x] **Step 5: Run ChatPanel and quick-panel tests**

Run: `npm test -- tests/ChatPanel.test.tsx tests/ChatPanel.integration.test.tsx tests/QuickLauncher.test.tsx`

Expected: all tests pass; no old task tabs return.

- [x] **Step 6: Commit**

```bash
git add src/chat/QuickActions.tsx src/chat/ChatPanel.tsx src/styles/quick-panel.css tests/ChatPanel.test.tsx
git commit -m "feat: add screenshot summary and explanation"
```

### Task 3: Persist Floating Assistant Preferences

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src/settings/settingsStore.ts`
- Modify: `tests/settingsStore.test.ts`

- [x] **Step 1: Add failing Rust migration tests**

Add a serializable position type and test legacy JSON with both new fields removed:

```rust
#[test]
fn legacy_settings_enable_the_floating_assistant_without_a_saved_position() {
    let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
    let fields = legacy.as_object_mut().unwrap();
    fields.remove("floatingAssistantEnabled");
    fields.remove("floatingAssistantPosition");

    let settings: AppSettings = serde_json::from_value(legacy).unwrap();
    assert!(settings.floating_assistant_enabled);
    assert_eq!(settings.floating_assistant_position, None);
}
```

- [x] **Step 2: Run Rust settings tests and verify deserialization fails**

Run: `cargo test settings::tests --manifest-path src-tauri/Cargo.toml`

Expected: FAIL because the fields and defaults do not exist.

- [x] **Step 3: Add the persisted settings contract**

In Rust:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingAssistantPosition {
    pub x: f64,
    pub y: f64,
}

fn default_floating_assistant_enabled() -> bool { true }
```

Add to `AppSettings`:

```rust
#[serde(default = "default_floating_assistant_enabled")]
pub floating_assistant_enabled: bool,
#[serde(default)]
pub floating_assistant_position: Option<FloatingAssistantPosition>,
```

Set the same defaults in `AppSettings::default()`.

In TypeScript add `FloatingAssistantPosition`, both fields to `AppSettings`, and `true`/`null` in `createDefaultSettings()`.

- [x] **Step 4: Extend the frontend settings contract test**

Assert `createDefaultSettings()` returns `floatingAssistantEnabled: true` and `floatingAssistantPosition: null`, and that `updateSettings({ floatingAssistantEnabled: false })` sends only that patch.

- [x] **Step 5: Run settings tests and production typecheck**

Run: `cargo test settings::tests --manifest-path src-tauri/Cargo.toml`

Run: `npm test -- tests/settingsStore.test.ts`

Run: `npm run build`

Expected: all pass; source mocks compile against the expanded AppSettings type.

- [x] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs src/settings/settingsStore.ts tests/settingsStore.test.ts
git commit -m "feat: persist floating assistant preferences"
```

### Task 4: Implement Window Geometry And Main-Window Handoff

**Files:**
- Create: `src-tauri/src/window_geometry.rs`
- Modify: `src-tauri/src/window.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write pure failing geometry and policy tests**

Create `window_geometry.rs` with tests specified before implementation:

```rust
#[test]
fn defaults_near_the_right_edge_and_centers_vertically() {
    assert_eq!(
        default_floating_position(1440.0, 900.0, 56.0, 16.0),
        FloatingAssistantPosition { x: 1368.0, y: 422.0 },
    );
}

#[test]
fn clamps_a_saved_position_inside_the_visible_screen() {
    assert_eq!(
        clamp_floating_position(
            FloatingAssistantPosition { x: 1500.0, y: -30.0 },
            1440.0, 900.0, 56.0, 56.0, 16.0,
        ),
        FloatingAssistantPosition { x: 1368.0, y: 16.0 },
    );
}
```

In `window.rs`, define and test the pure close policy:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MainCloseTarget { Pet, Hidden }

fn main_close_target(onboarding_complete: bool, floating_enabled: bool) -> MainCloseTarget {
    if onboarding_complete && floating_enabled {
        MainCloseTarget::Pet
    } else {
        MainCloseTarget::Hidden
    }
}
```

Assert all four boolean combinations, with only `(true, true)` returning `Pet`.

- [x] **Step 2: Run focused Rust tests and verify missing symbols**

Run: `cargo test window_geometry --manifest-path src-tauri/Cargo.toml`

Run: `cargo test window::tests --manifest-path src-tauri/Cargo.toml`

Expected: FAIL because the new module and policy do not exist.

- [x] **Step 3: Implement pure geometry**

Expose:

```rust
pub fn default_floating_position(
    screen_width: f64,
    screen_height: f64,
    pet_size: f64,
    inset: f64,
) -> FloatingAssistantPosition;

pub fn clamp_floating_position(
    position: FloatingAssistantPosition,
    screen_width: f64,
    screen_height: f64,
    window_width: f64,
    window_height: f64,
    inset: f64,
) -> FloatingAssistantPosition;
```

Clamp each axis to `[inset, screen - window - inset]`, using `inset` when the display is smaller than the requested window.

- [x] **Step 4: Reuse the serialized settings lock for internal position writes**

Extract from `commands.rs`:

```rust
pub(crate) fn update_settings_patch(
    app: &tauri::AppHandle,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    commit_settings_update(app, false, move |current| merge_settings_patch(current, patch))
}
```

Make the Tauri `update_app_settings` command delegate to it so window position and React changes cannot race on disk.

- [x] **Step 5: Extend QuickPanelState and mode positioning**

Add `anchor_position: Option<FloatingAssistantPosition>` to `QuickPanelState`. When entering pet mode:

1. Read the in-memory anchor, then saved setting, then default position.
2. Clamp it for the current display.
3. Resize to 56 by 56, set the position, show passively, and emit `Pet`.

Before expanding launcher or full panel, store the pet's current logical position. Launcher expansion keeps the anchor visible and shifts left only when its width would leave the screen.

- [x] **Step 6: Add app event handlers**

Add `window::handle_window_event(window, event)` and wire it through `.on_window_event(...)` in `lib.rs`:

```rust
match event {
    tauri::WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_WINDOW_LABEL => {
        api.prevent_close();
        handle_main_window_close(window.app_handle())?;
    }
    tauri::WindowEvent::Moved(position) if window.label() == QUICK_PANEL_LABEL => {
        record_quick_panel_position(window, *position)?;
    }
    tauri::WindowEvent::Focused(false) if current_quick_panel_mode(window.app_handle()) == QuickPanelMode::Launcher => {
        close_quick_panel(window.app_handle())?;
    }
    _ => {}
}
```

`handle_main_window_close` hides main, reads settings, and shows Pet only for completed onboarding with the assistant enabled. `show_main_window` keeps hiding the quick panel before presenting main.

On `RunEvent::Exit`, persist the latest anchor with `update_settings_patch` before stopping the sidecar.

- [x] **Step 7: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all Rust tests pass, including geometry, policy, settings migration, and existing capture restoration tests.

- [x] **Step 8: Commit**

```bash
git add src-tauri/src/window_geometry.rs src-tauri/src/window.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: hand off the main window to a floating assistant"
```

### Task 5: Finish Launcher Feedback And Mode Behavior

**Files:**
- Modify: `src/app-shell/QuickPanelShell.tsx`
- Modify: `tests/QuickLauncher.test.tsx`
- Modify: `src/styles/quick-panel.css`

- [x] **Step 1: Add failing launcher-state tests**

Cover these cases in `QuickLauncher.test.tsx`:

```tsx
async function renderLauncherMode() {
  let modeHandler: ((event: { payload: "launcher" }) => void) | undefined;
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    if (event === "quick-panel-mode") {
      modeHandler = handler as typeof modeHandler;
    }
    return vi.fn();
  });
  render(<QuickPanelShell />);
  await waitFor(() => expect(modeHandler).toBeDefined());
  act(() => modeHandler?.({ payload: "launcher" }));
}

it("keeps the launcher open and explains an empty clipboard", async () => {
  vi.mocked(readClipboardImage).mockResolvedValue(null);
  await renderLauncherMode();
  fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
  expect(await screen.findByRole("status")).toHaveTextContent("剪贴板里没有图片");
  expect(invokeMock).not.toHaveBeenCalledWith("expand_quick_panel_command");
});

it("collapses the launcher on Escape", async () => {
  await renderLauncherMode();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(invokeMock).toHaveBeenCalledWith("close_quick_panel_command");
});
```

Retain existing tests for screenshot cancellation, permission recovery, Paste, Recent, and model routing.

- [x] **Step 2: Run the focused tests and verify empty clipboard has no feedback**

Run: `npm test -- tests/QuickLauncher.test.tsx`

Expected: FAIL on the missing status message.

- [x] **Step 3: Add launcher notice state**

Give `QuickLauncher` an optional `notice` prop rendered as a concise `role="status"` row. In `handlePaste`, clear the notice before reading and set `剪贴板里没有图片` when no image exists. Clear the notice after successful actions and when mode changes away from launcher.

Keep capture cancellation silent and let Rust's mode restoration return to the launcher/pet.

- [x] **Step 4: Add restrained launcher motion**

Use a 160 ms opacity/translate transition on `.quick-launcher`, stable launcher dimensions, and a compact notice row. Disable spatial motion under `prefers-reduced-motion: reduce`. Do not add decorative gradients or additional cards.

- [x] **Step 5: Run focused tests and frontend build**

Run: `npm test -- tests/QuickLauncher.test.tsx tests/captureScreen.test.ts`

Run: `npm run build`

Expected: tests and production build pass.

- [x] **Step 6: Commit**

```bash
git add src/app-shell/QuickPanelShell.tsx src/styles/quick-panel.css tests/QuickLauncher.test.tsx
git commit -m "polish: make the floating launcher self-explanatory"
```

### Task 6: Replace General Settings With Compact Autosaving Preferences

**Files:**
- Create: `src/settings/GeneralPreferences.tsx`
- Modify: `src/settings/SettingsPanel.tsx`
- Modify: `tests/SettingsPanel.test.tsx`
- Modify: `src/styles/settings.css`

- [x] **Step 1: Replace Save-button expectations with failing autosave tests**

Add tests for:

```tsx
fireEvent.click(await screen.findByRole("radio", { name: "浅色" }));
await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ theme: "light" }));
expect(screen.queryByRole("button", { name: "保存设置" })).not.toBeInTheDocument();

fireEvent.click(screen.getByRole("checkbox", { name: "悬浮按钮" }));
await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
  floatingAssistantEnabled: false,
}));
```

Retain explicit `保存设置` assertions only for `view="shortcut"`.

Add a stale-save test with two deferred updates: resolve the older theme save after a newer retention edit and assert both current draft values remain visible. Add a failed-save test that keeps the selected value and exposes a `重试` button without raw error text.

- [x] **Step 2: Run the focused settings tests and verify they fail**

Run: `npm test -- tests/SettingsPanel.test.tsx`

Expected: FAIL because General still uses selects plus a permanent Save button.

- [x] **Step 3: Create the presentation-only GeneralPreferences component**

Use props:

```tsx
type GeneralPreferenceKey =
  | "theme"
  | "captureRetention"
  | "floatingAssistantEnabled"
  | "backgroundWarmup";

type GeneralPreferencesProps = {
  settings: AppSettings;
  disabled: boolean;
  saving: ReadonlySet<GeneralPreferenceKey>;
  onPatch: (key: GeneralPreferenceKey, patch: Partial<AppSettings>) => void;
};
```

Render `外观` with an accessible radio-group segmented control for 自动/浅色/深色. Render `使用` rows for retention, floating assistant, and early question preparation. Use native checkboxes styled as switches and keep helper text beside the label column.

- [x] **Step 4: Implement revision-safe per-field autosave**

In `SettingsPanel`, keep initial load handling and explicit shortcut submit. For General, implement:

```tsx
async function commitGeneralPatch(
  key: GeneralPreferenceKey,
  patch: Partial<AppSettings>,
) {
  const revision = ++draftRevisionRef.current;
  setSettings((current) => ({ ...current, ...patch }));
  setSavingFields((current) => new Set(current).add(key));
  failedPatchRef.current = null;
  try {
    await updateSettings(patch);
    if (mountedRef.current && revision === draftRevisionRef.current) {
      setSavedMessage("已保存");
    }
    onSaved?.();
  } catch {
    if (mountedRef.current) {
      failedPatchRef.current = { key, patch };
      setSaveError("无法保存设置，请重试。");
    }
  } finally {
    if (mountedRef.current) {
      setSavingFields((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }
}
```

Do not copy a resolved server snapshot back into the whole draft. The backend's serialized patch merge is authoritative for disk; the local draft preserves newer edits. Retry the exact failed patch.

Apply theme immediately before saving. Keep ShortcutRecorder and its explicit submit footer unchanged.

- [x] **Step 5: Replace oversized card styling**

For `.settings-preferences-panel` in General view:

- remove the duplicate internal `通用` title;
- constrain content to a readable width without a floating outer card;
- use 56-64 px preference rows with label/detail on the left and control on the right;
- use an 8 px or smaller radius for segmented items and switches;
- keep one-pixel dividers and theme tokens in both light and dark modes;
- collapse to one column below 820 px without text/control overlap.

- [x] **Step 6: Run focused and shell tests**

Run: `npm test -- tests/SettingsPanel.test.tsx tests/MainWindowShell.test.tsx`

Run: `npm run build`

Expected: all pass; General has no Save button, Shortcut still does, and no stale save replaces a newer draft.

- [x] **Step 7: Commit**

```bash
git add src/settings/GeneralPreferences.tsx src/settings/SettingsPanel.tsx src/styles/settings.css tests/SettingsPanel.test.tsx
git commit -m "polish: compact and autosave general preferences"
```

### Task 7: Full Regression And Native Product QA

**Files:**
- Modify only files required by failures found during verification.
- Update: `docs/superpowers/plans/2026-07-17-floating-assistant-input-settings.md` checkbox state as tasks complete.

- [x] **Step 1: Run all frontend tests**

Run: `npm test`

Expected: 24 or more test files pass with zero failures, including new Composer, launcher, action, and settings coverage.

- [x] **Step 2: Run production frontend build**

Run: `npm run build`

Expected: TypeScript and Vite complete successfully. Existing dynamic/static import warnings may remain; no new errors are accepted.

- [x] **Step 3: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all tests pass, including settings migration, geometry, main close policy, OCR embedding, capture storage, and sidecar lifecycle.

- [x] **Step 4: Build the native debug bundle**

Run: `npm run tauri build -- --debug`

Expected artifacts:

- `src-tauri/target/debug/bundle/macos/MiniVu.app`
- `src-tauri/target/debug/bundle/dmg/MiniVu_0.3.0_aarch64.dmg`

- [x] **Step 5: Verify the debug DMG**

Run: `hdiutil verify src-tauri/target/debug/bundle/dmg/MiniVu_0.3.0_aarch64.dmg`

Expected: checksum is VALID.

- [ ] **Step 6: Perform native interaction QA**

Using Computer Use, verify and capture screenshots for:

1. Main window in light and dark themes.
2. Closing main reveals the pet only when enabled.
3. Dragging the pet, opening the launcher, and relaunching preserve a visible anchor.
4. Screenshot cancellation returns cleanly.
5. Successful capture expands the question panel.
6. Pinyin Shift confirmation does not send; later Enter does.
7. Four screenshot actions fit without clipping.
8. General settings are compact at 1200 by 800 and the minimum supported width.

Verified in the debug bundle: light/dark main and General settings at 1200 by 800,
main close to Pet, Pet to launcher, launcher rendering, and permission recovery back to
the main window. Still pending on the final installed artifact: dual-display anchor
relaunch, a successful capture expansion, real Pinyin composition, and the minimum-width
layout check.

- [x] **Step 7: Request independent code review**

Review the commits from `54ba0b9` through the implementation head for lifecycle races, settings data loss, focus behavior, IME regressions, accessibility, and missing native tests. Resolve all Critical and Important findings.

- [x] **Step 8: Run fresh final verification after review fixes**

Run: `npm test`

Run: `npm run build`

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `git diff --check`

Expected: zero failures and no whitespace errors.

- [x] **Step 9: Commit verification fixes if any**

If `git status --short` is empty, skip this step. Otherwise inspect `git diff`, confirm every remaining path is a verification fix within this plan, then run:

```bash
git add -u
git commit -m "fix: finish floating assistant regression coverage"
```

### Task 8: Signed Release And GitHub Download

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `.github/workflows/release.yml` only if verification finds a missing signing or artifact step.

- [ ] **Step 1: Choose the next version and update all manifests together**

Use the next unreleased product version, expected `0.4.0`, in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. Do not add Codex or automation names to product metadata, commits, tags, or artifacts.

- [ ] **Step 2: Verify signing prerequisites before tagging**

Run locally:

```bash
security find-identity -v -p codesigning
```

Confirm GitHub Actions has the existing Developer ID and notarization secrets expected by `.github/workflows/release.yml`. If stable signing credentials are unavailable, do not claim the screen-recording permission flow is release-stable and do not replace it with a weak custom designated requirement.

- [ ] **Step 3: Build and verify the release app**

Run: `npm run tauri build`

Run: `codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/MiniVu.app`

Run: `hdiutil verify src-tauri/target/release/bundle/dmg/MiniVu_0.4.0_aarch64.dmg`

Expected: app signature and DMG checksum are valid.

- [ ] **Step 4: Commit version metadata**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock .github/workflows/release.yml
git commit -m "release: prepare MiniVu 0.4.0"
```

- [ ] **Step 5: Push the branch, merge through the established repository flow, and tag**

Push only reviewed MiniVu commits. Create tag `v0.4.0` from the intended release commit and push the tag.

- [ ] **Step 6: Verify GitHub Actions and release artifacts**

Use GitHub Actions to confirm the release workflow succeeds. Verify the project home page exposes the release and that the DMG link uses the MiniVu product name only.

- [ ] **Step 7: Install the GitHub DMG and repeat the permission smoke test**

Install the exact downloaded artifact, launch it, grant Screen Recording once, relaunch, and verify region capture succeeds without creating a new privacy identity on the next launch.

- [ ] **Step 8: Report the final release**

Provide the release page, direct DMG URL, exact test counts, signing/notarization status, and any residual limitations. Keep the active product goal open if stable signing or the installed-artifact smoke test remains unverified.
