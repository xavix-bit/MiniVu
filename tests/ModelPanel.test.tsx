import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPanel } from "../src/settings/ModelPanel";
import type { ModelStatusResponse } from "../src/model/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const status: ModelStatusResponse = {
  modelReady: true,
  modelDownloaded: true,
  mmprojDownloaded: true,
  modelPath: "/models/q4.gguf",
  mmprojPath: "/models/mmproj.gguf",
  modelSize: "1.5 GB",
  sidecarRunning: false,
  llamaServerAvailable: true,
  inferenceBackend: "llama",
  ggufModelVariant: "q4_k_m",
  ggufVariants: [
    { variant: "q4_k_m", installed: true, installedBytes: 529_101_504, partialBytes: 0, expectedBytes: 529_101_504, active: true },
    { variant: "q5_k_m", installed: false, installedBytes: 0, partialBytes: 0, expectedBytes: 577_802_944, active: false },
    { variant: "q6_k", installed: false, installedBytes: 0, partialBytes: 0, expectedBytes: 629_548_224, active: false },
  ],
  modelStorageBytes: 1_637_848_448,
  activeBackend: "llama",
  mlxRuntimeAvailable: false,
  mlxModelId: "",
  mlxModelReady: false,
  mlxRequiresNetwork: false,
};

const activeDownload = {
  taskId: 41,
  variant: "q5_k_m" as const,
  status: "running",
  file: "model",
  downloaded: 100,
  total: 200,
  source: "modelscope",
};

beforeEach(() => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "get_model_status") return structuredClone(status);
    if (command === "get_model_download_status") return null;
    if (command === "load_app_settings") {
      return { inferenceBackend: "llama", ggufModelVariant: "q4_k_m" };
    }
    return undefined;
  });
  listenMock.mockResolvedValue(vi.fn());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelPanel", () => {
  it("stages a variant selection without saving settings", async () => {
    render(<ModelPanel />);
    const clearVariant = await screen.findByRole("button", { name: /清晰/ });

    fireEvent.click(clearVariant);

    await waitFor(() => expect(clearVariant).toHaveAttribute("aria-pressed", "true"));
    expect(invokeMock).not.toHaveBeenCalledWith("save_app_settings", expect.anything());
  });

  it("installs the staged GGUF variant through the lifecycle command", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") return null;
      if (command === "install_gguf_model") {
        return { activeVariant: "q5_k_m", modelStorageBytes: 2_000, cleanupWarning: null, inventory: [] };
      }
      return undefined;
    });
    render(<ModelPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /清晰/ }));
    fireEvent.click(screen.getByRole("button", { name: "下载并切换" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_gguf_model", {
      variant: "q5_k_m",
      force: false,
    }));
    expect(invokeMock).not.toHaveBeenCalledWith("download_model", expect.anything());
  });

  it("cancels the exact active task id", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") return structuredClone(activeDownload);
      return undefined;
    });
    render(<ModelPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "取消下载" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_model_download", { taskId: 41 }));
  });

  it("shows the cancel-request state while precise cancellation is pending", async () => {
    let finishCancel: (() => void) | undefined;
    const cancelPending = new Promise<void>((resolve) => { finishCancel = resolve; });
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") return structuredClone(activeDownload);
      if (command === "cancel_model_download") return cancelPending;
      return undefined;
    });
    render(<ModelPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "取消下载" }));

    expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled();
    finishCancel?.();
  });

  it("requires inline confirmation before removing local GGUF models", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") return null;
      if (command === "remove_installed_models") {
        return { activeVariant: "q4_k_m", modelStorageBytes: 0, cleanupWarning: "一个旧文件稍后清理", inventory: [] };
      }
      return undefined;
    });
    render(<ModelPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "移除本地模型" }));
    expect(screen.getByText(/将移除全部已安装 GGUF 模型/)).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("remove_installed_models");

    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("remove_installed_models"));
    expect(await screen.findByText("本地模型已移除")).toBeInTheDocument();
    expect(screen.getByText("一个旧文件稍后清理")).toBeInTheDocument();
  });

  it("ignores progress events from stale task ids", async () => {
    let progressHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    listenMock.mockImplementation(async (_event, handler) => {
      progressHandler = handler as typeof progressHandler;
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") return structuredClone(activeDownload);
      return undefined;
    });
    render(<ModelPanel />);
    await screen.findByRole("button", { name: "取消下载" });

    act(() => progressHandler?.({ payload: {
      taskId: 40, variant: "q5_k_m", file: "model", status: "running", downloaded: 99, total: 100,
    } }));
    expect(screen.queryByText("99%")).not.toBeInTheDocument();

    act(() => progressHandler?.({ payload: {
      taskId: 41, variant: "q5_k_m", file: "model", status: "running", downloaded: 100, total: 200,
    } }));
    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});
