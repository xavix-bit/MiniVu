import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPanel } from "../src/settings/ModelPanel";
import type { ModelStatusResponse } from "../src/model/types";
import {
  loadSettings,
  saveSettings,
  updateSettings,
} from "../src/settings/settingsStore";

const { getModelStatus } = vi.hoisted(() => ({
  getModelStatus: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/model/modelClient", () => ({
  modelClient: { getModelStatus },
}));
vi.mock("../src/settings/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/settingsStore")>();
  return {
    ...actual,
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
    updateSettings: vi.fn(),
  };
});

function createStatus(overrides: Partial<ModelStatusResponse> = {}): ModelStatusResponse {
  return {
    modelReady: true,
    modelDownloaded: true,
    mmprojDownloaded: true,
    modelPath: "/Users/test/.minivu/model.gguf",
    mmprojPath: "/Users/test/.minivu/mmproj.gguf",
    modelSize: "1.5 GB",
    sidecarRunning: false,
    llamaServerAvailable: true,
    inferenceBackend: "llama",
    ggufModelVariant: "q4_k_m",
    activeBackend: "llama-sidecar",
    mlxRuntimeAvailable: true,
    mlxModelId: "mlx-community/MiniCPM-V-4.6-4bit",
    mlxModelReady: true,
    mlxRequiresNetwork: false,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ModelPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModelStatus.mockResolvedValue(createStatus());
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(loadSettings).mockResolvedValue({
      shortcut: "Control+Option+Space",
      modelWarmMinutes: 10,
      autoCheckModelUpdates: false,
      saveHistoryByDefault: true,
      allowCloudFallback: false,
      onboardingComplete: true,
      ggufModelVariant: "q4_k_m",
      downloadMirror: "auto",
      preferredMirror: null,
      lastSpeedTestAt: null,
      theme: "system",
      preloadModel: false,
      captureRetention: "24h",
      backgroundWarmup: false,
      inferenceBackend: "llama",
      mlxModelId: "mlx-community/MiniCPM-V-4.6-4bit",
    });
    vi.mocked(saveSettings).mockResolvedValue(undefined);
    vi.mocked(updateSettings).mockImplementation(async (patch) => ({
      ...(await vi.mocked(loadSettings)()),
      ...patch,
    }));
  });

  it("registers once and disposes a listener that resolves after unmount", async () => {
    const cleanup = vi.fn();
    let resolveListener!: (cleanup: () => void) => void;
    vi.mocked(listen).mockReturnValue(
      new Promise((resolve) => {
        resolveListener = resolve;
      }),
    );

    const { unmount } = render(<ModelPanel />);
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(1));
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith("model-download-progress", expect.any(Function));
    unmount();

    await act(async () => {
      resolveListener(cleanup);
      await Promise.resolve();
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("shows progress and speed from its sole download listener with task-facing labels", async () => {
    let progressHandler:
      | ((event: {
          payload: {
            file: string;
            status?: string;
            message?: string;
            downloaded: number;
            total: number | null;
            source?: string;
            speedMbps?: number;
          };
        }) => void)
      | undefined;
    vi.mocked(listen).mockImplementation(async (_event, handler) => {
      progressHandler = handler as typeof progressHandler;
      return vi.fn();
    });

    render(<ModelPanel />);
    await screen.findByText(/主模型 · 均衡/);

    act(() => {
      progressHandler?.({
        payload: {
          file: "model",
          status: "running",
          downloaded: 42,
          total: 100,
          source: "ModelScope",
          speedMbps: 12.3,
        },
      });
    });

    const progress = screen.getByRole("generic", { name: "下载进度" });
    expect(within(progress).getByText("42%")).toBeVisible();
    expect(within(progress).getByText("12.3 MB/s")).toBeVisible();
    expect(within(progress).getByText("配套文件")).toBeVisible();
    expect(within(progress).queryByText("视觉投影器")).not.toBeInTheDocument();
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("reports freshly fetched status after a successful default-model download", async () => {
    const initial = createStatus({
      modelReady: false,
      modelDownloaded: false,
      mmprojDownloaded: false,
      modelSize: null,
    });
    const refreshed = createStatus({
      modelReady: true,
      modelDownloaded: true,
      mmprojDownloaded: true,
      modelSize: "1.5 GB",
    });
    getModelStatus.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const onStatusChange = vi.fn();

    render(<ModelPanel onStatusChange={onStatusChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "下载 / 更新模型" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("download_model", { force: true }));
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(refreshed));
    expect(getModelStatus).toHaveBeenCalledTimes(2);
  });

  it("refreshes on token changes without remounting or duplicating its listener", async () => {
    const cleanup = vi.fn();
    vi.mocked(listen).mockResolvedValue(cleanup);

    const { rerender, unmount } = render(<ModelPanel refreshToken={0} />);
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(1));
    expect(listen).toHaveBeenCalledTimes(1);

    rerender(<ModelPanel refreshToken={1} />);
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(2));
    expect(listen).toHaveBeenCalledTimes(1);

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("shows a recoverable product message when status loading fails", async () => {
    getModelStatus.mockRejectedValueOnce(
      new Error("get_model_status IPC rejected: sidecar socket 18765"),
    );

    render(<ModelPanel />);

    expect(await screen.findByText("暂时无法读取模型状态，请重试。")).toBeVisible();
    expect(screen.queryByText(/IPC|sidecar|18765/)).not.toBeInTheDocument();

    getModelStatus.mockResolvedValueOnce(createStatus());
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));

    expect(await screen.findByText("主模型 · 均衡")).toBeVisible();
    expect(screen.queryByText("暂时无法读取模型状态，请重试。")).not.toBeInTheDocument();

    getModelStatus.mockRejectedValueOnce(new Error("stale backend socket closed"));
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));

    expect(await screen.findByText("暂时无法读取模型状态，请重试。")).toBeVisible();
    expect(screen.getByText("主模型 · 均衡")).toBeVisible();
    expect(screen.getByRole("button", { name: "下载 / 更新模型" })).toBeDisabled();
    expect(screen.queryByText(/stale backend|socket closed/)).not.toBeInTheDocument();
  });

  it("ignores an older refresh that resolves after the latest request", async () => {
    const older = createDeferred<ModelStatusResponse>();
    const latest = createDeferred<ModelStatusResponse>();
    const onStatusChange = vi.fn();
    getModelStatus
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);

    const { rerender } = render(
      <ModelPanel refreshToken={0} onStatusChange={onStatusChange} />,
    );
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(1));

    rerender(<ModelPanel refreshToken={1} onStatusChange={onStatusChange} />);
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(2));

    await act(async () => {
      latest.resolve(
        createStatus({
          ggufModelVariant: "q6_k",
          modelDownloaded: false,
          modelReady: false,
        }),
      );
      await latest.promise;
    });
    expect(await screen.findByText("主模型 · 高质量")).toBeVisible();
    expect(screen.getByText("需要下载模型")).toBeVisible();

    await act(async () => {
      older.resolve(createStatus({ ggufModelVariant: "q4_k_m" }));
      await older.promise;
    });

    expect(screen.getByText("主模型 · 高质量")).toBeVisible();
    expect(screen.queryByText("主模型 · 均衡")).not.toBeInTheDocument();
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("does not emit a callback from a stale action refresh", async () => {
    const actionRefresh = createDeferred<ModelStatusResponse>();
    const tokenRefresh = createDeferred<ModelStatusResponse>();
    const onStatusChange = vi.fn();
    getModelStatus
      .mockResolvedValueOnce(
        createStatus({
          modelReady: false,
          modelDownloaded: false,
          mmprojDownloaded: false,
        }),
      )
      .mockReturnValueOnce(actionRefresh.promise)
      .mockReturnValueOnce(tokenRefresh.promise);

    const { rerender } = render(
      <ModelPanel refreshToken={0} onStatusChange={onStatusChange} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "下载 / 更新模型" }));
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(2));

    rerender(<ModelPanel refreshToken={1} onStatusChange={onStatusChange} />);
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(3));

    await act(async () => {
      tokenRefresh.resolve(
        createStatus({
          ggufModelVariant: "q6_k",
          modelDownloaded: false,
          modelReady: false,
        }),
      );
      await tokenRefresh.promise;
    });
    expect(await screen.findByText("主模型 · 高质量")).toBeVisible();

    await act(async () => {
      actionRefresh.resolve(createStatus({ ggufModelVariant: "q4_k_m" }));
      await actionRefresh.promise;
    });

    expect(screen.getByText("主模型 · 高质量")).toBeVisible();
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("offers an inline repair task without exposing paths or process status", async () => {
    const missingComponent = createStatus({
      modelReady: false,
      modelDownloaded: false,
      mmprojDownloaded: false,
      llamaServerAvailable: false,
      modelPath: "/private/models/should-not-be-visible.gguf",
      mmprojPath: "/private/models/also-hidden.gguf",
      activeBackend: "hidden-sidecar-detail",
      sidecarRunning: true,
    });
    getModelStatus.mockResolvedValue(missingComponent);
    const onRepairRuntime = vi.fn();

    render(<ModelPanel onRepairRuntime={onRepairRuntime} />);

    const repair = await screen.findByRole("button", { name: "修复模型组件" });
    expect(screen.getByText("模型组件需要修复后才能下载。")).toBeVisible();
    expect(screen.getByText("需要下载模型")).toBeVisible();
    expect(screen.queryByText(missingComponent.modelPath)).not.toBeInTheDocument();
    expect(screen.queryByText(missingComponent.mmprojPath)).not.toBeInTheDocument();
    expect(screen.queryByText("问图准备")).not.toBeInTheDocument();
    expect(screen.queryByText(/sidecar/i)).not.toBeInTheDocument();

    fireEvent.click(repair);
    expect(onRepairRuntime).toHaveBeenCalledTimes(1);
  });

  it("disables every model action during external repair", async () => {
    getModelStatus.mockResolvedValue(
      createStatus({
        modelReady: false,
        llamaServerAvailable: false,
      }),
    );

    render(<ModelPanel disabled onRepairRuntime={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "修复模型组件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /均衡/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载 / 更新模型" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新状态" })).toBeDisabled();
  });

  it("reports freshly fetched status after changing the model variant", async () => {
    const initial = createStatus({ ggufModelVariant: "q4_k_m" });
    const refreshed = createStatus({
      ggufModelVariant: "q6_k",
      modelDownloaded: false,
      modelReady: false,
    });
    getModelStatus.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const onStatusChange = vi.fn();

    render(<ModelPanel onStatusChange={onStatusChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /高质量/ }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ ggufModelVariant: "q6_k" }),
    );
    expect(saveSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(refreshed));
  });

  it("owns the experimental model download and reports its fresh status", async () => {
    const initial = createStatus({
      inferenceBackend: "mlx",
      modelReady: false,
      mlxRuntimeAvailable: true,
      mlxModelReady: false,
    });
    const refreshed = createStatus({
      inferenceBackend: "mlx",
      modelReady: true,
      mlxRuntimeAvailable: true,
      mlxModelReady: true,
    });
    getModelStatus.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const onStatusChange = vi.fn();

    render(<ModelPanel onStatusChange={onStatusChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "下载实验模型" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("download_mlx_model", { force: true }),
    );
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(refreshed));
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("stops a deferred model action from updating after unmount", async () => {
    const download = createDeferred<void>();
    getModelStatus.mockResolvedValue(
      createStatus({
        inferenceBackend: "mlx",
        modelReady: false,
        mlxRuntimeAvailable: true,
        mlxModelReady: false,
      }),
    );
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "download_mlx_model") {
        await download.promise;
      }
      return undefined;
    });
    const onStatusChange = vi.fn();

    const { unmount } = render(<ModelPanel onStatusChange={onStatusChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "下载实验模型" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("download_mlx_model", { force: true }),
    );
    unmount();

    await act(async () => {
      download.resolve(undefined);
      await download.promise;
      await Promise.resolve();
    });

    expect(getModelStatus).toHaveBeenCalledTimes(1);
    expect(onStatusChange).not.toHaveBeenCalled();
  });
});
