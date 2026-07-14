# Quick Panel Empty State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous empty-state mark with a familiar image-plus icon and guarantee readable primary, secondary, hover, focus, and disabled button states.

**Architecture:** Keep the behavior in the existing `ChatPanel` and make this a presentation-only change. Use Lucide's `ImagePlus` component for the decorative empty-state symbol, then lock the compact-window colors behind the existing high-specificity quick-panel selectors so theme attributes cannot reintroduce dark-on-dark controls.

**Tech Stack:** React 19, TypeScript, lucide-react, CSS, Vitest, Testing Library

---

### Task 1: Polish The Empty State

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/chat/ChatPanel.tsx`
- Modify: `src/styles/quick-panel.css`
- Test: `tests/ChatPanel.test.tsx`

- [ ] **Step 1: Write the failing component assertion**

Extend the existing empty-state test so it requires a real SVG image icon and keeps the action hierarchy explicit:

```tsx
const emptyImageIcon = screen.getByTestId("empty-image-icon");
expect(emptyImageIcon).toHaveAttribute("aria-hidden", "true");
expect(emptyImageIcon.querySelector("svg")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "截图" })).toHaveClass("drop-zone__capture");
expect(screen.getByRole("button", { name: "粘贴图片" })).toHaveClass("drop-zone__secondary");
```

- [ ] **Step 2: Verify the assertion fails**

Run: `npm test -- --run tests/ChatPanel.test.tsx`

Expected: the empty-state test fails because `empty-image-icon` and its SVG do not exist yet.

- [ ] **Step 3: Add the Lucide icon**

Install `lucide-react`, import `ImagePlus`, and replace the CSS-generated corners in `ChatPanel.tsx`:

```tsx
import { ImagePlus } from "lucide-react";

<span className="drop-zone__icon" data-testid="empty-image-icon" aria-hidden="true">
  <ImagePlus />
</span>
```

- [ ] **Step 4: Define readable visual states**

Remove the four pseudo-element corner rules. Style the icon as a pale blue tile with blue line work, and keep secondary controls readable under every theme:

```css
.drop-zone__icon {
  background: #eef4ff;
  color: #2563eb;
}

.drop-zone__icon svg {
  width: 26px;
  height: 26px;
  stroke-width: 1.8;
}

html.quick-panel-window .image2-start-actions .drop-zone__secondary {
  border-color: #d8e2ee !important;
  background: #ffffff !important;
  color: #42526a !important;
}

html.quick-panel-window .image2-start-actions .drop-zone__secondary:disabled {
  border-color: #e3e9f1 !important;
  background: #f4f6f9 !important;
  color: #8a95a5 !important;
}
```

Add a blue `:focus-visible` ring and retain the existing pale blue hover treatment. Keep the primary screenshot control blue and all targets at least 44 pixels tall.

- [ ] **Step 5: Run focused checks**

Run: `npm test -- --run tests/ChatPanel.test.tsx && npm run build`

Expected: the ChatPanel suite passes and the production frontend build succeeds.

- [ ] **Step 6: Visually verify and commit**

Open the quick panel at its minimum size and inspect the empty state in both theme preferences. Expected: the center reads as an image-add action, secondary buttons are light and legible, keyboard focus is visible, and no text or controls overlap.

```bash
git add package.json package-lock.json src/chat/ChatPanel.tsx src/styles/quick-panel.css tests/ChatPanel.test.tsx
git commit -m "fix: polish quick panel empty state"
```
