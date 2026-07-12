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
  mlxModelReady: false,
  mlxRequiresNetwork: false,
};

let activeStatus = status;
let modelStreamHandler: ((event: { payload: { text: string; done: boolean } }) => void) | undefined;

beforeEach(() => {
  activeStatus = status;
  modelStreamHandler = undefined;
  invokeMock.mockImplementation(async (command) => {
    if (command === "get_model_status") return structuredClone(activeStatus);
    if (command === "recognize_text_from_image_data_url") return { text: "本地文字" };
    if (command === "ask_image") {
      modelStreamHandler?.({ payload: { text: "Q4 的回答。", done: false } });
      modelStreamHandler?.({ payload: { text: "", done: true } });
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

  it("keeps the model used for a completed answer after the active model changes", async () => {
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

    activeStatus = { ...status, ggufModelVariant: "q5_k_m" };

    await waitFor(() => expect(result.current.state.messages).toHaveLength(2));
    expect(result.current.state.messages[1]).toEqual({
      role: "assistant",
      content: "Q4 的回答。",
      modelVersion: "MiniCPM-V 4.6 Q4_K_M (GGUF)",
    });

    invokeMock.mockClear();
    await exportCurrentSession(result.current.state);

    expect(invokeMock).not.toHaveBeenCalledWith("get_model_status");
    expect(invokeMock).toHaveBeenCalledWith("export_session", {
      request: expect.objectContaining({
        markdown: expect.stringContaining("模型：`MiniCPM-V 4.6 Q4_K_M (GGUF)`"),
      }),
    });
    const exportRequest = invokeMock.mock.calls.find(([command]) => command === "export_session")?.[1];
    expect(JSON.stringify(exportRequest)).not.toContain("Q5_K_M");
  });
});
