# Quick Panel Action Simplification

## Goal

Remove duplicated controls from the quick panel so each stage presents only the actions that are currently useful.

## Flow

- Before an image is available, show drag and drop, Screenshot, and Paste only.
- Remove the persistent Screenshot, Text, Translate, and Ask row. These are commands rather than modes, and each duplicates another control.
- After an image is available, show Copy Text and Translate beside the image preview.
- Asking about an image happens through the composer, which already provides the natural entry point.
- Keep Screenshot, Replace Image, and Clear beside the preview where they affect the current image or conversation.

## Verification

- The empty state does not render the old mode row.
- The image-ready state renders Copy Text and Translate, but no Ask shortcut.
- Existing screenshot, paste, replace, clear, translation, copy, and composer behaviors remain unchanged.
