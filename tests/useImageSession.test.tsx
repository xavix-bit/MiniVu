import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createImageSessionState,
  shouldConfirmImageReplacement,
  useImageSession,
} from "../src/chat/useImageSession";
import type { ModelStatusResponse } from "../src/model/types";
import { exportCurrentSession } from "../src/export/exportSession";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const openMock = vi.mocked(open);

const status: ModelStatusResponse = {
  modelReady: true,
  modelDownloaded: true,
  mmprojDownloaded: true,
  modelPath: "/models/q4.gguf",
  modelManaged: true,
  mmprojPath: "/models/mmproj.gguf",
  modelSize: "1.53 GiB",
  sidecarRunning: true,
  llamaServerAvailable: true,
  inferenceBackend: "llama",
  ggufModelVariant: "q4_k_m",
  ggufVariants: [],
  modelStorageBytes: 1_637_848_448,
  activeBackend: "llama",
  mlxRuntimeAvailable: false,
  mlxModelId: "",
  mlxModelLocal: false,
  mlxModelReady: false,
  mlxRequiresNetwork: false,
};

let activeStatus = status;
type TestStreamChunk = {
  text: string;
  done: boolean;
  requestId?: string;
  modelLabel?: string;
};

let modelStreamHandler: ((event: { payload: TestStreamChunk }) => void) | undefined;

beforeEach(() => {
  activeStatus = status;
  modelStreamHandler = undefined;
  invokeMock.mockImplementation(async (command, arguments_) => {
    if (command === "get_model_status") return structuredClone(activeStatus);
    if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
    if (command === "ask_image") {
      const requestId = (arguments_ as { requestId: string }).requestId;
      modelStreamHandler?.({
        payload: {
          text: "Q4 的回答。",
          done: false,
          requestId,
          modelLabel: "MiniCPM-V 4.6 GGUF · Q4",
        },
      });
      modelStreamHandler?.({
        payload: {
          text: "",
          done: true,
          requestId,
          modelLabel: "MiniCPM-V 4.6 GGUF · Q4",
        },
      });
    }
    return undefined;
  });
  listenMock.mockImplementation(async (event, handler) => {
    if (event === "model-stream") {
      modelStreamHandler = handler as typeof modelStreamHandler;
    }
    return vi.fn();
  });
  openMock.mockResolvedValue("/tmp/export");
});

afterEach(() => {
  vi.clearAllMocks();
});

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

  it("uses the leased backend context instead of a status read before ask", async () => {
    invokeMock.mockImplementation(async (command, arguments_) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
      if (command === "ask_image") {
        const requestId = (arguments_ as { requestId: string }).requestId;
        modelStreamHandler?.({
          payload: {
            text: "Q5 的回答。",
            done: false,
            requestId,
            modelLabel: "MiniCPM-V 4.6 GGUF · Q5",
          },
        });
        modelStreamHandler?.({
          payload: { text: "", done: true, requestId, modelLabel: "MiniCPM-V 4.6 GGUF · Q5" },
        });
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());

    await act(async () => {
      await result.current.setImage({
        name: "screen.png",
        dataUrl: "data:image/png;base64,abc",
      });
    });
    await act(async () => {
      await result.current.ask("这是什么？");
    });

    await waitFor(() => expect(result.current.state.messages).toHaveLength(2));
    expect(result.current.state.messages[1]).toEqual({
      role: "assistant",
      content: "Q5 的回答。",
      modelVersion: "MiniCPM-V 4.6 GGUF · Q5",
    });

    const askCall = invokeMock.mock.calls.find(([command]) => command === "ask_image");
    const statusCall = invokeMock.mock.calls.findIndex(([command]) => command === "get_model_status");
    const askCallIndex = invokeMock.mock.calls.findIndex(([command]) => command === "ask_image");
    expect(askCall?.[1]).toEqual(expect.objectContaining({ requestId: expect.any(String) }));
    expect(statusCall).toBeLessThan(askCallIndex);
    expect(invokeMock.mock.calls.slice(statusCall + 1, askCallIndex)).not.toContainEqual([
      "get_model_status",
    ]);

    invokeMock.mockClear();
    await exportCurrentSession(result.current.state);

    expect(invokeMock).not.toHaveBeenCalledWith("get_model_status");
    expect(invokeMock).toHaveBeenCalledWith("export_session", {
      request: expect.objectContaining({
        markdown: expect.stringContaining("模型：`MiniCPM-V 4.6 GGUF · Q5`"),
      }),
    });
    const exportRequest = invokeMock.mock.calls.find(([command]) => command === "export_session")?.[1];
    expect(JSON.stringify(exportRequest)).not.toContain("GGUF · Q4");
  });

  it("ignores a stream chunk carrying another request identity", async () => {
    invokeMock.mockImplementation(async (command, arguments_) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
      if (command === "ask_image") {
        const requestId = (arguments_ as { requestId: string }).requestId;
        modelStreamHandler?.({
          payload: {
            text: "错误请求的回答。",
            done: false,
            requestId: "stale-request",
            modelLabel: "MiniCPM-V 4.6 GGUF · Q6",
          },
        });
        modelStreamHandler?.({
          payload: {
            text: "正确回答。",
            done: false,
            requestId,
            modelLabel: "MiniCPM-V 4.6 GGUF · Q5",
          },
        });
        modelStreamHandler?.({
          payload: { text: "", done: true, requestId, modelLabel: "MiniCPM-V 4.6 GGUF · Q5" },
        });
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());

    await act(async () => {
      await result.current.setImage({ name: "screen.png", dataUrl: "data:image/png;base64,abc" });
    });
    await act(async () => {
      await result.current.ask("这是什么？");
    });

    expect(result.current.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: "正确回答。",
      modelVersion: "MiniCPM-V 4.6 GGUF · Q5",
    });
  });

  it("does not attach failed generation metadata to a later answer", async () => {
    let askCount = 0;
    invokeMock.mockImplementation(async (command, arguments_) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
      if (command === "ask_image") {
        askCount += 1;
        const requestId = (arguments_ as { requestId: string }).requestId;
        if (askCount === 1) {
          modelStreamHandler?.({
            payload: { text: "", done: true, requestId, modelLabel: "MiniCPM-V 4.6 GGUF · Q6" },
          });
          throw new Error("generation failed");
        }
        modelStreamHandler?.({
          payload: { text: "成功。", done: false, requestId, modelLabel: "Custom MLX · local-vlm" },
        });
        modelStreamHandler?.({
          payload: { text: "", done: true, requestId, modelLabel: "Custom MLX · local-vlm" },
        });
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());
    await act(async () => {
      await result.current.setImage({ name: "screen.png", dataUrl: "data:image/png;base64,abc" });
    });

    await act(async () => { await result.current.ask("第一次"); });
    await act(async () => { await result.current.ask("第二次"); });

    expect(result.current.state.messages).toEqual([
      { role: "user", content: "第二次" },
      { role: "assistant", content: "成功。", modelVersion: "Custom MLX · local-vlm" },
    ]);
  });
});
