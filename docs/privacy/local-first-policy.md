# Local-First Privacy Policy

## Hard Rules

- Screenshots, imported images, OCR text, prompts, answers, filenames, and conversations are processed locally.
- MiniVu does not upload user content and has no cloud inference fallback.
- Network access occurs only after an explicit model download/update, optional acceleration setup, or mirror speed test.
- Manual exports are written only to the path selected by the user.

## Screenshot Records

- Region capture uses the local macOS screenshot tool.
- The MiniVu quick window is concealed during region selection so it is not included in the image.
- Successful captures are stored under MiniVu's application data directory as an original image, thumbnail, and metadata.
- The default retention is 24 hours. Users can choose no history, 24 hours, 7 days, or permanent history.
- Pinned records do not expire. Deleting a record removes its image, thumbnail, OCR text, and conversation together.
- Temporary files used by macOS region capture are deleted after the record is created.

## Local Processing

- OCR uses macOS Vision locally.
- Image questions are answered by a local model.
- Optional background preparation starts only after an image exists and can be disabled in Settings.
- The local question-answering process is released after 10 minutes of inactivity and is never released during active work.

## Diagnostics

Allowed local-only diagnostics include app/model version, load state and duration, OCR success/failure, non-content error codes, and model download progress.

Diagnostics must not include image bytes, OCR text, prompts, answers, filenames, clipboard contents, exported contents, or screenshot contents.
