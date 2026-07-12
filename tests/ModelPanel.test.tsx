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

const oldTerminalDownload = {
  ...activeDownload,
  status: "done",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    expect(await screen.findAllByText("下载完成")).toHaveLength(2);
  });

  it("cancels the exact active task id", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") return structuredClone(activeDownload);
      return undefined;
    });
    render(<ModelPanel />);

    const cancel = await screen.findByRole("button", { name: "取消下载" });
    expect(screen.getByRole("button", { name: /清晰/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("正在下载主模型 50% · ModelScope")).toBeInTheDocument();
    fireEvent.click(cancel);

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

  it("does not accept a same-variant event before a newer task is claimed", async () => {
    let progressHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    let installStarted = false;
    const installPending = new Promise(() => undefined);
    const pollPending = new Promise(() => undefined);
    listenMock.mockImplementation(async (_event, handler) => {
      progressHandler = handler as typeof progressHandler;
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") {
        return installStarted ? pollPending : structuredClone(oldTerminalDownload);
      }
      if (command === "install_gguf_model") {
        installStarted = true;
        return installPending;
      }
      return undefined;
    });
    render(<ModelPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /清晰/ }));
    fireEvent.click(screen.getByRole("button", { name: "下载并切换" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_gguf_model", expect.anything()));

    act(() => progressHandler?.({ payload: {
      taskId: 41, variant: "q5_k_m", file: "model", status: "running", downloaded: 99, total: 100,
    } }));

    expect(screen.queryByText("99%")).not.toBeInTheDocument();
  });

  it("keeps polling past an old terminal snapshot until it claims a newer active task", async () => {
    let downloadStatusCalls = 0;
    const installPending = new Promise(() => undefined);
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") {
        downloadStatusCalls += 1;
        return downloadStatusCalls >= 4
          ? { ...activeDownload, taskId: 42 }
          : structuredClone(oldTerminalDownload);
      }
      if (command === "install_gguf_model") return installPending;
      return undefined;
    });
    render(<ModelPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /清晰/ }));
    fireEvent.click(screen.getByRole("button", { name: "下载并切换" }));

    expect(await screen.findByRole("button", { name: "取消下载" }, { timeout: 1_500 })).toBeEnabled();
  });

  it("restores cancel-requested state on mount without allowing another cancel", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") {
        return { ...activeDownload, status: "cancelRequested" };
      }
      return undefined;
    });
    render(<ModelPanel />);

    const button = await screen.findByRole("button", { name: "正在取消…" });
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: /清晰/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("下载进度").querySelector(".model-download-progress__item"))
      .toHaveClass("is-canceling");
    fireEvent.click(button);
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_model_download", expect.anything());
  });

  it("uses a setup action when the GGUF runtime is unavailable", async () => {
    const onOpenSetup = vi.fn();
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") {
        return { ...structuredClone(status), llamaServerAvailable: false };
      }
      if (command === "get_model_download_status") return null;
      return undefined;
    });
    render(<ModelPanel onOpenSetup={onOpenSetup} />);

    fireEvent.click(await screen.findByRole("button", { name: "去环境配置" }));

    expect(onOpenSetup).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith("install_gguf_model", expect.anything());
  });

  it("ignores an older deferred snapshot after a newer task was restored", async () => {
    const staleSnapshot = deferred<typeof activeDownload>();
    let downloadStatusCalls = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") {
        downloadStatusCalls += 1;
        if (downloadStatusCalls === 1) return { ...activeDownload, taskId: 42 };
        return staleSnapshot.promise;
      }
      return undefined;
    });
    render(<ModelPanel />);
    await screen.findByRole("button", { name: "取消下载" });
    await waitFor(() => expect(downloadStatusCalls).toBeGreaterThanOrEqual(2), { timeout: 1_200 });

    await act(async () => staleSnapshot.resolve(structuredClone(activeDownload)));
    fireEvent.click(screen.getByRole("button", { name: "取消下载" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_model_download", { taskId: 42 }));
    expect(invokeMock).not.toHaveBeenCalledWith("cancel_model_download", { taskId: 41 });
  });

  it("guards install synchronously before awaiting the baseline snapshot", async () => {
    const baseline = deferred<null>();
    let downloadStatusCalls = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") {
        downloadStatusCalls += 1;
        return downloadStatusCalls === 1 ? null : baseline.promise;
      }
      if (command === "install_gguf_model") {
        return { activeVariant: "q5_k_m", modelStorageBytes: 2_000, cleanupWarning: null, inventory: [] };
      }
      return undefined;
    });
    render(<ModelPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /清晰/ }));
    const install = screen.getByRole("button", { name: "下载并切换" });

    fireEvent.click(install);
    fireEvent.click(install);

    expect(downloadStatusCalls).toBe(2);
    baseline.resolve(null);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === "install_gguf_model")).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith("install_gguf_model", { variant: "q5_k_m", force: false });
  });

  it("does not resurrect a task when a pre-terminal snapshot resolves late", async () => {
    let progressHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    const staleRunning = deferred<typeof activeDownload>();
    let downloadStatusCalls = 0;
    let terminal = false;
    listenMock.mockImplementation(async (_event, handler) => {
      progressHandler = handler as typeof progressHandler;
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") {
        return terminal
          ? { ...structuredClone(status), ggufVariants: status.ggufVariants.map((item) => item.variant === "q5_k_m" ? { ...item, partialBytes: 100 } : item) }
          : structuredClone(status);
      }
      if (command === "get_model_download_status") {
        downloadStatusCalls += 1;
        if (downloadStatusCalls === 1) return { ...activeDownload, taskId: 42 };
        if (downloadStatusCalls === 2) return staleRunning.promise;
        return { ...activeDownload, taskId: 42, status: "canceled" };
      }
      return undefined;
    });
    render(<ModelPanel />);
    await screen.findByRole("button", { name: "取消下载" });
    await waitFor(() => expect(downloadStatusCalls).toBeGreaterThanOrEqual(2), { timeout: 1_200 });

    terminal = true;
    await act(async () => {
      progressHandler?.({ payload: {
        taskId: 42, variant: "q5_k_m", file: "model", status: "canceled", downloaded: 100, total: 200,
      } });
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "继续下载并切换" });

    await act(async () => staleRunning.resolve({ ...activeDownload, taskId: 42 }));

    expect(screen.getByRole("button", { name: "继续下载并切换" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "取消下载" })).not.toBeInTheDocument();
  });

  it.each([
    ["模型下载已取消", "is-canceled", "已暂停，可继续下载"],
    ["网络不可用", "is-failed", "下载失败"],
  ])("keeps terminal catch ownership on mmproj: %s", async (error, className, detail) => {
    let installStarted = false;
    const installResult = deferred<never>();
    let downloadStatusCalls = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") {
        downloadStatusCalls += 1;
        if (downloadStatusCalls <= 2) return null;
        return installStarted
          ? { ...activeDownload, taskId: 42, file: "mmproj", source: "modelscope" }
          : null;
      }
      if (command === "install_gguf_model") {
        installStarted = true;
        return installResult.promise;
      }
      return undefined;
    });
    render(<ModelPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /清晰/ }));
    fireEvent.click(screen.getByRole("button", { name: "下载并切换" }));
    await screen.findByRole("button", { name: "取消下载" }, { timeout: 1_200 });

    installResult.reject(new Error(error));

    const terminalDetail = await screen.findByText(detail);
    const item = terminalDetail.closest(".model-download-progress__item");
    expect(item).toHaveClass(className);
    expect(item).toHaveTextContent("视觉投影器");
  });

  it("does not let an old install rejection clear a newer resume operation", async () => {
    let progressHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    const firstInstall = deferred<never>();
    const secondInstall = deferred<never>();
    const secondPoll = deferred<null>();
    let installCalls = 0;
    let downloadStatusCalls = 0;
    let terminal = false;
    listenMock.mockImplementation(async (_event, handler) => {
      progressHandler = handler as typeof progressHandler;
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") {
        return terminal
          ? { ...structuredClone(status), ggufVariants: status.ggufVariants.map((item) => item.variant === "q5_k_m" ? { ...item, partialBytes: 100 } : item) }
          : structuredClone(status);
      }
      if (command === "get_model_download_status") {
        downloadStatusCalls += 1;
        if (downloadStatusCalls <= 2) return null;
        if (!terminal) return { ...activeDownload, taskId: 42, file: "mmproj" };
        if (downloadStatusCalls <= 5) return { ...activeDownload, taskId: 42, file: "mmproj", status: "canceled" };
        return secondPoll.promise;
      }
      if (command === "install_gguf_model") {
        installCalls += 1;
        return installCalls === 1 ? firstInstall.promise : secondInstall.promise;
      }
      return undefined;
    });
    render(<ModelPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /清晰/ }));
    fireEvent.click(screen.getByRole("button", { name: "下载并切换" }));
    await screen.findByRole("button", { name: "取消下载" }, { timeout: 1_200 });

    terminal = true;
    await act(async () => {
      progressHandler?.({ payload: {
        taskId: 42, variant: "q5_k_m", file: "mmproj", status: "canceled", downloaded: 100, total: 200,
      } });
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole("button", { name: "继续下载并切换" }));
    await waitFor(() => expect(installCalls).toBe(2));
    expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();

    firstInstall.reject(new Error("模型下载已取消"));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
    expect(screen.queryByText("下载失败")).not.toBeInTheDocument();
  });

  it("cleans up a listener that resolves after unmount", async () => {
    const listener = deferred<() => void>();
    const cleanupListener = vi.fn();
    const modelStatus = deferred<ModelStatusResponse>();
    const downloadStatus = deferred<null>();
    listenMock.mockReturnValue(listener.promise);
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return modelStatus.promise;
      if (command === "get_model_download_status") return downloadStatus.promise;
      return undefined;
    });
    const view = render(<ModelPanel />);

    view.unmount();
    await act(async () => {
      listener.resolve(cleanupListener);
      modelStatus.resolve(structuredClone(status));
      downloadStatus.resolve(null);
      await Promise.resolve();
    });

    expect(cleanupListener).toHaveBeenCalledTimes(1);
  });

  it("keeps an idle progress region but hides removal when storage is empty", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return { ...structuredClone(status), modelStorageBytes: 0 };
      if (command === "get_model_download_status") return null;
      return undefined;
    });
    render(<ModelPanel />);
    await screen.findByRole("button", { name: "当前使用" });

    expect(screen.getByLabelText("下载进度")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除本地模型" })).not.toBeInTheDocument();
  });

  it("renders a friendly source and pauses cleanly on a canceled event", async () => {
    let progressHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    let terminal = false;
    const resumableStatus = {
      ...structuredClone(status),
      ggufVariants: status.ggufVariants.map((item) => item.variant === "q5_k_m"
        ? { ...item, partialBytes: 100 }
        : item),
    };
    listenMock.mockImplementation(async (_event, handler) => {
      progressHandler = handler as typeof progressHandler;
      return vi.fn();
    });
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(terminal ? resumableStatus : status);
      if (command === "get_model_download_status") {
        return { ...activeDownload, status: terminal ? "canceled" : "running" };
      }
      return undefined;
    });
    render(<ModelPanel />);
    await screen.findByRole("button", { name: "取消下载" });

    act(() => progressHandler?.({ payload: {
      taskId: 41,
      variant: "q5_k_m",
      file: "model",
      status: "running",
      downloaded: 100,
      total: 200,
      source: "ModelScope（国内镜像）",
      speedMbps: 5,
    } }));
    expect(screen.getByText("正在下载主模型 50% · ModelScope")).toBeInTheDocument();
    expect(screen.queryByText(/国内镜像/)).not.toBeInTheDocument();

    terminal = true;
    act(() => progressHandler?.({ payload: {
      taskId: 41,
      variant: "q5_k_m",
      file: "model",
      status: "canceled",
      downloaded: 100,
      total: 200,
      source: "ModelScope（国内镜像）",
    } }));

    expect(screen.getByText("已暂停，可继续下载").closest(".model-download-progress__item"))
      .toHaveClass("is-canceled");
    expect(screen.queryByText("5.0 MB/s")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "继续下载并切换" })).toBeEnabled();
  });

  it("shows failed progress instead of treating a terminal event as running", async () => {
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
      taskId: 41,
      variant: "q5_k_m",
      file: "model",
      status: "running",
      downloaded: 100,
      total: 200,
      source: "HuggingFace（海外源）",
      speedMbps: 8,
    } }));
    expect(screen.getByText("正在下载主模型 50% · Hugging Face")).toBeInTheDocument();

    await act(async () => {
      progressHandler?.({ payload: {
        taskId: 41,
        variant: "q5_k_m",
        file: "model",
        status: "failed",
        downloaded: 100,
        total: 200,
        source: "HuggingFace（海外源）",
        speedMbps: 8,
      } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("下载失败").closest(".model-download-progress__item"))
      .toHaveClass("is-failed");
    expect(screen.queryByText("8.0 MB/s")).not.toBeInTheDocument();
  });

  it.each([
    ["模型下载已取消", "已暂停，可继续下载"],
    ["网络不可用", "下载失败"],
  ])("sets terminal progress when install rejects without an event: %s", async (error, detail) => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(status);
      if (command === "get_model_download_status") return null;
      if (command === "install_gguf_model") throw new Error(error);
      return undefined;
    });
    render(<ModelPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /清晰/ }));
    fireEvent.click(screen.getByRole("button", { name: "下载并切换" }));

    expect(await screen.findByText(detail)).toBeInTheDocument();
  });
});
