# Quick Panel Empty State Polish

## Goal

Make the quick panel's first screen immediately understandable and readable. The empty state should communicate adding an image without relying on an abstract scan symbol, and the secondary action must remain legible in every theme.

## Visual Hierarchy

- Keep `截图` as the blue primary action.
- Render `粘贴图片` and `选择图片` as light secondary actions with a white surface, blue-gray text, and a visible neutral border.
- Preserve a clear disabled state with a light gray surface and readable gray text instead of reducing the whole control to low opacity.
- Keep the empty-state surface white with a subtle dashed border and reduce excess vertical spacing.

## Empty-State Icon

- Replace the four-corner CSS scan mark, which resembles a hash at compact size, with a familiar image-plus icon.
- Use a pale blue icon surface, blue line work, and no dark fill.
- Keep the icon decorative with `aria-hidden`; the adjacent `拖入图片` text carries the accessible meaning.

## Interaction

- Secondary actions use a pale blue hover state and a blue focus-visible ring.
- All action buttons keep a minimum 44-pixel target.
- The layout remains two columns in the compact panel, with the primary screenshot action spanning the full row and secondary image inputs sharing the row below.

## Verification

- Add a component assertion for the image-plus icon and action labels.
- Verify light and dark app preferences cannot turn the secondary buttons into dark-on-dark controls.
- Inspect the empty state at the panel's minimum size and confirm the icon does not resemble a hash, text remains readable, and actions do not overlap.
