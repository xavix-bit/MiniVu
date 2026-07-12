import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: /下载均衡模型并完成配置/ }));

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

    fireEvent.click(await screen.findByRole("button", { name: /下载均衡模型并完成配置/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("setup_environment"));
    await screen.findByText("运行环境或模型尚未就绪。");

    expect(screen.queryByText("配置完成")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("save_app_settings", expect.anything());
    expect(onSetupSucceeded).not.toHaveBeenCalled();
  });
});
