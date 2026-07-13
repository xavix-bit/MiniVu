# Quick Panel And Product Language Polish

## Goal

Make MiniVu read like a finished utility instead of a model control panel. Users should see what they can do, what is happening, and how to recover. Internal implementation names stay out of the default interface.

## Quick Panel

- Treat screenshot, text copy, translation, and image questions as actions, not tabs. No action remains selected after it finishes.
- In the empty state, make Screenshot the primary action. Paste and Choose Image remain secondary inputs. Disable the question field until an image is present.
- While an answer is being generated, block image replacement, paste, drag and drop, and conversation clearing. The current request must finish or be stopped first.
- Always show text-recognition state after an image is selected: recognizing, text found, no text found, or failed.
- Recognition failure uses one short message and offers Retry. Users may still ask about the image without recognized text.
- Keep the user's question when an answer fails. Show a retryable answer error instead of deleting the question.
- Show one Stop action during generation. Avoid nested scrolling and avoid smooth-scrolling every streamed chunk.

## Product Language

- Default surfaces use: Local processing, Image understanding, Download, Ready, Needs setup, Text recognition, Answering.
- Remove from default surfaces: Metal, GGUF, MLX, llama, sidecar, runtime, inference backend, weights, vision projector, ports, task IDs, file paths, raw stderr, and HTTP details.
- Advanced settings may expose compatibility mode names and model IDs behind a collapsed Advanced section. The default option remains described as Recommended.
- User-facing errors map to a small set of actions: Retry, Open Settings, Restart MiniVu, or Free Space. Raw technical errors are never interpolated into JSX.

## Setup And Model Pages

- First-use stages become Device check, App components, Image understanding, and Shortcut.
- Model cards keep user-relevant precision and disk sizes. Internal file names and formats stay in documentation, not the default card UI.
- Storage is labeled Used space. Shared files are described as Shared image component only when the distinction affects download size.

## OCR Packaging

- Compile the Vision-based Swift OCR implementation into a native helper during the macOS build.
- Bundle and execute the helper from the application resource directory. Production must not depend on a source path or an installed Swift toolchain.
- Delete temporary images on every success and failure path.

## Verification

- Rust tests cover OCR helper resolution, command arguments, and temporary-file cleanup.
- Frontend tests cover locked destructive actions during generation, recognition retry and empty results, preserved questions after answer failure, hidden raw errors, and natural copy on main/setup/model surfaces.
- A release build must contain an executable OCR helper and must not contain the GitHub runner source path.
- Run full frontend tests, Rust tests, production build, Tauri app bundle, and visual inspection of the quick panel at its minimum size.
