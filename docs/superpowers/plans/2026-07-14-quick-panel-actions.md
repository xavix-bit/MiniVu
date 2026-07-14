# Quick Panel Action Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicated mode row and keep only contextual actions before and after image selection.

**Architecture:** Keep all existing image and conversation behavior in `ChatPanel`. Delete only the duplicate command surface, reduce `QuickActions` to Copy Text and Translate, and remove the now-unused focus trigger and CSS selectors.

**Tech Stack:** React, TypeScript, Lucide React, CSS, Vitest, Testing Library

---

### Task 1: Simplify Quick Panel Commands

**Files:**
- Modify: `src/chat/ChatPanel.tsx`
- Modify: `src/chat/QuickActions.tsx`
- Modify: `src/styles/quick-panel.css`
- Test: `tests/ChatPanel.test.tsx`

- [ ] Add failing assertions that the mode row is absent and the image-ready state exposes Copy Text and Translate without Ask.
- [ ] Run `npm test -- --run tests/ChatPanel.test.tsx` and confirm failure against the current UI.
- [ ] Remove the mode row, Ask shortcut, unused focus state, and dead mode-row CSS.
- [ ] Use Lucide `Copy` and `Languages` icons for the two remaining contextual commands.
- [ ] Run the focused test, full test suite, frontend build, Tauri app build, and compact-window visual inspection.
- [ ] Commit and push `codex/current-ui`.
