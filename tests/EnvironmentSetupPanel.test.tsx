import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentSetupPanel } from "../src/app-shell/EnvironmentSetupPanel";

const { getEnvironmentStatus, getModelStatus } = vi.hoisted(() => ({
  getEnvironmentStatus: vi.fn(),
  getModelStatus: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/model/modelClient", () => ({
  modelClient: { getEnvironmentStatus, getModelStatus },
}));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

describe("EnvironmentSetupPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
