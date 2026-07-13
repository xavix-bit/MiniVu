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
        markdown: expect.stringContaining("处理方式：`MiniVu 本机处理 · 高精度`"),
      }),
    });
    const exportRequest = invokeMock.mock.calls.find(([command]) => command === "export_session")?.[1];
    expect(JSON.stringify(exportRequest)).not.toContain("GGUF");
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
      { role: "user", content: "第一次" },
      { role: "user", content: "第二次" },
      { role: "assistant", content: "成功。", modelVersion: "Custom MLX · local-vlm" },
    ]);
  });

  it("keeps a failed question and retries it without exposing the raw error", async () => {
    let askCount = 0;
    invokeMock.mockImplementation(async (command, arguments_) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
      if (command === "ask_image") {
        askCount += 1;
        if (askCount === 1) {
          throw new Error("http://127.0.0.1:43123 returned stderr");
        }
        const requestId = (arguments_ as { requestId: string }).requestId;
        modelStreamHandler?.({
          payload: { text: "重试成功。", done: false, requestId, modelLabel: "MiniCPM-V" },
        });
        modelStreamHandler?.({
          payload: { text: "", done: true, requestId, modelLabel: "MiniCPM-V" },
        });
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());

    await act(async () => {
      await result.current.setImage({ name: "screen.png", dataUrl: "data:image/png;base64,abc" });
    });
    await act(async () => {
      await result.current.ask("图里写了什么？");
    });

    expect(result.current.state.messages).toEqual([{ role: "user", content: "图里写了什么？" }]);
    expect(result.current.answerError).toBe("回答没有完成，请重试");
    expect(result.current.answerError).not.toContain("stderr");

    await act(async () => {
      await result.current.retryAnswer();
    });

    expect(result.current.state.messages).toEqual([
      { role: "user", content: "图里写了什么？" },
      { role: "assistant", content: "重试成功。", modelVersion: "MiniCPM-V" },
    ]);
    expect(result.current.answerError).toBe("");
  });

  it("keeps the image available when OCR fails and can retry without raw errors", async () => {
    let ocrAttempts = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") {
        ocrAttempts += 1;
        if (ocrAttempts === 1) {
          throw new Error("Vision helper stderr: private path");
        }
        return { text: "重试识别成功" };
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());

    await act(async () => {
      await result.current.setImage({ name: "screen.png", dataUrl: "data:image/png;base64,abc" });
    });

    expect(result.current.state.image?.name).toBe("screen.png");
    expect(result.current.ocrStatus).toBe("failed");
    expect(result.current.ocrError).toBe("文字没识别出来");
    expect(result.current.ocrError).not.toContain("stderr");

    await act(async () => {
      await result.current.retryOcr();
    });

    expect(result.current.ocrStatus).toBe("recognized");
    expect(result.current.state.ocrText).toBe("重试识别成功");
    expect(result.current.ocrError).toBe("");
  });

  it("blocks image changes and clearing while an answer is running", async () => {
    let finishAnswer: (() => void) | undefined;
    invokeMock.mockImplementation(async (command, arguments_) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
      if (command === "ask_image") {
        const requestId = (arguments_ as { requestId: string }).requestId;
        await new Promise<void>((resolve) => {
          finishAnswer = () => {
            modelStreamHandler?.({
              payload: { text: "完成。", done: false, requestId, modelLabel: "MiniCPM-V" },
            });
            modelStreamHandler?.({
              payload: { text: "", done: true, requestId, modelLabel: "MiniCPM-V" },
            });
            resolve();
          };
        });
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());
    await act(async () => {
      await result.current.setImage({ name: "first.png", dataUrl: "data:image/png;base64,first" });
    });

    let answerPromise: Promise<void> | undefined;
    act(() => {
      answerPromise = result.current.ask("继续分析");
    });
    await waitFor(() => expect(result.current.isAnswering).toBe(true));

    await act(async () => {
      expect(await result.current.setImage({ name: "second.png", dataUrl: "data:image/png;base64,second" })).toBe(false);
      result.current.clearConversation();
    });

    expect(result.current.state.image?.name).toBe("first.png");
    expect(result.current.state.messages).toEqual([{ role: "user", content: "继续分析" }]);

    await act(async () => {
      finishAnswer?.();
      await answerPromise;
    });
  });

  it("rejects an in-flight image read that finishes after answering starts", async () => {
    let finishAnswer: (() => void) | undefined;
    invokeMock.mockImplementation(async (command, arguments_) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
      if (command === "ask_image") {
        const requestId = (arguments_ as { requestId: string }).requestId;
        await new Promise<void>((resolve) => {
          finishAnswer = () => {
            modelStreamHandler?.({
              payload: { text: "完成。", done: false, requestId, modelLabel: "MiniCPM-V" },
            });
            modelStreamHandler?.({
              payload: { text: "", done: true, requestId, modelLabel: "MiniCPM-V" },
            });
            resolve();
          };
        });
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());
    await act(async () => {
      await result.current.setImage({ name: "first.png", dataUrl: "data:image/png;base64,first" });
    });
    const finishInFlightRead = result.current.setImage;

    let answerPromise: Promise<void> | undefined;
    act(() => {
      answerPromise = result.current.ask("继续分析");
    });
    await waitFor(() => expect(result.current.isAnswering).toBe(true));

    await act(async () => {
      expect(await finishInFlightRead({
        name: "late.png",
        dataUrl: "data:image/png;base64,late",
      })).toBe(false);
    });
    expect(result.current.state.image?.name).toBe("first.png");

    await act(async () => {
      finishAnswer?.();
      await answerPromise;
    });
  });

  it("ignores an older OCR response that arrives after the newest image result", async () => {
    const resolveOcr: Array<(value: { text: string }) => void> = [];
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "recognize_text_from_image_data_url") {
        return new Promise<{ text: string }>((resolve) => resolveOcr.push(resolve));
      }
      return undefined;
    });
    const { result } = renderHook(() => useImageSession());

    let firstOcr: Promise<boolean> | undefined;
    act(() => {
      firstOcr = result.current.setImage({
        name: "first.png",
        dataUrl: "data:image/png;base64,first",
      });
    });
    await waitFor(() => expect(resolveOcr).toHaveLength(1));

    let secondOcr: Promise<boolean> | undefined;
    act(() => {
      secondOcr = result.current.setImage({
        name: "second.png",
        dataUrl: "data:image/png;base64,second",
      });
    });
    await waitFor(() => expect(resolveOcr).toHaveLength(2));

    await act(async () => {
      resolveOcr[1]({ text: "第二张文字" });
      await secondOcr;
    });
    await act(async () => {
      resolveOcr[0]({ text: "过期的第一张文字" });
      await firstOcr;
    });

    expect(result.current.state.image?.name).toBe("second.png");
    expect(result.current.state.ocrText).toBe("第二张文字");
    expect(result.current.ocrStatus).toBe("recognized");
  });
});
