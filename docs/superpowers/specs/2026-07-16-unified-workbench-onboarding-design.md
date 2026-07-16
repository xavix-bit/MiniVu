# Unified Workbench And First Capture Onboarding

## Goal

MiniVu should feel like one continuous product. The screenshot workbench remains the application frame while users move between captures and settings. First-time use should lead to a real screenshot before asking the user to install an AI model.

The change covers three connected problems:

- Preview controls currently expose duplicate actions.
- Opening Settings replaces the entire visual structure.
- First launch blocks the product behind technical setup instead of demonstrating its primary value.

## Product Principles

- Screenshot capture is useful without an AI model.
- Preserve context when moving between work and configuration.
- Explain actions at the point where they become relevant.
- Keep one primary action per state.
- Prefer compact product UI over decorative cards and explanatory copy.
- Motion communicates continuity and never delays input.

## Preview Controls

The screenshot canvas toolbar contains five stable controls:

1. Zoom out.
2. A read-only percentage display.
3. Zoom in.
4. Fit the image inside the available stage and center it.
5. Show the image at one image pixel per CSS pixel and center it.

`Fit` computes the scale from the image's natural dimensions and the stage's rendered dimensions, respecting a small visual inset. `1:1` sets zoom to `1` and clears pan. The percentage is no longer clickable. The ambiguous reset command is removed.

Changing the selected capture defaults to fit-to-window after the image has loaded. Manual zoom and pan remain scoped to the current selection while the user stays in the workbench.

## Unified Application Frame

The existing 64-pixel workbench rail becomes the permanent top-level navigation after first launch. Its logo, recent, pinned, and settings commands remain mounted while the visible content changes.

### Workbench Mode

- The middle column shows search and capture history.
- The detail area shows the selected screenshot canvas and inspector.
- Returning from Settings restores the previous capture selection, filter, search, scroll position, zoom, and pan.

### Settings Mode

- The rail remains visible and marks Settings active.
- The middle column shows `通用`, `模型`, `快捷键`, and `隐私`.
- The detail area shows the selected settings section.
- Clicking Recent or Pinned returns directly to that workbench scope.

The old Settings brand sidebar, product top bar, dashboard-style status cards, decorative page headers, and duplicate navigation are removed. Existing settings forms and model operations are retained, but they render inside the shared workbench columns and use the workbench tokens.

Settings content uses compact sections, standard rows, restrained borders, and a single primary action. Technical readiness labels are replaced with task language where the user needs a decision; internal backend terminology is not displayed.

## Navigation Motion

The application keeps workbench and settings state mounted. Switching modes changes the middle and detail content with an interruptible 180–220 ms transition:

- outgoing content fades and moves four to eight pixels;
- incoming content fades into the same spatial frame;
- the rail does not move;
- focus moves to the new main region after the transition begins;
- repeated navigation immediately supersedes an in-progress animation.

Only `transform` and `opacity` animate. With `prefers-reduced-motion: reduce`, transitions become a short crossfade or complete immediately.

## First-Run Flow

First launch no longer opens the model setup page.

### Welcome

The welcome state appears inside the application frame and contains:

- one concise statement of the primary task;
- a primary `开始截图` command;
- the configured keyboard shortcut;
- a quiet `稍后进入` command.

A short, one-time crop-corner motion reinforces the screenshot action. It is implemented in React and CSS, not as a video.

### Real Capture

`开始截图` invokes the existing region capture flow.

- Successful capture creates and selects a normal capture record.
- The welcome layer exits and reveals the real workbench.
- OCR starts through the existing background processing path.
- Two short contextual tips point to recognized text and the question composer.
- Tips may be dismissed and do not reappear after completion.

Cancelling capture returns silently to the welcome state. Choosing `稍后进入` marks the welcome as seen and opens the empty workbench.

### Permission Failure

When macOS denies screen recording, the welcome state remains visible and replaces its action area with a concise permission message plus:

- `打开系统设置`
- `重试`

The interface does not show raw platform errors or a long troubleshooting paragraph.

## Model Installation At Point Of Use

OCR, screenshot history, pinning, export, and text copying remain available without a VLM.

When the user first attempts an AI question without an installed model, the inspector preserves the draft and presents an inline installation state containing:

- the concrete model name;
- download size;
- approximate memory requirement;
- the existing model choices;
- one install action.

Selecting a model opens the Model section inside the unified Settings frame. The originating capture ID and draft are retained. After successful installation, MiniVu returns to that capture and restores the unsent question. No model downloads automatically after the first screenshot.

Download failure keeps completed progress where supported and offers retry. Other screenshot features remain interactive during downloads.

## State And Components

### Shell State

`MainWindowShell` owns a small top-level mode:

- `workbench`
- `settings`
- `welcome`

It also owns the selected settings section and an optional return context containing capture ID and draft. Workbench data remains owned by `useCaptureLibrary`; settings persistence remains owned by `settingsStore`.

### New UI Boundaries

- `FirstRunWelcome`: welcome, capture request, cancellation, and permission recovery presentation.
- `SettingsNavigationPane`: settings categories rendered in the shared middle column.
- `UnifiedSettingsView`: existing setup, model, preferences, and privacy content rendered in the shared detail region.
- `CanvasViewport`: fit and 1:1 calculations separated from toolbar presentation for focused testing.

The existing environment setup panel remains available under Settings for manual configuration, but it is no longer the first-run gate.

## Persistence

Persistent settings distinguish:

- whether the first-run welcome has been completed or skipped;
- whether contextual workbench tips have been dismissed;
- whether a model is installed, using existing model status APIs.

Migration treats an existing `onboardingComplete` installation as having completed the new welcome. New installations begin at the welcome state. No capture or model data is deleted.

## Accessibility

- Every icon control has an accessible name and tooltip.
- Toolbar controls remain at least 40 by 40 pixels with an effective 44-pixel target where space allows.
- Settings navigation uses `aria-current` and keyboard focus follows visual order.
- Context tips never trap focus and include a visible dismiss command.
- Welcome and settings transitions respect reduced motion.
- Status and errors use text and icons, not color alone.

## Verification

Frontend tests cover:

- fit scale calculation for landscape, portrait, and smaller-than-stage images;
- distinct fit and 1:1 behavior;
- percentage display is not interactive;
- navigation preserves workbench selection and returns to the requested scope;
- Settings uses the permanent rail and shared columns;
- successful first capture completes onboarding and selects the new record;
- cancelled capture remains on welcome without an error;
- skip opens an empty workbench;
- permission failure exposes settings and retry actions;
- first AI use without a model preserves the draft and routes to model installation;
- installation completion restores the originating capture and draft;
- reduced-motion behavior disables spatial animation.

Run the complete Vitest suite, production frontend build, and Tauri debug build. Visually inspect the packaged application at desktop and narrow supported window widths in welcome, empty workbench, selected capture, settings, permission failure, and model-required states.

## Out Of Scope

- A Remotion runtime or bundled onboarding video.
- Annotation tools.
- Automatic model download.
- A separate Settings window.
- A full feature tour or recurring tutorial.
- Changes to model inference or capture storage formats.
