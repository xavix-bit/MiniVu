import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPreferencesPanel } from "../src/settings/ModelPreferencesPanel";
import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
} from "../src/settings/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/settings/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/settingsStore")>();
  return {
    ...actual,
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
  };
});

const appleDevice = {
  platform: "macos",
  isAppleSilicon: true,
  memoryGb: 16,
  recommended: true,
  message: "",
};

describe("ModelPreferencesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return appleDevice;
      }
      return undefined;
    });
  });

  it("fresh-merges backend and model ID changes on explicit save", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const concurrentlyUpdated = {
      ...initial,
      shortcut: "Command+Shift+8",
      captureRetention: "7d" as const,
      ggufModelVariant: "q6_k" as const,
    };
    vi.mocked(loadSettings)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(concurrentlyUpdated);

    render(<ModelPreferencesPanel />);

    fireEvent.change(await screen.findByRole("combobox", { name: "问图方式" }), {
      target: { value: "mlx" },
    });
    const modelId = screen.getByRole("textbox", { name: "实验模型" });
    fireEvent.change(modelId, { target: { value: "mlx-community/MiniCPM-V-4.6-8bit" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        ...concurrentlyUpdated,
        inferenceBackend: "mlx",
        mlxModelId: "mlx-community/MiniCPM-V-4.6-8bit",
        downloadMirror: initial.downloadMirror,
        preferredMirror: initial.preferredMirror,
        lastSpeedTestAt: initial.lastSpeedTestAt,
      }),
    );
  });

  it("only offers experimental acceleration on Apple Silicon", async () => {
    const persistedMlxSettings = {
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx" as const,
    };
    vi.mocked(loadSettings).mockResolvedValue(persistedMlxSettings);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return { ...appleDevice, isAppleSilicon: false };
      }
      return undefined;
    });

    render(<ModelPreferencesPanel />);

    expect(await screen.findByRole("combobox", { name: "问图方式" })).toHaveValue("llama");
    expect(screen.queryByRole("option", { name: "实验加速" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "安装加速组件" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        ...persistedMlxSettings,
        inferenceBackend: "llama",
      }),
    );
  });

  it("installs only the acceleration component and never owns model downloads or progress", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
      inferenceBackend: "mlx",
    });
    const onSaved = vi.fn();

    render(<ModelPreferencesPanel onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "安装加速组件" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("install_mlx_runtime_command"),
    );
    expect(await screen.findByText("加速组件已安装")).toBeVisible();
    expect(onSaved).toHaveBeenCalledWith();
    expect(invoke).not.toHaveBeenCalledWith("download_mlx_model", expect.anything());
    expect(listen).not.toHaveBeenCalled();
  });

  it("auto-saves download source changes and benchmarks concrete source speeds", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const beforeSourceSave = {
      ...initial,
      shortcut: "Command+Shift+8",
    };
    const beforeBenchmarkSave = {
      ...beforeSourceSave,
      downloadMirror: "modelscope" as const,
      captureRetention: "7d" as const,
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
    vi.mocked(loadSettings)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(beforeSourceSave)
      .mockResolvedValueOnce(beforeBenchmarkSave);
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
    fireEvent.change(await screen.findByRole("combobox", { name: "下载来源" }), {
      target: { value: "modelscope" },
    });

    await waitFor(() =>
      expect(saveSettings).toHaveBeenNthCalledWith(1, {
        ...beforeSourceSave,
        downloadMirror: "modelscope",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "测试下载速度" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenNthCalledWith(2, {
        ...beforeBenchmarkSave,
        preferredMirror: "modelscope",
        lastSpeedTestAt: "1789000000",
      }),
    );
    const results = screen.getByRole("list", { name: "下载速度结果" });
    expect(results).toHaveTextContent("ModelScope");
    expect(results).toHaveTextContent("HuggingFace");
    expect(results).toHaveTextContent("下载 42.5 MB/s");
    expect(results).toHaveTextContent("下载 18.2 MB/s");
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
    fireEvent.click(await screen.findByRole("button", { name: "安装加速组件" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("install_mlx_runtime_command"));
    unmount();

    await act(async () => {
      resolveInstall();
      await pendingInstall;
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
