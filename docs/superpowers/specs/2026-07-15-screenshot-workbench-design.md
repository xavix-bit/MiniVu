# Screenshot-First Workbench

## Product Position

MiniVu is a screenshot tool first and a local AI assistant second. Capturing must feel instant and dependable; OCR and AI enhance a screenshot after it exists rather than becoming prerequisites for capture.

The product follows the same object-workbench principle used by ProxyPin: capture creates durable objects, the main window lists those objects, and tools operate on the selected object. MiniVu applies that pattern to screenshots rather than network requests.

## Primary Flow

1. The global shortcut starts region capture immediately.
2. Cancelling capture exits silently and does not open a panel or create history.
3. A successful capture creates a local screenshot record, selects it, and opens the lightweight result panel near the pointer without covering the captured area when possible.
4. The image appears immediately. OCR starts automatically. VLM warmup starts in the background and never blocks the image or OCR.
5. The user can copy recognized text, pin or export the screenshot, enter a question, or choose the single default AI action `帮我看懂`.
6. The full workbench opens only when the user chooses `最近` or `在工作台打开`.

## Floating Launcher

- Keep the draggable 56-pixel floating launcher.
- Clicking it expands a horizontal toolbar toward the available side of the screen.
- The toolbar contains exactly three icon-and-label commands: `截图`, `粘贴`, and `最近`.
- Clicking outside or pressing Escape collapses the toolbar.
- The launcher is an entry surface, not a duplicate result panel.

## Capture Records

Each capture is an independent `CaptureRecord`:

- `id`
- original image and generated thumbnail
- source: capture, paste, drag, or file
- optional user title
- OCR text and OCR state
- independent user/assistant message history
- created and updated timestamps
- expiration timestamp
- pinned state

Every new capture creates a new record and becomes the current selection. Replacing an image inside an existing record is a separate explicit command.

OCR and AI operations carry both the capture record ID and a unique request ID. Main-window and quick-panel listeners ignore events that do not match their active request, so concurrent Webviews cannot mix OCR results, streamed tokens, cancellation, or progress state.

Records are local only. The default retention is 24 hours. Settings may choose no automatic history, 24 hours, 7 days, or permanent retention. Pinned records never expire. Deleting a record removes its image, thumbnail, OCR, and conversation together.

## Local Storage

Store records under the application data directory:

```text
captures/
  <capture-id>/
    image.png
    thumbnail.jpg
    metadata.json
```

Use one metadata file per record so a damaged write cannot corrupt the whole library. Write metadata through a temporary file and rename it atomically. Cleanup runs on startup and after new captures. Search matches normalized user titles and OCR text in memory after reading lightweight metadata; full images load only for the selected record.

Rust emits record-changed events after committed writes. Events contain IDs and lightweight summaries rather than full base64 images; either Webview can recover from a missed event by reloading the persisted record.

## Main Workbench

After onboarding, the main window opens as a quiet three-column screenshot workspace:

- 64-pixel navigation rail: `最近`, `固定`, and a bottom `设置` command.
- 260-pixel searchable list: thumbnail, title or OCR preview, and capture time.
- Flexible detail area: screenshot canvas first, with a 320-pixel inspector for OCR and AI.

The canvas supports fit-to-window, zoom, and pan. The inspector uses `AI` and `文字` tabs. AI is the default tab; the OCR tab exposes recognized text and copy. At narrow widths the detail replaces the list and provides a back command.

The former dashboard and readiness cards do not remain the product home. Setup, model downloads, privacy, and preferences live behind Settings. First-time setup still blocks workbench use until required components are ready.

## AI Interaction

- Do not auto-analyze every screenshot.
- OCR runs automatically.
- AI has one composer labeled `问这张截图…` and one empty-state action `帮我看懂`.
- Do not restore separate Translate, Ask, Summary, or mode rows. Users express those intents in the composer.
- Each screenshot owns an isolated conversation. Switching screenshots restores that screenshot's messages and never carries context across records.
- Multi-image comparison and automatic AI tagging are out of scope for the first release.

## Warmup And Memory

- Application startup does not load the VLM solely to show UI.
- After a screenshot record is created, warmup begins in the background when enabled.
- The image renders first, OCR starts next, and warmup is scheduled after OCR has been dispatched. None of these waits for the model to become ready.
- The first AI request reuses a warming or ready sidecar.
- The model unloads after 10 minutes without AI activity. Active warmup or inference work is never interrupted, and the idle timer restarts when that work finishes.
- Low-memory devices may disable background warmup, but explicit AI requests still load the model normally.
- Starting or warming the model is single-flight: repeated captures and a first AI request share the same startup rather than launching competing readiness checks.

## Out Of Scope

- Full annotation editor
- Cloud inference fallback
- Cross-screenshot AI memory
- Multi-image comparison
- Automatic AI tags or titles
- Default exports to Desktop or Photos

## Verification

- Shortcut tests prove Pressed triggers capture rather than panel-only presentation.
- Capture cancellation creates no record and leaves the result panel hidden.
- Storage tests cover create, atomic update, load, search, pin, delete, expiration, and pinned retention.
- Frontend tests cover launcher toolbar actions, record selection, isolated conversations, search, empty workbench, AI/OCR inspector switching, and narrow layout.
- Warmup tests prove capture and OCR do not await model loading and idle unload uses 10 minutes.
- Concurrency tests prove an active inference cannot be unloaded and an old OCR result cannot overwrite a newer capture.
- A packaged macOS app is visually checked in launcher, empty result, OCR-ready, AI-answering, recent-list, pinned-list, and settings states.
