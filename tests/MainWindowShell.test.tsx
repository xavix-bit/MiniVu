import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const MockWorkbenchShell = React.memo(({ scope }: { scope: "recent" | "pinned" }) => {
    shellState.renders += 1;
    React.useEffect(() => {
      shellState.mounts += 1;
    }, []);
    return (
      <div data-testid="workbench-instance" data-scope={scope} />
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

  it("keeps one permanent rail and workbench instance while switching surfaces", async () => {
    render(<MainWindowShell />);

    const workbench = await screen.findByTestId("workbench-instance");
    const workbenchSurface = workbench.closest(".main-surface") as HTMLElement;
    const rail = screen.getByRole("navigation", { name: "应用导航" });
    await waitFor(() => expect(shellState.mounts).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("偏好设置内容")).toBeVisible();
    expect(screen.getByRole("navigation", { name: "应用导航" })).toBe(rail);
    expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("aria-current", "page");
    expect(workbench.isConnected).toBe(true);
    expect(workbenchSurface).toHaveAttribute("aria-hidden", "true");
    expect(workbenchSurface).toHaveAttribute("inert");
    expect(screen.getByRole("main")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    await waitFor(() => expect(screen.getByTestId("workbench-instance")).toBeVisible());
    expect(screen.getByTestId("workbench-instance")).toBe(workbench);
    expect(screen.getByRole("navigation", { name: "应用导航" })).toBe(rail);
    expect(workbenchSurface).not.toHaveAttribute("inert");
    expect(workbenchSurface).toHaveFocus();
    expect(shellState.mounts).toBe(1);
  });

  it("isolates settings section updates from workbench renders and only rerenders for scope", async () => {
    render(<MainWindowShell />);

    const workbench = await screen.findByTestId("workbench-instance");
    await waitFor(() => expect(shellState.renders).toBeGreaterThan(0));
    const initialRenders = shellState.renders;

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsMain = screen.getByRole("main");
    const settingsNav = screen.getByRole("navigation", { name: "设置导航" });
    expect(settingsMain).toHaveFocus();
    expect(within(settingsNav).queryByRole("button", { name: "初始设置" })).not.toBeInTheDocument();

    const preferences = await screen.findByText("偏好设置内容");
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));
    expect(await screen.findByText("模型内容")).toBeVisible();
    expect(within(settingsNav).getByRole("button", { name: "模型" })).toHaveAttribute("aria-current", "page");
    expect(preferences.isConnected).toBe(true);
    expect(preferences.closest(".settings-page-view")).toHaveAttribute("inert");
    expect(settingsMain).toHaveFocus();
    expect(shellState.renders).toBe(initialRenders);

    fireEvent.click(within(settingsNav).getByRole("button", { name: "快捷键" }));
    expect(within(settingsNav).getByRole("button", { name: "快捷键" })).toHaveAttribute("aria-current", "page");
    expect(shellState.renders).toBe(initialRenders);

    fireEvent.click(screen.getByRole("button", { name: "固定" }));
    await waitFor(() => expect(workbench).toHaveAttribute("data-scope", "pinned"));
    expect(workbench.closest(".main-surface")).not.toHaveAttribute("inert");
    expect(workbench.closest(".main-surface")).toHaveFocus();
    expect(shellState.renders).toBe(initialRenders + 1);
    expect(shellState.mounts).toBe(1);
  });

  it("restores each settings section scroll position across mode changes", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsMain = screen.getByRole("main");
    const settingsNav = screen.getByRole("navigation", { name: "设置导航" });
    settingsMain.scrollTop = 180;

    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));
    expect(settingsMain.scrollTop).toBe(0);
    settingsMain.scrollTop = 40;

    fireEvent.click(screen.getByRole("button", { name: "固定" }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(settingsMain.scrollTop).toBe(180);

    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));
    expect(settingsMain.scrollTop).toBe(40);
  });
});
