import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindowShell } from "../src/app-shell/MainWindowShell";
import type { ModelStatusResponse } from "../src/model/types";
import {
  createDefaultSettings,
  loadSettings,
  updateSettings,
  type AppSettings,
} from "../src/settings/settingsStore";

const { getEnvironmentStatus, getModelStatus } = vi.hoisted(() => ({
  getEnvironmentStatus: vi.fn(),
  getModelStatus: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/model/modelClient", () => ({
  modelClient: { getEnvironmentStatus, getModelStatus },
}));
vi.mock("../src/settings/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/settingsStore")>();
  return {
    ...actual,
    loadSettings: vi.fn(),
    updateSettings: vi.fn(),
  };
});
vi.mock("../src/app-shell/EnvironmentSetupPanel", () => ({
  EnvironmentSetupPanel: () => <div data-testid="environment-setup">修复内容</div>,
}));
vi.mock("../src/settings/SettingsPanel", () => ({
  SettingsPanel: () => <div>通用设置内容</div>,
}));
vi.mock("../src/privacy/PrivacyNotice", () => ({
  PrivacyNotice: () => <div>隐私内容</div>,
}));
vi.mock("../src/workbench/WorkbenchShell", () => ({
  WorkbenchShell: () => <div data-testid="workbench" />,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createStatus(): ModelStatusResponse {
  return {
    modelReady: false,
    modelDownloaded: false,
    mmprojDownloaded: false,
    modelPath: "",
    mmprojPath: "",
    modelSize: null,
    sidecarRunning: false,
    llamaServerAvailable: false,
    inferenceBackend: "llama",
    ggufModelVariant: "q4_k_m",
    activeBackend: "llama-sidecar",
    mlxRuntimeAvailable: true,
    mlxModelId: "mlx-community/MiniCPM-V-4.6-4bit",
    mlxModelReady: false,
    mlxRequiresNetwork: false,
  };
}

describe("model operation coordination", () => {
  let initial: AppSettings;

  beforeEach(() => {
    vi.clearAllMocks();
    initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockImplementation(async (patch) => ({
      ...initial,
      ...patch,
    }));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_device_info") {
        return {
          platform: "macos",
          isAppleSilicon: true,
          memoryGb: 16,
          recommended: true,
          message: "",
        };
      }
      return undefined;
    });
    vi.mocked(listen).mockResolvedValue(vi.fn());
    getModelStatus.mockResolvedValue(createStatus());
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: true,
      environmentReady: false,
    });
  });

  it("keeps repair blocked until a real sibling settings write finishes", async () => {
    const sourceSave = createDeferred<AppSettings>();
    vi.mocked(updateSettings).mockImplementation((patch) => {
      if ("downloadMirror" in patch) {
        return sourceSave.promise;
      }
      return Promise.resolve({ ...initial, ...patch });
    });

    render(<MainWindowShell />);
    await screen.findByTestId("workbench");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsNav = screen.getByRole("navigation", { name: "设置导航" });
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));

    const source = await screen.findByRole("combobox", { name: "下载来源" });
    const repair = await screen.findByRole("button", { name: "修复模型组件" });
    const variant = screen.getByRole("button", { name: /高质量/ });
    expect(repair).toBeEnabled();
    expect(variant).toBeEnabled();

    fireEvent.change(source, { target: { value: "modelscope" } });

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ downloadMirror: "modelscope" }),
    );
    await waitFor(() => expect(repair).toBeDisabled());
    expect(source).toBeDisabled();
    expect(variant).toBeDisabled();
    fireEvent.click(repair);
    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();

    await act(async () => {
      sourceSave.resolve({ ...initial, downloadMirror: "modelscope" });
      await sourceSave.promise;
    });

    await waitFor(() => expect(repair).toBeEnabled());
    await waitFor(() => expect(variant).toBeEnabled());
    fireEvent.click(repair);
    expect(await screen.findByTestId("environment-setup")).toBeVisible();
  }, 10_000);
});
