import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useImageSession } from "../src/chat/useImageSession";
import { modelClient } from "../src/model/modelClient";

const { eventHandlers } = vi.hoisted(() => ({
  eventHandlers: new Map<string, () => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: () => void) => {
    eventHandlers.set(name, callback);
    return () => eventHandlers.delete(name);
  }),
}));
vi.mock("../src/model/modelClient", () => ({
  modelClient: {
    askImage: vi.fn(),
    cancelGeneration: vi.fn(),
    warmupModel: vi.fn(),
    getModelStatus: vi.fn().mockResolvedValue({ inferenceBackend: "llama" }),
    onSidecarLoadProgress: vi.fn().mockResolvedValue(() => {}),
  },
}));

describe("useImageSession runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    vi.mocked(modelClient.cancelGeneration).mockResolvedValue(undefined);
    vi.mocked(modelClient.getModelStatus).mockResolvedValue({
      inferenceBackend: "llama",
    } as Awaited<ReturnType<typeof modelClient.getModelStatus>>);
    vi.mocked(modelClient.onSidecarLoadProgress).mockResolvedValue(() => {});
  });

  it("cancels only the current request and clears it after completion", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(modelClient.askImage).mockImplementation(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    const { result } = renderHook(() => useImageSession({ recordId: "record-a" }));

    act(() => {
      result.current.loadSession({
        image: { name: "a.png", dataUrl: "data:image/png;base64,AAA" },
        ocrText: "OCR A",
        messages: [],
      });
    });
    await act(async () => {
      void result.current.ask("what is this?");
    });
    await waitFor(() => expect(modelClient.askImage).toHaveBeenCalledOnce());

    const request = vi.mocked(modelClient.askImage).mock.calls[0][0];
    expect(request.recordId).toBe("record-a");
    expect(request.requestId).toEqual(expect.any(String));
    await act(async () => {
      await result.current.stopGeneration();
    });
    expect(modelClient.cancelGeneration).toHaveBeenCalledWith(request.requestId);

    await act(async () => {
      finish?.();
    });
    await waitFor(() => expect(result.current.isAnswering).toBe(false));
    await act(async () => {
      await result.current.stopGeneration();
    });
    expect(modelClient.cancelGeneration).toHaveBeenCalledTimes(1);
  });

  it("ignores an old request after loading another record session", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(modelClient.askImage).mockImplementation(
      (_request, onChunk) => new Promise<void>((resolve) => {
        finish = () => {
          onChunk({
            recordId: "record-a",
            requestId: "stale",
            text: "stale answer",
            done: true,
          });
          resolve();
        };
      }),
    );
    const { result, rerender } = renderHook(
      ({ recordId }) => useImageSession({ recordId }),
      { initialProps: { recordId: "record-a" } },
    );

    act(() => {
      result.current.loadSession({
        image: { name: "a.png", dataUrl: "data:image/png;base64,AAA" },
        ocrText: "OCR A",
        messages: [],
      });
    });
    await act(async () => {
      void result.current.ask("question A");
    });
    await waitFor(() => expect(modelClient.askImage).toHaveBeenCalledOnce());
    const requestId = vi.mocked(modelClient.askImage).mock.calls[0][0].requestId!;

    rerender({ recordId: "record-b" });
    act(() => {
      result.current.loadSession({
        image: { name: "b.png", dataUrl: "data:image/png;base64,BBB" },
        ocrText: "OCR B",
        messages: [{ role: "user", content: "message B" }],
      });
    });
    await waitFor(() => expect(modelClient.cancelGeneration).toHaveBeenCalledWith(requestId));

    await act(async () => {
      finish?.();
    });
    expect(result.current.state.image?.name).toBe("b.png");
    expect(result.current.state.messages).toEqual([{ role: "user", content: "message B" }]);
  });

  it("reserves the answer slot before model status refresh completes", async () => {
    const { result } = renderHook(() => useImageSession({ recordId: "record-a" }));
    await waitFor(() => expect(modelClient.getModelStatus).toHaveBeenCalled());
    vi.mocked(modelClient.getModelStatus).mockClear();

    let releaseStatus: (() => void) | undefined;
    vi.mocked(modelClient.getModelStatus).mockImplementation(
      () => new Promise((resolve) => {
        releaseStatus = () => resolve({ inferenceBackend: "llama" } as never);
      }),
    );
    vi.mocked(modelClient.askImage).mockResolvedValue(undefined);
    act(() => {
      result.current.loadSession({
        image: { name: "a.png", dataUrl: "data:image/png;base64,AAA" },
        ocrText: "OCR A",
        messages: [],
      });
    });
    act(() => {
      void result.current.ask("first");
      void result.current.ask("second");
    });

    expect(modelClient.getModelStatus).toHaveBeenCalledOnce();
    await act(async () => {
      releaseStatus?.();
    });
    await waitFor(() => expect(modelClient.askImage).toHaveBeenCalledOnce());
    expect(vi.mocked(modelClient.askImage).mock.calls[0][0].prompt).toBe("first");
  });

  it("cancels and invalidates the active answer before clearing messages", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(modelClient.askImage).mockImplementation(
      (request, onChunk) => new Promise<void>((resolve) => {
        finish = () => {
          onChunk({
            recordId: request.recordId,
            requestId: request.requestId,
            text: "stale answer",
            done: true,
          });
          resolve();
        };
      }),
    );
    const { result } = renderHook(() => useImageSession({ recordId: "record-a" }));

    act(() => {
      result.current.loadSession({
        image: { name: "a.png", dataUrl: "data:image/png;base64,AAA" },
        ocrText: "OCR A",
        messages: [],
      });
    });
    act(() => {
      void result.current.ask("question");
    });
    await waitFor(() => expect(modelClient.askImage).toHaveBeenCalledOnce());
    const requestId = vi.mocked(modelClient.askImage).mock.calls[0][0].requestId!;

    act(() => {
      result.current.clearConversation();
    });
    await waitFor(() => expect(modelClient.cancelGeneration).toHaveBeenCalledWith(requestId));
    expect(result.current.isAnswering).toBe(false);
    expect(result.current.state.messages).toEqual([]);

    await act(async () => {
      finish?.();
    });
    expect(result.current.state.messages).toEqual([]);
    expect(result.current.streamingText).toBe("");
  });

  it("keeps the current session when the panel is hidden", async () => {
    const { result } = renderHook(() => useImageSession({ recordId: "record-a" }));
    await waitFor(() => expect(eventHandlers.has("quick-panel-closing")).toBe(true));
    act(() => {
      result.current.loadSession({
        image: { name: "a.png", dataUrl: "data:image/png;base64,AAA" },
        ocrText: "OCR A",
        messages: [{ role: "assistant", content: "saved answer" }],
      });
    });
    act(() => {
      eventHandlers.get("quick-panel-closing")?.();
    });

    expect(result.current.state.image?.name).toBe("a.png");
    expect(result.current.state.ocrText).toBe("OCR A");
    expect(result.current.state.messages).toEqual([
      { role: "assistant", content: "saved answer" },
    ]);
  });
});
