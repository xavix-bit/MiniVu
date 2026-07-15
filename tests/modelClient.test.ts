import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelClient, type StreamChunk } from "../src/model/modelClient";

let streamListener: ((event: { payload: StreamChunk }) => void) | undefined;
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: StreamChunk }) => void) => {
    streamListener = callback;
    return () => {};
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

describe("modelClient", () => {
  beforeEach(() => {
    streamListener = undefined;
    invokeMock.mockReset();
  });

  it("delivers only chunks for the matching record and request", async () => {
    const chunks: StreamChunk[] = [];
    invokeMock.mockImplementation(async () => {
      streamListener?.({ payload: { recordId: "other", requestId: "request-a", text: "wrong", done: false } });
      streamListener?.({ payload: { recordId: "capture-a", requestId: "request-b", text: "wrong", done: false } });
      streamListener?.({ payload: { recordId: "capture-a", requestId: "request-a", text: "right", done: false } });
    });

    await createModelClient().askImage({
      recordId: "capture-a",
      requestId: "request-a",
      imageDataUrl: "data:image/png;base64,a",
      ocrText: "",
      prompt: "看图",
      history: [],
    }, (chunk) => chunks.push(chunk));

    expect(chunks.map((chunk) => chunk.text)).toEqual(["right"]);
    expect(invokeMock).toHaveBeenCalledWith("ask_image", expect.objectContaining({
      recordId: "capture-a",
      requestId: "request-a",
    }));
  });
});
