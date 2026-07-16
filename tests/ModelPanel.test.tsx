import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPanel } from "../src/settings/ModelPanel";
import type { ModelStatusResponse } from "../src/model/types";
import { loadSettings, saveSettings } from "../src/settings/settingsStore";

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
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ ggufModelVariant: "q6_k" }),
      ),
    );
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
});
