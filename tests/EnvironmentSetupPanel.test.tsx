import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentSetupPanel } from "../src/app-shell/EnvironmentSetupPanel";

const { getEnvironmentStatus, getModelStatus, loadSettings, saveSettings, updateSettings } = vi.hoisted(() => ({
  getEnvironmentStatus: vi.fn(),
  getModelStatus: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/model/modelClient", () => ({
  modelClient: { getEnvironmentStatus, getModelStatus },
}));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings,
  saveSettings,
  updateSettings,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("EnvironmentSetupPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: false,
      inferenceBackend: "llama",
      runtimeReady: false,
      modelReady: false,
      environmentReady: false,
    });
    getModelStatus.mockResolvedValue({
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
      activeBackend: "llama",
      mlxRuntimeAvailable: false,
      mlxModelId: "",
      mlxModelReady: false,
      mlxRequiresNetwork: false,
    });
  });

  it("allows inline repair to close before start but not while setup is running", async () => {
    const setup = createDeferred<{
      runtimeReady: boolean;
      modelReady: boolean;
      shortcut: string;
    }>();
    const onCancel = vi.fn();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockReturnValueOnce(setup.promise);

    render(<EnvironmentSetupPanel showWelcome={false} onCancel={onCancel} />);

    const close = screen.getByRole("button", { name: "关闭" });
    expect(close).toHaveClass("settings-btn--secondary");
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("setup_environment");

    fireEvent.click(screen.getByRole("button", { name: "下载模型并完成配置" }));
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps repair available when setup finishes before the model is ready", async () => {
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeReady: false,
      modelReady: false,
      shortcut: "Control+Option+Space",
    });

    render(<EnvironmentSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: "下载模型并完成配置" }));

    expect(
      await screen.findByText("模型准备未完成，请检查网络后重试。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "下载模型并完成配置" })).toBeEnabled();
    expect(screen.queryByText("配置完成")).not.toBeInTheDocument();
  });

  it("closes inline repair from an error instead of resetting local phase", async () => {
    const onCancel = vi.fn();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockRejectedValueOnce(new Error("setup failed"));

    render(<EnvironmentSetupPanel showWelcome={false} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "下载模型并完成配置" }));

    expect(await screen.findByText("模型配置失败，请重试。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "返回" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not finish setup after the panel unmounts", async () => {
    const setup = createDeferred<{
      runtimeReady: boolean;
      modelReady: boolean;
      shortcut: string;
    }>();
    const onComplete = vi.fn();
    const onSetupSucceeded = vi.fn();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockReturnValueOnce(setup.promise);
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: false,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: true,
      environmentReady: false,
    });
    getModelStatus.mockResolvedValue({
      modelReady: true,
      modelDownloaded: true,
      mmprojDownloaded: true,
      modelPath: "",
      mmprojPath: "",
      modelSize: "1.5 GB",
      sidecarRunning: false,
      llamaServerAvailable: true,
      inferenceBackend: "llama",
      ggufModelVariant: "q4_k_m",
      activeBackend: "llama",
      mlxRuntimeAvailable: false,
      mlxModelId: "",
      mlxModelReady: false,
      mlxRequiresNetwork: false,
    });

    const { unmount } = render(
      <EnvironmentSetupPanel
        onComplete={onComplete}
        onSetupSucceeded={onSetupSucceeded}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "下载模型并完成配置" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("setup_environment"));
    unmount();

    await act(async () => {
      setup.resolve({
        runtimeReady: true,
        modelReady: true,
        shortcut: "Control+Option+Space",
      });
      await setup.promise;
      await Promise.resolve();
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(onSetupSucceeded).not.toHaveBeenCalled();
  });

  it("stops a deferred status refresh when the panel unmounts", async () => {
    const modelStatus = createDeferred<{
      modelReady: boolean;
      modelDownloaded: boolean;
      mmprojDownloaded: boolean;
      modelPath: string;
      mmprojPath: string;
      modelSize: string | null;
      sidecarRunning: boolean;
      llamaServerAvailable: boolean;
      inferenceBackend: "llama";
      ggufModelVariant: "q4_k_m";
      activeBackend: string;
      mlxRuntimeAvailable: boolean;
      mlxModelId: string;
      mlxModelReady: boolean;
      mlxRequiresNetwork: boolean;
    }>();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    getModelStatus.mockReturnValue(modelStatus.promise);

    const { unmount } = render(<EnvironmentSetupPanel />);
    await waitFor(() => expect(getModelStatus).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      modelStatus.resolve({
        modelReady: true,
        modelDownloaded: true,
        mmprojDownloaded: true,
        modelPath: "",
        mmprojPath: "",
        modelSize: "1.5 GB",
        sidecarRunning: false,
        llamaServerAvailable: true,
        inferenceBackend: "llama",
        ggufModelVariant: "q4_k_m",
        activeBackend: "llama",
        mlxRuntimeAvailable: false,
        mlxModelId: "",
        mlxModelReady: false,
        mlxRequiresNetwork: false,
      });
      await modelStatus.promise;
      await Promise.resolve();
    });

    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("shows concise feedback when the initial status refresh fails", async () => {
    vi.mocked(listen).mockResolvedValue(vi.fn());
    getModelStatus.mockRejectedValueOnce(
      new Error("get_model_status IPC rejected at /private/tmp/model.sock"),
    );

    render(<EnvironmentSetupPanel />);

    expect(await screen.findByText("暂时无法读取模型状态，请重试。")).toBeVisible();
    expect(screen.getByRole("button", { name: "下载模型并完成配置" })).toBeEnabled();
    expect(screen.queryByText(/get_model_status|IPC|private\/tmp/)).not.toBeInTheDocument();
  });

  it("marks onboarding complete with an owned settings patch", async () => {
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockResolvedValueOnce({
      runtimeReady: true,
      modelReady: true,
      shortcut: "Control+Option+Space",
    });
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: false,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: true,
      environmentReady: false,
    });
    getModelStatus.mockResolvedValue({
      modelReady: true,
      modelDownloaded: true,
      mmprojDownloaded: true,
      modelPath: "",
      mmprojPath: "",
      modelSize: "1.5 GB",
      sidecarRunning: false,
      llamaServerAvailable: true,
      inferenceBackend: "llama",
      ggufModelVariant: "q4_k_m",
      activeBackend: "llama",
      mlxRuntimeAvailable: false,
      mlxModelId: "",
      mlxModelReady: false,
      mlxRequiresNetwork: false,
    });
    loadSettings.mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    });
    updateSettings.mockResolvedValue({ onboardingComplete: true });

    render(<EnvironmentSetupPanel showWelcome />);
    fireEvent.click(screen.getByRole("button", { name: "下载模型并完成配置" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true }),
    );
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("guards duplicate welcome completion while its checks and write are pending", async () => {
    const environment = createDeferred<{
      onboardingComplete: boolean;
      inferenceBackend: "llama";
      runtimeReady: boolean;
      modelReady: boolean;
      environmentReady: boolean;
    }>();
    const completionSave = createDeferred<{ onboardingComplete: boolean }>();
    const onComplete = vi.fn();
    const readyStatus = {
      modelReady: true,
      modelDownloaded: true,
      mmprojDownloaded: true,
      modelPath: "",
      mmprojPath: "",
      modelSize: "1.5 GB",
      sidecarRunning: false,
      llamaServerAvailable: true,
      inferenceBackend: "llama" as const,
      ggufModelVariant: "q4_k_m" as const,
      activeBackend: "llama",
      mlxRuntimeAvailable: false,
      mlxModelId: "",
      mlxModelReady: false,
      mlxRequiresNetwork: false,
    };
    vi.mocked(listen).mockResolvedValue(vi.fn());
    getModelStatus.mockResolvedValue(readyStatus);
    getEnvironmentStatus.mockReturnValue(environment.promise);
    loadSettings.mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    });
    updateSettings
      .mockResolvedValueOnce({ onboardingComplete: true })
      .mockReturnValueOnce(completionSave.promise);

    render(<EnvironmentSetupPanel showWelcome onComplete={onComplete} />);

    expect(await screen.findByText("配置完成")).toBeVisible();
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    const start = screen.getByRole("button", { name: "开始使用" });
    const workbench = screen.getByRole("button", { name: "打开工作台" });

    fireEvent.click(start);

    expect(start).toBeDisabled();
    expect(workbench).toBeDisabled();
    fireEvent.click(workbench);
    expect(getEnvironmentStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      environment.resolve({
        onboardingComplete: true,
        inferenceBackend: "llama",
        runtimeReady: true,
        modelReady: true,
        environmentReady: true,
      });
      await environment.promise;
    });

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(start).toBeDisabled();
    expect(workbench).toBeDisabled();

    await act(async () => {
      completionSave.resolve({ onboardingComplete: true });
      await completionSave.promise;
    });

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("show_entry");
    expect(getEnvironmentStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps welcome completion retryable after a status failure", async () => {
    const onComplete = vi.fn();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    getModelStatus.mockResolvedValue({
      modelReady: true,
      modelDownloaded: true,
      mmprojDownloaded: true,
      modelPath: "",
      mmprojPath: "",
      modelSize: "1.5 GB",
      sidecarRunning: false,
      llamaServerAvailable: true,
      inferenceBackend: "llama",
      ggufModelVariant: "q4_k_m",
      activeBackend: "llama",
      mlxRuntimeAvailable: false,
      mlxModelId: "",
      mlxModelReady: false,
      mlxRequiresNetwork: false,
    });
    getEnvironmentStatus.mockRejectedValue(
      new Error("environment_status failed at /private/tmp/runtime.sock"),
    );
    loadSettings.mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    });
    updateSettings.mockResolvedValue({ onboardingComplete: true });

    render(<EnvironmentSetupPanel showWelcome onComplete={onComplete} />);
    fireEvent.click(await screen.findByRole("button", { name: "开始使用" }));

    expect(await screen.findByText("暂时无法完成设置，请重试。")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始使用" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "打开工作台" })).toBeEnabled();
    expect(screen.queryByText(/environment_status|private\/tmp|runtime.sock/)).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("ignores a deferred welcome completion after unmount", async () => {
    const environment = createDeferred<{
      runtimeReady: boolean;
      modelReady: boolean;
    }>();
    const onComplete = vi.fn();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    getModelStatus.mockResolvedValue({
      modelReady: true,
      modelDownloaded: true,
      mmprojDownloaded: true,
      modelPath: "",
      mmprojPath: "",
      modelSize: "1.5 GB",
      sidecarRunning: false,
      llamaServerAvailable: true,
      inferenceBackend: "llama",
      ggufModelVariant: "q4_k_m",
      activeBackend: "llama",
      mlxRuntimeAvailable: false,
      mlxModelId: "",
      mlxModelReady: false,
      mlxRequiresNetwork: false,
    });
    getEnvironmentStatus.mockReturnValue(environment.promise);
    loadSettings.mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    });
    updateSettings.mockResolvedValue({ onboardingComplete: true });

    const { unmount } = render(
      <EnvironmentSetupPanel showWelcome onComplete={onComplete} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "开始使用" }));
    await waitFor(() => expect(getEnvironmentStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      environment.resolve({ runtimeReady: true, modelReady: true });
      await environment.promise;
      await Promise.resolve();
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("show_entry");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("reports busy only while a repair attempt is running", async () => {
    const setup = createDeferred<{
      runtimeReady: boolean;
      modelReady: boolean;
      shortcut: string;
    }>();
    const onBusyChange = vi.fn();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockReturnValueOnce(setup.promise);

    render(<EnvironmentSetupPanel onBusyChange={onBusyChange} />);
    fireEvent.click(screen.getByRole("button", { name: "下载模型并完成配置" }));

    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      setup.resolve({
        runtimeReady: false,
        modelReady: false,
        shortcut: "Control+Option+Space",
      });
      await setup.promise;
    });

    await screen.findByText("模型准备未完成，请检查网络后重试。");
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("cleans every late listener from StrictMode repeated mounts", async () => {
    const registrations: Array<(cleanup: () => void) => void> = [];
    const cleanups = Array.from({ length: 4 }, () => vi.fn());
    vi.mocked(listen).mockImplementation(
      () =>
        new Promise((resolve) => {
          registrations.push(resolve);
        }),
    );

    const { unmount } = render(
      <StrictMode>
        <EnvironmentSetupPanel />
      </StrictMode>,
    );

    await waitFor(() => expect(listen).toHaveBeenCalledTimes(4));
    unmount();

    await act(async () => {
      registrations.forEach((resolve, index) => resolve(cleanups[index]));
      await Promise.resolve();
    });

    cleanups.forEach((cleanup) => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it("shows a concise setup message instead of the backend error", async () => {
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(invoke).mockRejectedValueOnce(new Error("sidecar exited with code 127"));

    render(<EnvironmentSetupPanel />);
    fireEvent.click(screen.getByRole("button", { name: "下载模型并完成配置" }));

    expect(await screen.findByText("模型配置失败，请重试。")).toBeInTheDocument();
    expect(screen.queryByText(/sidecar|127/i)).not.toBeInTheDocument();
  });
});
