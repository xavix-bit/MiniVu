import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentSetupPanel } from "../src/app-shell/EnvironmentSetupPanel";
import type { ModelStatusResponse } from "../src/model/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const modelOnlyStatus: ModelStatusResponse = {
  modelReady: true,
  modelDownloaded: true,
  mmprojDownloaded: true,
  modelPath: "/models/q4.gguf",
  mmprojPath: "/models/mmproj.gguf",
  modelSize: "1.5 GB",
  sidecarRunning: false,
  llamaServerAvailable: false,
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

const environmentWithoutRuntime = {
  onboardingComplete: false,
  inferenceBackend: "llama" as const,
  runtimeReady: false,
  modelReady: true,
  environmentReady: false,
};

beforeEach(() => {
  invokeMock.mockImplementation(async (command) => {
    if (command === "get_model_status") return structuredClone(modelOnlyStatus);
    if (command === "get_environment_status") return structuredClone(environmentWithoutRuntime);
    if (command === "load_app_settings") {
      return { onboardingComplete: false, shortcut: "Control+Option+Space" };
    }
    if (command === "setup_environment") {
      return { runtimeReady: false, modelReady: true, shortcut: "Control+Option+Space" };
    }
    return undefined;
  });
  listenMock.mockResolvedValue(vi.fn());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EnvironmentSetupPanel", () => {
  it("persists onboarding after setup is technically ready, then waits for final readiness", async () => {
    const onSetupSucceeded = vi.fn();
    const environmentStatuses = [
      environmentWithoutRuntime,
      {
        ...environmentWithoutRuntime,
        runtimeReady: true,
        modelReady: true,
      },
      {
        ...environmentWithoutRuntime,
        onboardingComplete: true,
        runtimeReady: true,
        modelReady: true,
        environmentReady: true,
      },
    ];
    let environmentStatusIndex = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(modelOnlyStatus);
      if (command === "get_environment_status") {
        return structuredClone(environmentStatuses[environmentStatusIndex++]);
      }
      if (command === "load_app_settings") {
        return { onboardingComplete: false, shortcut: "Control+Option+Space" };
      }
      if (command === "setup_environment") {
        return { runtimeReady: true, modelReady: true, shortcut: "Control+Option+Space" };
      }
      return undefined;
    });
    render(<EnvironmentSetupPanel showWelcome onSetupSucceeded={onSetupSucceeded} />);

    await waitFor(() => expect(environmentStatusIndex).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: /开始设置/ }));

    await waitFor(() => expect(onSetupSucceeded).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("save_app_settings", {
      settings: expect.objectContaining({ onboardingComplete: true }),
      intent: "general",
    });
    expect(environmentStatusIndex).toBe(3);
    expect(screen.getByText("配置完成")).toBeInTheDocument();

    const commands = invokeMock.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command === "save_app_settings")).toHaveLength(1);
    const saveIndex = commands.indexOf("save_app_settings");
    const environmentStatusIndexes = commands.reduce<number[]>((indexes, command, index) => {
      if (command === "get_environment_status") indexes.push(index);
      return indexes;
    }, []);
    expect(saveIndex).toBeGreaterThan(environmentStatusIndexes[1]);
    expect(saveIndex).toBeLessThan(environmentStatusIndexes[2]);
  });

  it("does not auto-complete onboarding when only the model is ready", async () => {
    const onSetupSucceeded = vi.fn();
    render(<EnvironmentSetupPanel showWelcome onSetupSucceeded={onSetupSucceeded} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_environment_status"));

    expect(screen.queryByText("配置完成")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("save_app_settings", expect.anything());
    expect(onSetupSucceeded).not.toHaveBeenCalled();
  });

  it("does not complete or persist after setup when runtime is still missing", async () => {
    const onSetupSucceeded = vi.fn();
    render(<EnvironmentSetupPanel showWelcome onSetupSucceeded={onSetupSucceeded} />);

    fireEvent.click(await screen.findByRole("button", { name: /开始设置/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("setup_environment"));
    await screen.findByText("准备未完成，请重试。仍有问题时，请重新启动应用。");

    expect(screen.queryByText("配置完成")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("save_app_settings", expect.anything());
    expect(onSetupSucceeded).not.toHaveBeenCalled();
  });

  it("uses fixed user-facing stages and never renders backend progress messages", async () => {
    let setupProgressHandler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(modelOnlyStatus);
      if (command === "get_environment_status") return structuredClone(environmentWithoutRuntime);
      if (command === "setup_environment") return new Promise(() => undefined);
      return undefined;
    });
    listenMock.mockImplementation(async (event, handler) => {
      if (event === "setup-progress") {
        setupProgressHandler = handler as typeof setupProgressHandler;
      }
      return vi.fn();
    });
    render(<EnvironmentSetupPanel showWelcome />);

    fireEvent.click(await screen.findByRole("button", { name: /开始设置/ }));
    act(() => setupProgressHandler?.({ payload: {
      phase: "runtime",
      status: "running",
      message: "sidecar failed on http://127.0.0.1:4321 at /Users/private/runtime",
      percent: 42,
    } }));

    for (const label of ["设备检查", "应用组件", "图片理解", "快捷键"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/sidecar|127\.0\.0\.1|\/Users\/private|runtime/i)).not.toBeInTheDocument();
  });

  it("maps setup failures to a retryable message without leaking error details", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(modelOnlyStatus);
      if (command === "get_environment_status") return structuredClone(environmentWithoutRuntime);
      if (command === "setup_environment") throw new Error("HTTP 500 stderr task id 91 /Users/private/model.gguf");
      return undefined;
    });
    render(<EnvironmentSetupPanel showWelcome />);

    fireEvent.click(await screen.findByRole("button", { name: /开始设置/ }));

    expect(await screen.findByText("设置未完成，请检查网络和可用空间后重试。")).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500|stderr|task id|\/Users\/private/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("runs setup again and clears the previous error when retry is clicked", async () => {
    let setupCalls = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === "get_model_status") return structuredClone(modelOnlyStatus);
      if (command === "get_environment_status") return structuredClone(environmentWithoutRuntime);
      if (command === "setup_environment") {
        setupCalls += 1;
        if (setupCalls === 1) throw new Error("network failed");
        return new Promise(() => undefined);
      }
      return undefined;
    });
    render(<EnvironmentSetupPanel showWelcome />);

    fireEvent.click(await screen.findByRole("button", { name: /开始设置/ }));
    await screen.findByText("设置未完成，请检查网络和可用空间后重试。");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(setupCalls).toBe(2));
    expect(screen.queryByText("设置未完成，请检查网络和可用空间后重试。")).not.toBeInTheDocument();
    expect(screen.getByText("下载中…")).toBeInTheDocument();
  });
});
