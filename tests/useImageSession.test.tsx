import { describe, expect, it } from "vitest";
import {
  createImageSessionState,
  shouldConfirmImageReplacement,
} from "../src/chat/useImageSession";

describe("image session state", () => {
  it("starts empty", () => {
    const state = createImageSessionState();

    expect(state.image).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.ocrText).toBe("");
  });

  it("requires confirmation when replacing an image after chat has started", () => {
    const state = createImageSessionState();
    state.image = { name: "first.png", dataUrl: "data:image/png;base64,abc" };
    state.messages.push({ role: "user", content: "What is this?" });

    expect(shouldConfirmImageReplacement(state)).toBe(true);
  });

  it("does not require confirmation before chat starts", () => {
    const state = createImageSessionState();
    state.image = { name: "first.png", dataUrl: "data:image/png;base64,abc" };

    expect(shouldConfirmImageReplacement(state)).toBe(false);
  });
});
