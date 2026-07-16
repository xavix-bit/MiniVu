import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindowShell } from "../src/app-shell/MainWindowShell";
import { loadSettings } from "../src/settings/settingsStore";

const tokensCss = readFileSync(`${process.cwd()}/src/styles/tokens.css`, "utf8");
const settingsCss = readFileSync(`${process.cwd()}/src/styles/settings.css`, "utf8");
const workbenchCss = readFileSync(`${process.cwd()}/src/styles/workbench.css`, "utf8");

function cssRuleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) =>
        channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const { shellState, settingsPanelState, getEnvironmentStatus } = vi.hoisted(() => ({
  shellState: { mounts: 0, renders: 0 },
  settingsPanelState: { mounts: 0 },
  getEnvironmentStatus: vi.fn(async () => ({
    onboardingComplete: true,
    environmentReady: true,
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../src/model/modelClient", () => ({
  modelClient: {
    getEnvironmentStatus,
  },
}));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn(async () => ({
    onboardingComplete: true,
    shortcut: "Control+Option+Space",
  })),
}));
vi.mock("../src/app-shell/EnvironmentSetupPanel", () => ({
  EnvironmentSetupPanel: ({
    showWelcome,
    onComplete,
    onSetupSucceeded,
    onBusyChange,
  }: {
    showWelcome?: boolean;
    onComplete?: () => void;
    onSetupSucceeded?: () => void;
    onBusyChange?: (busy: boolean) => void;
  }) => (
    <div data-testid="environment-setup" data-welcome={String(Boolean(showWelcome))}>
      <span>初始设置内容</span>
      <button type="button" onClick={onSetupSucceeded}>
        模拟配置成功
      </button>
      <button type="button" onClick={onComplete}>
        模拟完成设置
      </button>
      <button type="button" onClick={() => onBusyChange?.(true)}>
        模拟开始修复
      </button>
      <button type="button" onClick={() => onBusyChange?.(false)}>
        模拟结束修复
      </button>
    </div>
  ),
}));
vi.mock("../src/settings/ModelPanel", () => ({
  ModelPanel: ({
    onRepairRuntime,
    onBusyChange,
    refreshToken,
    disabled,
  }: {
    onRepairRuntime?: () => void;
    onBusyChange?: (busy: boolean) => void;
    refreshToken?: number;
    disabled?: boolean;
  }) => (
    <div
      data-testid="model-panel"
      data-refresh-token={refreshToken}
      data-disabled={String(Boolean(disabled))}
    >
      <span>模型内容</span>
      <button type="button" disabled={disabled} onClick={onRepairRuntime}>
        模拟修复模型组件
      </button>
      <button type="button" onClick={() => onBusyChange?.(true)}>
        模拟开始模型下载
      </button>
      <button type="button" onClick={() => onBusyChange?.(false)}>
        模拟结束模型下载
      </button>
    </div>
  ),
}));
vi.mock("../src/settings/ModelPreferencesPanel", () => ({
  ModelPreferencesPanel: ({
    onSaved,
    onBusyChange,
    disabled,
  }: {
    onSaved?: () => void;
    onBusyChange?: (busy: boolean) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="model-preferences-panel" data-disabled={String(Boolean(disabled))}>
      <span>模型偏好内容</span>
      <button type="button" onClick={onSaved}>
        模拟保存模型偏好
      </button>
      <button type="button" onClick={() => onBusyChange?.(true)}>
        模拟开始偏好保存
      </button>
      <button type="button" onClick={() => onBusyChange?.(false)}>
        模拟结束偏好保存
      </button>
    </div>
  ),
}));
vi.mock("../src/settings/SettingsPanel", async () => {
  const React = await import("react");
  return {
    SettingsPanel: ({ view }: { view: "general" | "shortcut" }) => {
      React.useEffect(() => {
        settingsPanelState.mounts += 1;
      }, []);
      return (
        <div data-testid="settings-panel" data-view={view}>
          <span>偏好设置内容</span>
          <span>{view === "general" ? "自动保留" : "全局快捷键"}</span>
        </div>
      );
    },
  };
});
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
    vi.clearAllMocks();
    shellState.mounts = 0;
    shellState.renders = 0;
    settingsPanelState.mounts = 0;
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: true,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
  });

  it("keeps first-run setup active without hidden model tasks until completion", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);

    render(<MainWindowShell />);

    const setup = await screen.findByTestId("environment-setup");
    expect(setup).toHaveAttribute("data-welcome", "true");
    expect(screen.queryByTestId("model-panel")).not.toBeInTheDocument();

    fireEvent.click(within(setup).getByRole("button", { name: "模拟完成设置" }));

    await waitFor(() => expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument());
    expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("model-panel")).toBeInTheDocument();
  });

  it("keeps one SettingsPanel identity while isolating general and shortcut tasks", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsNav = screen.getByRole("navigation", { name: "设置导航" });
    const panel = await screen.findByTestId("settings-panel");
    expect(panel).toHaveAttribute("data-view", "general");
    expect(screen.getByText("自动保留")).toBeVisible();
    expect(screen.queryByText("全局快捷键")).not.toBeInTheDocument();

    fireEvent.click(within(settingsNav).getByRole("button", { name: "快捷键" }));
    expect(screen.getByTestId("settings-panel")).toBe(panel);
    expect(panel).toHaveAttribute("data-view", "shortcut");
    expect(screen.getByText("全局快捷键")).toBeVisible();
    expect(screen.queryByText("自动保留")).not.toBeInTheDocument();

    fireEvent.click(within(settingsNav).getByRole("button", { name: "通用" }));
    expect(screen.getByTestId("settings-panel")).toBe(panel);
    expect(panel).toHaveAttribute("data-view", "general");
    expect(settingsPanelState.mounts).toBe(1);
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

  it("composes model tasks as siblings and expands repair inline", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");
    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsNav = screen.getByRole("navigation", { name: "设置导航" });
    expect(within(settingsNav).queryByRole("button", { name: "初始设置" })).not.toBeInTheDocument();
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));

    const preferences = await screen.findByTestId("model-preferences-panel");
    const model = screen.getByTestId("model-panel");
    expect(preferences.parentElement).toBe(model.parentElement);
    expect(preferences.parentElement).toHaveClass("unified-settings-surface");
    expect(model).toHaveAttribute("data-refresh-token", "0");

    fireEvent.click(within(preferences).getByRole("button", { name: "模拟保存模型偏好" }));
    await waitFor(() => expect(model).toHaveAttribute("data-refresh-token", "1"));

    fireEvent.click(within(model).getByRole("button", { name: "模拟修复模型组件" }));
    const modelView = model.closest(".settings-page-view") as HTMLElement;
    const repair = await within(modelView).findByTestId("environment-setup");
    expect(repair.parentElement).toBe(model.parentElement);

    fireEvent.click(within(repair).getByRole("button", { name: "模拟配置成功" }));
    await waitFor(() =>
      expect(within(modelView).queryByTestId("environment-setup")).not.toBeInTheDocument(),
    );
    expect(model).toHaveAttribute("data-refresh-token", "2");
    expect(getEnvironmentStatus).toHaveBeenCalledTimes(1);
  });

  it("disables both model surfaces while inline repair is running", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsNav = screen.getByRole("navigation", { name: "设置导航" });
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));

    const preferences = await screen.findByTestId("model-preferences-panel");
    const model = screen.getByTestId("model-panel");
    fireEvent.click(within(model).getByRole("button", { name: "模拟修复模型组件" }));
    const repair = await screen.findByTestId("environment-setup");

    fireEvent.click(within(repair).getByRole("button", { name: "模拟开始修复" }));
    expect(preferences).toHaveAttribute("data-disabled", "true");
    expect(model).toHaveAttribute("data-disabled", "true");

    fireEvent.click(within(repair).getByRole("button", { name: "模拟结束修复" }));
    expect(preferences).toHaveAttribute("data-disabled", "false");
    expect(model).toHaveAttribute("data-disabled", "false");
  });

  it("blocks repair and both model surfaces while a sibling model operation is pending", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsNav = screen.getByRole("navigation", { name: "设置导航" });
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));

    const preferences = await screen.findByTestId("model-preferences-panel");
    const model = screen.getByTestId("model-panel");
    const repairButton = within(model).getByRole("button", { name: "模拟修复模型组件" });

    fireEvent.click(within(preferences).getByRole("button", { name: "模拟开始偏好保存" }));

    await waitFor(() => expect(preferences).toHaveAttribute("data-disabled", "true"));
    expect(model).toHaveAttribute("data-disabled", "true");
    expect(repairButton).toBeDisabled();
    fireEvent.click(repairButton);
    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();

    fireEvent.click(within(preferences).getByRole("button", { name: "模拟结束偏好保存" }));

    await waitFor(() => expect(repairButton).toBeEnabled());
    expect(preferences).toHaveAttribute("data-disabled", "false");
    expect(model).toHaveAttribute("data-disabled", "false");
    fireEvent.click(repairButton);
    expect(await screen.findByTestId("environment-setup")).toBeVisible();
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

  it("inherits unified semantic surfaces from the dark theme", async () => {
    document.documentElement.setAttribute("data-theme", "dark");

    try {
      const { container } = render(<MainWindowShell />);
      await screen.findByTestId("workbench-instance");
      const shell = container.querySelector(".unified-app-shell") as HTMLElement;

      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
      expect(shell).toBeInTheDocument();
      expect(tokensCss).toMatch(/\[data-theme="dark"\][\s\S]*--bg-app:\s*#181b20/);
      expect(workbenchCss).toMatch(/\.unified-app-shell\s*{[\s\S]*?--wb-bg:\s*var\(--bg-app\)/);
      expect(settingsCss).not.toMatch(
        /\.unified-app-shell \.settings-app\s*{[^}]*--background:/,
      );
    } finally {
      document.documentElement.removeAttribute("data-theme");
    }
  });

  it("scopes the compact settings surface and control sizing", () => {
    expect(settingsCss).toMatch(
      /\.unified-settings-detail\s*{[^}]*width:\s*min\(100%,\s*760px\)/,
    );
    expect(settingsCss).toMatch(
      /\.unified-settings-detail \.unified-settings-surface\s*{[^}]*border-radius:\s*8px[^}]*background:\s*var\(--wb-panel\)/,
    );
    expect(settingsCss).toMatch(
      /\.page-header\.page-header--compact\s*{[^}]*background:\s*transparent/,
    );
    expect(settingsCss).toMatch(
      /\.unified-settings-detail \.settings-field input:not\(\[type="checkbox"\]\),[\s\S]*?min-height:\s*40px/,
    );
    expect(settingsCss).toMatch(
      /\.unified-settings-detail :is\(\.settings-btn, \.shortcut-recorder__btn, \.callout__action\)\s*{[^}]*min-height:\s*44px/,
    );
  });

  it("retokenizes every inline setup state after the legacy light rules", () => {
    const foregroundRules = [
      [".unified-settings-detail .setup-panel__metrics span", "var(--wb-muted)"],
      [".unified-settings-detail .setup-panel__metrics strong", "var(--wb-text)"],
      [".unified-settings-detail .setup-panel__metrics strong.is-positive", "var(--wb-accent)"],
      [".unified-settings-detail .onboarding-overall-progress__label", "var(--wb-muted)"],
      [".unified-settings-detail .onboarding-overall-progress__speed", "var(--wb-accent)"],
      [".unified-settings-detail .onboarding-progress-item strong", "var(--wb-text)"],
      [".unified-settings-detail .onboarding-progress-item p", "var(--wb-muted)"],
      [".unified-settings-detail .onboarding-progress-item__percent", "var(--wb-muted)"],
      [".unified-settings-detail .onboarding-progress-item__speed", "var(--wb-accent)"],
      [".unified-settings-detail .setup-panel__running-hint", "var(--wb-muted)"],
      [".unified-settings-detail .setup-panel__success-lead", "var(--wb-accent)"],
      [".unified-settings-detail .setup-panel__success .onboarding-checklist li", "var(--wb-muted)"],
      [".unified-settings-detail .setup-panel__success .onboarding-checklist li.is-done", "var(--wb-text)"],
      [".unified-settings-detail .onboarding-error", "var(--danger-text)"],
    ] as const;

    for (const [selector, token] of foregroundRules) {
      const body = cssRuleBody(settingsCss, selector);
      expect(body, `missing exact selector ${selector}`).not.toBe("");
      expect(body).toContain(`color: ${token}`);
      expect(body).not.toMatch(/color:\s*#[0-9a-f]{3,8}/i);
    }

    expect(settingsCss.lastIndexOf(foregroundRules[0][0])).toBeGreaterThan(
      settingsCss.indexOf(".setup-panel__metrics span"),
    );
    expect(cssRuleBody(settingsCss, ".unified-settings-detail .onboarding-error")).toContain(
      "background: var(--danger-soft)",
    );

    for (const foreground of ["#f5f5f7", "#a1a1a6", "#7894ff", "#ff6961"]) {
      expect(contrastRatio(foreground, "#2a2a2c")).toBeGreaterThanOrEqual(4.5);
      expect(tokensCss).toContain(foreground);
    }
  });
});
