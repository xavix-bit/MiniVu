import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindowShell } from "../src/app-shell/MainWindowShell";

const { shellState } = vi.hoisted(() => ({
  shellState: { mounts: 0, renders: 0 },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../src/model/modelClient", () => ({
  modelClient: {
    getEnvironmentStatus: vi.fn(async () => ({ environmentReady: true })),
  },
}));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn(async () => ({
    onboardingComplete: true,
    shortcut: "Control+Option+Space",
  })),
}));
vi.mock("../src/app-shell/EnvironmentSetupPanel", () => ({
  EnvironmentSetupPanel: () => <div>初始设置内容</div>,
}));
vi.mock("../src/settings/ModelPanel", () => ({
  ModelPanel: () => <div>模型内容</div>,
}));
vi.mock("../src/settings/SettingsPanel", () => ({
  SettingsPanel: () => <div>偏好设置内容</div>,
}));
vi.mock("../src/privacy/PrivacyNotice", () => ({
  PrivacyNotice: () => <div>隐私内容</div>,
}));
vi.mock("../src/workbench/WorkbenchShell", async () => {
  const React = await import("react");
  const MockWorkbenchShell = React.memo(({ onOpenSettings }: { onOpenSettings: () => void }) => {
    shellState.renders += 1;
    React.useEffect(() => {
      shellState.mounts += 1;
    }, []);
    return (
      <div data-testid="workbench-instance">
        <button type="button" onClick={onOpenSettings}>打开偏好设置</button>
      </div>
    );
  });
  return {
    WorkbenchShell: MockWorkbenchShell,
  };
});

describe("MainWindowShell navigation", () => {
  beforeEach(() => {
    shellState.mounts = 0;
    shellState.renders = 0;
  });

  it("keeps the workbench mounted while visiting settings", async () => {
    render(<MainWindowShell />);

    const workbench = await screen.findByTestId("workbench-instance");
    const workbenchSurface = workbench.closest(".main-surface") as HTMLElement;
    await waitFor(() => expect(shellState.mounts).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "打开偏好设置" }));
    expect(await screen.findByText("偏好设置内容")).toBeVisible();
    expect(workbench.isConnected).toBe(true);
    expect(workbenchSurface).toHaveAttribute("aria-hidden", "true");
    expect(workbenchSurface).toHaveAttribute("inert");
    expect(screen.getByRole("main")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "工作台" }));
    await waitFor(() => expect(screen.getByTestId("workbench-instance")).toBeVisible());
    expect(screen.getByTestId("workbench-instance")).toBe(workbench);
    expect(workbenchSurface).not.toHaveAttribute("inert");
    expect(workbenchSurface).toHaveFocus();
    expect(shellState.mounts).toBe(1);
    expect(shellState.renders).toBe(1);
  });
});
