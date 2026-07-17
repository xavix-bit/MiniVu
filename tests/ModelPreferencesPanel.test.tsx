import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPreferencesPanel } from "../src/settings/ModelPreferencesPanel";
import { ModelPanel } from "../src/settings/ModelPanel";
import type { ModelStatusResponse } from "../src/model/types";
import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
  updateSettings,
  type AppSettings,
} from "../src/settings/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const { getModelStatus } = vi.hoisted(() => ({ getModelStatus: vi.fn() }));
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

const appleDevice = {
  platform: "macos",
  isAppleSilicon: true,
  memoryGb: 16,
  recommended: true,
  message: "",
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createModelStatus(
  overrides: Partial<ModelStatusResponse> = {},
): ModelStatusResponse {
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

describe("ModelPreferencesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    getModelStatus.mockResolvedValue(createModelStatus());
    vi.mocked(updateSettings).mockImplementation(async (patch) => ({
      ...createDefaultSettings(),
      onboardingComplete: true,
      ...patch,
    }));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return appleDevice;
      }
      return undefined;
    });
  });

  it("keeps defaults read-only and applies persisted settings before device detection finishes", async () => {
    const settingsLoad = createDeferred<AppSettings>();
    const deviceLoad = createDeferred<typeof appleDevice>();
    const persisted = {
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx" as const,
      mlxModelId: "local/Persisted-Model",
    };
    vi.mocked(loadSettings).mockReturnValue(settingsLoad.promise);
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_device_info") {
        return deviceLoad.promise;
      }
      return Promise.resolve(undefined);
    });

    render(<ModelPreferencesPanel />);

    const saveButton = screen.getByRole("button", { name: "保存设置" });
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect(updateSettings).not.toHaveBeenCalled();

    await act(async () => {
      settingsLoad.resolve(persisted);
      await settingsLoad.promise;
    });

    expect(await screen.findByRole("textbox", { name: "模型名称" })).toHaveValue(
      "local/Persisted-Model",
    );
    expect(saveButton).toBeEnabled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("keeps model settings disabled after load failure and recovers through retry", async () => {
    const retryLoad = createDeferred<AppSettings>();
    vi.mocked(loadSettings)
      .mockRejectedValueOnce(new Error("load_app_settings: invalid path /Users/test"))
      .mockReturnValueOnce(retryLoad.promise);

    render(<ModelPreferencesPanel />);

    expect(await screen.findByText("无法读取模型设置，请重试。")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "问图方式" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    expect(screen.queryByText(/load_app_settings|invalid path|Users\/test/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByRole("combobox", { name: "问图方式" })).toBeDisabled();

    await act(async () => {
      retryLoad.resolve({
        ...createDefaultSettings(),
        onboardingComplete: true,
        downloadMirror: "modelscope",
      });
      await retryLoad.promise;
    });

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "下载来源" })).toBeEnabled(),
    );
    expect(screen.getByRole("combobox", { name: "下载来源" })).toHaveValue("modelscope");
    expect(screen.queryByText("无法读取模型设置，请重试。")).not.toBeInTheDocument();
    expect(loadSettings).toHaveBeenCalledTimes(2);
  });

  it("saves only the experimental model ID on explicit save", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx" as const,
    };
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockResolvedValue({
      ...initial,
      mlxModelId: "mlx-community/MiniCPM-V-4.6-8bit",
    });

    render(<ModelPreferencesPanel />);

    const modelId = await screen.findByRole("textbox", { name: "模型名称" });
    fireEvent.change(modelId, { target: { value: "mlx-community/MiniCPM-V-4.6-8bit" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        mlxModelId: "mlx-community/MiniCPM-V-4.6-8bit",
      }),
    );
    expect(loadSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer experimental-model draft when a slow save resolves", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx" as const,
    };
    const save = createDeferred<AppSettings>();
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockReturnValue(save.promise);

    render(<ModelPreferencesPanel />);

    const modelId = await screen.findByRole("textbox", { name: "模型名称" });
    fireEvent.change(modelId, {
      target: { value: "mlx-community/MiniCPM-V-4.6-8bit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();

    fireEvent.change(modelId, {
      target: { value: "local/Newer-Model-Draft" },
    });
    save.resolve({
      ...initial,
      mlxModelId: "mlx-community/MiniCPM-V-4.6-8bit",
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled(),
    );
    expect(modelId).toHaveValue("local/Newer-Model-Draft");
    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
  });

  it("disables model preference controls during external repair", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
    });

    render(<ModelPreferencesPanel disabled />);

    expect(await screen.findByRole("combobox", { name: "问图方式" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "下载来源" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试下载速度" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  });

  it("keeps settings retry disabled during external repair", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("load failed"));

    render(<ModelPreferencesPanel disabled />);

    const retry = await screen.findByRole("button", { name: "重试" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(loadSettings).toHaveBeenCalledTimes(1);
  });

  it("maps model preference save failures to a product message", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx",
    });
    vi.mocked(updateSettings).mockRejectedValue(
      new Error("save_app_settings failed: permission denied"),
    );

    render(<ModelPreferencesPanel />);
    await screen.findByRole("textbox", { name: "模型名称" });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(await screen.findByText("无法保存模型设置，请重试。")).toBeVisible();
    expect(screen.queryByText(/save_app_settings|permission denied/)).not.toBeInTheDocument();
  });

  it("keeps backend controls aligned with persisted settings while a change is saving", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const committed = { ...initial, inferenceBackend: "mlx" as const };
    const save = createDeferred<AppSettings>();
    const onSaved = vi.fn();
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockReturnValue(save.promise);

    render(<ModelPreferencesPanel onSaved={onSaved} />);

    const backend = await screen.findByRole("combobox", { name: "问图方式" });
    expect(backend).toHaveValue("llama");
    expect(screen.getByRole("combobox", { name: "下载来源" })).toBeEnabled();

    fireEvent.change(backend, { target: { value: "mlx" } });

    expect(updateSettings).toHaveBeenCalledWith({ inferenceBackend: "mlx" });
    expect(backend).toHaveValue("llama");
    expect(backend).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "下载来源" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "模型名称" })).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => {
      save.resolve(committed);
      await save.promise;
    });

    await waitFor(() => expect(backend).toHaveValue("mlx"));
    expect(backend).toBeEnabled();
    expect(screen.queryByRole("combobox", { name: "下载来源" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "模型名称" })).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith(committed);
  });

  it("keeps the prior backend and shows a product error when saving fails", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const save = createDeferred<AppSettings>();
    const onSaved = vi.fn();
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockReturnValue(save.promise);

    render(<ModelPreferencesPanel onSaved={onSaved} />);
    const backend = await screen.findByRole("combobox", { name: "问图方式" });
    fireEvent.change(backend, { target: { value: "mlx" } });
    expect(backend).toHaveValue("llama");
    expect(backend).toBeDisabled();

    await act(async () => {
      save.reject(new Error("save_app_settings: disk full at /Users/test"));
      await save.promise.catch(() => undefined);
    });

    expect(await screen.findByText("无法保存问图方式，请重试。")).toBeVisible();
    expect(backend).toHaveValue("llama");
    expect(backend).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "下载来源" })).toBeInTheDocument();
    expect(screen.queryByText(/save_app_settings|disk full|Users\/test/)).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps the default backend usable when device detection fails", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        throw new Error("IOKit probe failed: code 17");
      }
      return undefined;
    });

    render(<ModelPreferencesPanel />);

    const backend = await screen.findByRole("combobox", { name: "问图方式" });
    await waitFor(() => expect(backend).toBeEnabled());
    expect(backend).toHaveValue("llama");
    expect(screen.queryByRole("option", { name: "MiniCPM-V 加速版" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "下载来源" })).toBeEnabled();
    expect(screen.getByText("暂时无法检测设备，仍可使用默认方式。")).toBeVisible();
    expect(screen.queryByText(/IOKit|code 17/)).not.toBeInTheDocument();
  });

  it("persists an unsupported experimental backend before exposing default controls", async () => {
    const persistedMlxSettings = {
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx" as const,
    };
    const committed = { ...persistedMlxSettings, inferenceBackend: "llama" as const };
    const fallback = createDeferred<AppSettings>();
    const onSaved = vi.fn();
    vi.mocked(loadSettings).mockResolvedValue(persistedMlxSettings);
    vi.mocked(updateSettings).mockReturnValue(fallback.promise);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return { ...appleDevice, isAppleSilicon: false };
      }
      return undefined;
    });

    render(<ModelPreferencesPanel onSaved={onSaved} />);

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ inferenceBackend: "llama" }),
    );
    const backend = screen.getByRole("combobox", { name: "问图方式" });
    expect(backend).toHaveValue("mlx");
    expect(backend).toBeDisabled();
    expect(screen.getByRole("option", { name: "MiniCPM-V 加速版" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "模型名称" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "下载来源" })).not.toBeInTheDocument();

    await act(async () => {
      fallback.resolve(committed);
      await fallback.promise;
    });

    await waitFor(() => expect(backend).toHaveValue("llama"));
    expect(backend).toBeEnabled();
    expect(screen.queryByRole("option", { name: "MiniCPM-V 加速版" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "下载来源" })).toBeEnabled();
    expect(onSaved).toHaveBeenCalledWith(committed);
  });

  it("installs only the acceleration component and never owns model downloads or progress", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx",
    });
    const onSaved = vi.fn();

    render(<ModelPreferencesPanel onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装问图加速" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("install_mlx_runtime_command"),
    );
    expect(await screen.findByText("问图加速已安装")).toBeVisible();
    expect(onSaved).toHaveBeenCalledWith();
    expect(invoke).not.toHaveBeenCalledWith("download_mlx_model", expect.anything());
    expect(listen).not.toHaveBeenCalled();
  });

  it("maps acceleration install failures to a product message", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx",
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return appleDevice;
      }
      if (command === "install_mlx_runtime_command") {
        throw new Error("pip subprocess exited 127: /private/tmp/runtime");
      }
      return undefined;
    });

    render(<ModelPreferencesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "安装问图加速" }));

    expect(await screen.findByText("无法安装问图加速，请重试。")).toBeVisible();
    expect(screen.queryByText(/subprocess|127|private\/tmp/)).not.toBeInTheDocument();
  });

  it("auto-saves a download source as an owned patch", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const committed = {
      ...initial,
      shortcut: "Command+Shift+8",
      downloadMirror: "modelscope" as const,
    };
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockResolvedValue(committed);

    render(<ModelPreferencesPanel />);
    const source = await screen.findByRole("combobox", { name: "下载来源" });
    fireEvent.change(source, {
      target: { value: "modelscope" },
    });

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        downloadMirror: "modelscope",
      }),
    );
    expect(source).toHaveValue("modelscope");
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("reports a pending preference operation until its write settles", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const save = createDeferred<AppSettings>();
    const onBusyChange = vi.fn();
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockReturnValue(save.promise);

    render(<ModelPreferencesPanel onBusyChange={onBusyChange} />);
    const source = await screen.findByRole("combobox", { name: "下载来源" });
    fireEvent.change(source, { target: { value: "modelscope" } });

    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    await act(async () => {
      save.resolve({ ...initial, downloadMirror: "modelscope" });
      await save.promise;
    });

    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("persists benchmark results as an owned patch", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const benchmark = {
      results: [
        {
          mirror: "modelscope" as const,
          label: "ModelScope",
          ok: true,
          latencyMs: 86,
          speedMbps: 42.5,
          error: null,
        },
        {
          mirror: "huggingface" as const,
          label: "HuggingFace",
          ok: true,
          latencyMs: 153,
          speedMbps: 18.2,
          error: null,
        },
      ],
      recommended: "modelscope" as const,
      testedAtUnix: 1_789_000_000,
    };
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockResolvedValue({
      ...initial,
      preferredMirror: "modelscope",
      lastSpeedTestAt: "1789000000",
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return appleDevice;
      }
      if (command === "benchmark_download_mirrors") {
        return benchmark;
      }
      return undefined;
    });

    render(<ModelPreferencesPanel />);
    await screen.findByRole("combobox", { name: "下载来源" });
    fireEvent.click(screen.getByRole("button", { name: "测试下载速度" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        preferredMirror: "modelscope",
        lastSpeedTestAt: "1789000000",
      }),
    );
    const results = screen.getByRole("list", { name: "下载速度结果" });
    expect(results).toHaveTextContent("ModelScope");
    expect(results).toHaveTextContent("HuggingFace");
    expect(results).toHaveTextContent("下载 42.5 MB/s");
    expect(results).toHaveTextContent("下载 18.2 MB/s");
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("does not render raw errors from individual benchmark results", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockResolvedValue(initial);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return appleDevice;
      }
      if (command === "benchmark_download_mirrors") {
        return {
          results: [
            {
              mirror: "huggingface",
              label: "HuggingFace",
              ok: false,
              latencyMs: 0,
              speedMbps: null,
              error: "reqwest TLS handshake failed at 10.0.0.8",
            },
          ],
          recommended: null,
          testedAtUnix: 1_789_000_000,
        };
      }
      return undefined;
    });

    render(<ModelPreferencesPanel />);
    await screen.findByRole("combobox", { name: "下载来源" });
    fireEvent.click(screen.getByRole("button", { name: "测试下载速度" }));

    expect(await screen.findByText("暂时无法测试此下载来源。")).toBeVisible();
    expect(screen.queryByText(/reqwest|TLS|10\.0\.0\.8/)).not.toBeInTheDocument();
  });

  it("ignores late async action completion after unmount", async () => {
    let resolveInstall!: () => void;
    const pendingInstall = new Promise<void>((resolve) => {
      resolveInstall = resolve;
    });
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx",
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return appleDevice;
      }
      if (command === "install_mlx_runtime_command") {
        await pendingInstall;
      }
      return undefined;
    });
    const onSaved = vi.fn();

    const { unmount } = render(<ModelPreferencesPanel onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装问图加速" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("install_mlx_runtime_command"));
    unmount();

    await act(async () => {
      resolveInstall();
      await pendingInstall;
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("refreshes the real model panel only after a backend commit", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const committed = { ...initial, inferenceBackend: "mlx" as const };
    const save = createDeferred<AppSettings>();
    const modelRefresh = createDeferred<ModelStatusResponse>();
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockReturnValue(save.promise);
    getModelStatus
      .mockResolvedValueOnce(createModelStatus())
      .mockReturnValueOnce(modelRefresh.promise);

    function BackendPanels() {
      const [refreshToken, setRefreshToken] = useState(0);
      return (
        <>
          <ModelPreferencesPanel
            onSaved={() => setRefreshToken((current) => current + 1)}
          />
          <ModelPanel refreshToken={refreshToken} />
        </>
      );
    }

    render(<BackendPanels />);
    const backend = await screen.findByRole("combobox", { name: "问图方式" });
    expect(await screen.findByRole("button", { name: "下载 / 更新模型" })).toBeVisible();

    fireEvent.change(backend, { target: { value: "mlx" } });

    expect(backend).toHaveValue("llama");
    expect(backend).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载 / 更新模型" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "下载加速模型" })).not.toBeInTheDocument();

    await act(async () => {
      save.resolve(committed);
      await save.promise;
    });

    await waitFor(() => expect(backend).toHaveValue("mlx"));
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "下载 / 更新模型" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "下载加速模型" })).not.toBeInTheDocument();

    await act(async () => {
      modelRefresh.resolve(
        createModelStatus({
          inferenceBackend: "mlx",
          activeBackend: "mlx-sidecar",
        }),
      );
      await modelRefresh.promise;
    });

    expect(await screen.findByRole("button", { name: "下载加速模型" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "下载 / 更新模型" })).not.toBeInTheDocument();
    expect(getModelStatus).toHaveBeenCalledTimes(2);
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
