# Floating Assistant, IME Safety, And Compact Settings

## Goal

Make MiniVu feel like a screenshot utility that is always one click away, while keeping the main window quiet and familiar. Fix accidental sends during Chinese input, expose the existing floating-window flow as a real product feature, simplify General settings, and add a small set of useful post-capture actions.

The approved direction is a compact floating assistant rather than a permanently expanded toolbar or a menu-bar-only workflow.

## Product Principles

- The floating assistant is an entry point, not a second application shell.
- The main window and floating assistant never compete for attention at the same time.
- Screenshot remains the primary action; AI-assisted actions appear only after an image exists.
- Chinese input must never send while the IME is composing or confirming text.
- Settings should describe user choices, save automatically, and avoid duplicated headings or oversized cards.
- Add a few high-frequency actions instead of restoring duplicated task modes.

## Floating Assistant Flow

MiniVu reuses the existing quick-panel window and its four modes: hidden, pet, launcher, and expanded.

### Main Window Handoff

- MiniVu launches into the main window as it does today.
- Closing the main window hides it instead of destroying it.
- If `floatingAssistantEnabled` is on and onboarding is complete, closing the main window reveals a 56 by 56 floating button.
- If the setting is off, MiniVu stays available from the menu bar and global shortcut without showing a floating button.
- Opening the main window from the launcher, menu bar, Dock, or Settings hides the floating assistant. Closing the main window reveals it again when enabled.
- Quitting from the application or menu-bar Quit command still exits normally.

This avoids showing two MiniVu surfaces at once and gives the close button a useful background-utility meaning.

### Pet Mode

- The pet is a 56 by 56 borderless, always-on-top button using the MiniVu mark.
- It can be dragged from any point on the button.
- A drag never triggers the click action.
- The last valid screen position is remembered and clamped to the visible display area on the next launch.
- The first position is near the right edge, vertically centered, with enough inset to remain easy to grab.
- Clicking the pet expands the launcher without moving its anchor off screen.

### Launcher Mode

The launcher is a compact horizontal strip anchored to the pet position. It contains three commands:

1. `截图` starts region capture.
2. `粘贴` opens the current clipboard image.
3. `最近` opens the main window at recent captures.

`Escape` or clicking away collapses the launcher back to the pet. Screenshot cancellation also returns to the pet without an error. Capture failures route to the existing actionable recovery message in the main window.

### Expanded Mode

- A successful screenshot or paste creates a normal capture record and expands the same window into the existing question panel.
- The panel remains movable, resizable, and always on top.
- Closing the panel collapses it to the pet when the floating assistant is enabled; otherwise it hides.
- Opening Settings or Recent hides the quick panel and transfers focus to the main window.
- Existing OCR, conversation, export, replacement, and capture-history behavior is preserved.

## Persistence And Window State

`AppSettings` gains:

- `floatingAssistantEnabled: boolean`
- `floatingAssistantPosition: { x: number; y: number } | null`

The assistant is enabled by default. It first appears only after an onboarded user closes the main window, so upgrades do not place an unexpected control over the active application.

The Rust window layer remains the owner of physical window size, visibility, and position. It records quick-panel moves in `QuickPanelState`, converts positions to logical coordinates, and persists the latest pet/launcher anchor through the serialized settings update path. Invalid or off-screen saved positions fall back to the default right-edge position.

## Chinese IME Safety

The composer keeps Enter-to-send and Shift-Enter-to-newline, but sending requires an unambiguous physical Enter press.

- While `compositionstart` through `compositionend` is active, Enter never sends.
- Native composing state and key code `229` remain fallback checks for WebKit IME events.
- For 250 ms after `compositionend`, an Enter event is treated as an IME confirmation leak and is consumed without sending.
- Pressing Shift while composing may confirm text but cannot submit the form.
- Shift-Enter always inserts a newline.
- Clicking Send remains available after composition has settled.

Focused tests reproduce a Pinyin sequence: start composition, update text, press Shift, end composition, receive a delayed Enter, and verify that no message is sent. A later explicit Enter sends once.

## General Settings Redesign

General settings becomes an unframed, compact preference surface with two groups.

### Appearance

`外观` uses a three-option segmented control:

- `自动`
- `浅色`
- `深色`

The selected appearance still updates immediately for preview.

### Usage

`使用` contains compact rows:

- `自动保留`: a right-aligned menu for no history, 24 hours, 7 days, or permanent history. Its helper text sits under the label rather than under the control.
- `悬浮按钮`: a switch controlling the floating assistant. Turning it off hides the pet or launcher immediately; turning it on makes the pet available when the main window is closed.
- `提前准备问图`: a switch retaining the existing background preparation behavior, described as making the first question faster.

The duplicated inner `通用` title, oversized outer card treatment, and permanent Save button are removed. Each change is saved through the existing serialized patch API. While saving, the changed control is disabled and a quiet `正在保存…` state appears. Failure keeps the draft visible and offers `重试`; stale saves cannot overwrite newer edits.

Model installation and shortcut recording retain explicit actions because they are longer or multi-step operations.

## Post-Capture Actions

Before a conversation starts, the image panel shows four actions in a stable two-by-two grid:

- `复制文字`: copies OCR text and is disabled until text is ready.
- `翻译`: translates all visible text while preserving order.
- `总结`: gives a concise summary of the screenshot's main content.
- `解释`: explains the screenshot and prioritizes any visible error, warning, or next step.

These are one-shot commands that feed the existing conversation. They do not become persistent tabs or task modes. Once a conversation starts, the free-form composer remains the primary control and the action grid disappears.

## Error Handling

- Screenshot cancellation is silent.
- Permission denial opens the main workbench with `打开系统设置` and concise recovery copy.
- Empty clipboard keeps the launcher visible and shows a short inline message rather than doing nothing.
- A missing model preserves the selected action or question and routes to the existing model installation flow.
- Settings save failures never expose paths, backend names, or raw IPC errors.

## Accessibility And Motion

- Pet, launcher commands, close, and segmented options have accessible names and visible focus states.
- The pet target remains at least 44 by 44 pixels.
- Launcher expansion uses only opacity and transform over 140-180 ms and respects reduced motion.
- Settings switches expose their checked state and do not rely on color alone.
- Tooltips name icon-only close and collapse commands.

## Verification

Frontend tests cover:

- Pinyin composition and delayed Enter leakage;
- deliberate Enter and Shift-Enter behavior;
- launcher Screenshot, Paste, Recent, Escape, and empty-clipboard states;
- four post-capture actions and their disabled states;
- automatic General-settings saves, failures, retry, and stale-save protection;
- floating-assistant setting defaults and migration.

Rust tests cover:

- close-to-pet behavior with onboarding and the setting on or off;
- saved-position clamping and default placement;
- legacy settings migration;
- mode restoration after capture and main-window transitions.

Native QA covers:

- first launch and returning-user launch;
- closing and reopening the main window;
- dragging the pet and relaunching;
- pet to launcher to screenshot to expanded-panel flow;
- cancellation and permission failure;
- Pinyin input in the expanded composer;
- General settings in light and dark themes at normal and narrow window widths.

Run the complete frontend suite, production frontend build, Rust tests, Tauri debug bundle, DMG verification, and strict release-app signature verification before publishing.

## Out Of Scope

- Annotation drawing tools.
- A permanently expanded floating toolbar.
- Cloud inference or cloud storage.
- More task tabs or model/backend terminology in the quick panel.
- A separate settings window.
