# Model Card Details Design

## Goal

Let users identify the exact OpenBMB model before downloading it without turning the model picker into a technical control panel.

## Card Summary

Each model card keeps its user-facing quality tier as the primary title:

- Standard
- High precision
- Highest precision

Directly below the title, every card always shows:

- Publisher and model: `OpenBMB MiniCPM-V 4.6`
- Quantization variant: `Q4_K_M`, `Q5_K_M`, or `Q6_K`
- Exact model download size
- Exact first-install storage, including the shared image-understanding component

The existing state badge, recommendation badge, description, and selection behavior remain.

## Expandable Details

Each card contains a collapsed `查看模型详情` disclosure. Opening it shows:

- Repository: `OpenBMB/MiniCPM-V-4.6-GGUF`
- Complete model filename for the selected variant
- Quantization bit depth
- Shared image-understanding component filename: `mmproj-model-f16.gguf`
- Shared component size: `1.03 GiB`

The disclosure is independent from card selection. Clicking or operating the disclosure must not select a different model. It uses native `details` and `summary` semantics so mouse and keyboard users receive the same behavior.

## Layout

- Details are collapsed by default.
- All three cards have a stable summary layout and aligned metadata before expansion.
- Opening one card expands only that card and does not move controls outside the model-picker section.
- Long repository names and filenames wrap without overflowing.
- The existing separate technical-details block is removed once its useful information lives inside each card.

## Data Ownership

The model constants own user-visible model metadata so filenames, quantization labels, and sizes do not drift between JSX and the Rust download definitions. The frontend model specification adds repository, filename, quantization label, and bit depth fields for each variant.

## Testing

Frontend tests verify:

- All three cards display `OpenBMB MiniCPM-V 4.6` and their exact quantization variants.
- Each disclosure is closed by default.
- Opening details reveals the correct repository, filename, bit depth, shared component name, and shared size.
- Operating the disclosure does not change the selected model.
- Existing download-size, first-install-size, and model-selection tests remain passing.
