# Model Card Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the exact OpenBMB model and quantization on every download card, with an independent click-to-expand details section.

**Architecture:** Extend the existing frontend model metadata with the repository, filename, quantization, and bit depth. Replace each all-in-one card button with a card wrapper containing one selection button and one native `details` disclosure, preserving selection behavior while avoiding nested interactive controls.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library

---

### Task 1: Add Failing Model Card Tests

**Files:**
- Test: `tests/ModelPanel.test.tsx:81-104`

- [ ] **Step 1: Add failing card-summary and disclosure tests**

Extend the first `ModelPanel` test and add a disclosure interaction test with these assertions:

```tsx
expect(q4).toHaveTextContent("OpenBMB MiniCPM-V 4.6");
expect(q4).toHaveTextContent("Q4_K_M");
expect(q5).toHaveTextContent("Q5_K_M");
expect(q6).toHaveTextContent("Q6_K");

const q4Details = screen.getByTestId("model-details-q4_k_m");
expect(q4Details).not.toHaveAttribute("open");
expect(q4Details).toHaveTextContent("openbmb/MiniCPM-V-4.6-gguf");
expect(q4Details).toHaveTextContent("MiniCPM-V-4_6-Q4_K_M.gguf");
expect(q4Details).toHaveTextContent("4-bit");
expect(q4Details).toHaveTextContent("mmproj-model-f16.gguf");
expect(q4Details).toHaveTextContent("1.03 GiB");
```

Add a second test that clicks the Q5 disclosure summary and verifies `q4_k_m` remains selected until the Q5 selection button itself is clicked.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- --run tests/ModelPanel.test.tsx`
Expected: FAIL because model names, per-card details, and test IDs do not exist.

### Task 2: Build Independent Selection And Details Controls

**Files:**
- Modify: `src/shared/modelConstants.ts:4-31`
- Modify: `src/settings/ModelPanel.tsx:741-781`
- Modify: `src/styles/settings.css:2284-2382`
- Test: `tests/ModelPanel.test.tsx`

- [ ] **Step 1: Extend the model specification**

Add shared metadata to `GGUF_MODEL_VARIANTS`:

```ts
export const GGUF_MODEL_REPOSITORY = "openbmb/MiniCPM-V-4.6-gguf";
export const GGUF_MODEL_DISPLAY_NAME = "OpenBMB MiniCPM-V 4.6";
export const MMPROJ_FILENAME = "mmproj-model-f16.gguf";

// Per variant fields:
quantization: "Q4_K_M",
bitDepth: 4,
filename: "MiniCPM-V-4_6-Q4_K_M.gguf",
```

Use `Q5_K_M`/`5` and `Q6_K`/`6` for the other variants while keeping the current exact byte counts.

- [ ] **Step 2: Replace the nested-interaction card structure**

Render each option with this ownership boundary:

```tsx
<article className={`model-variant-option${selected ? " is-selected" : ""}`}>
  <button
    type="button"
    className="model-variant-option__select"
    aria-pressed={selected}
    aria-label={`${copy.label} ${spec.quantization}`}
    onClick={() => selectVariant(variant)}
  >
    <span className="model-variant-option__model">{GGUF_MODEL_DISPLAY_NAME}</span>
    <span className="model-variant-option__quantization">{spec.quantization}</span>
    {/* existing state, description, and size metadata */}
  </button>
  <details className="model-variant-details" data-testid={`model-details-${variant}`}>
    <summary>查看模型详情</summary>
    <dl>
      <div><dt>模型仓库</dt><dd>{GGUF_MODEL_REPOSITORY}</dd></div>
      <div><dt>模型文件</dt><dd>{spec.filename}</dd></div>
      <div><dt>量化精度</dt><dd>{spec.bitDepth}-bit · {spec.quantization}</dd></div>
      <div><dt>图片组件</dt><dd>{MMPROJ_FILENAME} · 1.03 GiB</dd></div>
    </dl>
  </details>
</article>
```

Remove the separate picker-level `技术详情` block because it duplicates the new per-card disclosure.

- [ ] **Step 3: Style stable summaries and expandable details**

Keep the three-column grid. Move button reset, grid layout, hover, focus, disabled, and selected styles to `.model-variant-option__select`. Add styles for the model-name line, monospace quantization label, disclosure border, summary focus state, wrapping `dd`, and responsive single-column behavior. The card wrapper keeps an 8px radius and may grow vertically only when its own details are open.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run tests/ModelPanel.test.tsx`
Expected: all `ModelPanel` tests pass, including details independence and exact metadata.

- [ ] **Step 5: Run frontend verification**

Run: `npm test -- --run && npm run build`
Expected: all frontend tests pass and Vite produces the production bundle.

- [ ] **Step 6: Commit the card implementation**

```bash
git add src/shared/modelConstants.ts src/settings/ModelPanel.tsx src/styles/settings.css tests/ModelPanel.test.tsx
git commit -m "feat: show exact model details on download cards"
```

### Task 3: Visual And Accessibility Verification

**Files:**
- Verify: `src/settings/ModelPanel.tsx`
- Verify: `src/styles/settings.css`

- [ ] **Step 1: Open the built download page**

Run: `npm run tauri build -- --bundles app`
Expected: `src-tauri/target/release/bundle/macos/MiniVu.app` builds successfully.

- [ ] **Step 2: Inspect desktop and narrow layouts**

Verify the three cards align before expansion, long filenames wrap, one expanded card stays within its section, and the selection outline remains visually distinct. At the minimum main-window width, cards must form a readable single column without horizontal overflow.

- [ ] **Step 3: Verify keyboard operation**

Tab to a model selection button, select it with Space, then Tab to `查看模型详情` and expand with Enter. Expected: expanding details does not change `aria-pressed` on any model button.

- [ ] **Step 4: Final repository check**

Run: `git diff --check && git status --short --branch`
Expected: no whitespace errors and no uncommitted product-code changes.
