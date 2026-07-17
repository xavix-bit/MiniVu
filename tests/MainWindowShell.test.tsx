import { readFileSync } from "node:fs";
import { listen } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindowShell } from "../src/app-shell/MainWindowShell";
import { captureClient } from "../src/captures/captureClient";
import { processCaptureInBackground } from "../src/captures/processCapture";
import {
  CaptureError,
  captureScreenRegion,
  openScreenRecordingSettings,
} from "../src/image/captureScreen";
import { loadSettings, updateSettings } from "../src/settings/settingsStore";

const tokensCss = readFileSync(`${process.cwd()}/src/styles/tokens.css`, "utf8");
const settingsCss = readFileSync(`${process.cwd()}/src/styles/settings.css`, "utf8");
const workbenchCss = readFileSync(`${process.cwd()}/src/styles/workbench.css`, "utf8");
const stylesEntry = readFileSync(`${process.cwd()}/src/styles.css`, "utf8");

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openSettings() {
  const settingsButton = screen.getByRole("button", { name: "设置" });
  await waitFor(() => expect(settingsButton).toBeEnabled());
  fireEvent.click(settingsButton);
  return screen.findByRole("navigation", { name: "设置导航" });
}

const { shellState, settingsPanelState, getEnvironmentStatus, mainEventHandlers } = vi.hoisted(() => ({
  shellState: { mounts: 0, renders: 0 },
  settingsPanelState: { mounts: 0 },
  mainEventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  getEnvironmentStatus: vi.fn(async () => ({
    onboardingComplete: true,
    inferenceBackend: "llama" as const,
    runtimeReady: true,
    modelReady: true,
    environmentReady: true,
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    mainEventHandlers.set(name, callback);
    return () => mainEventHandlers.delete(name);
  }),
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
  updateSettings: vi.fn(),
}));
vi.mock("../src/image/captureScreen", async () => {
  const actual = await vi.importActual<typeof import("../src/image/captureScreen")>(
    "../src/image/captureScreen",
  );
  return {
    ...actual,
    captureScreenRegion: vi.fn(),
    openScreenRecordingSettings: vi.fn(),
  };
});
vi.mock("../src/captures/captureClient", () => ({
  captureClient: { create: vi.fn() },
}));
vi.mock("../src/captures/processCapture", () => ({
  processCaptureInBackground: vi.fn(),
}));
vi.mock("../src/app-shell/EnvironmentSetupPanel", () => ({
  EnvironmentSetupPanel: ({
    showWelcome,
    onComplete,
    onSetupSucceeded,
    onBusyChange,
    onCancel,
  }: {
    showWelcome?: boolean;
    onComplete?: () => void;
    onSetupSucceeded?: () => void;
    onBusyChange?: (busy: boolean) => void;
    onCancel?: () => void;
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
      {onCancel ? (
        <button type="button" onClick={onCancel}>
          模拟关闭修复
        </button>
      ) : null}
    </div>
  ),
}));
vi.mock("../src/settings/ModelPanel", () => ({
  ModelPanel: ({
    onRepairRuntime,
    onBusyChange,
    onStatusChange,
    refreshToken,
    disabled,
  }: {
    onRepairRuntime?: () => void;
    onBusyChange?: (busy: boolean) => void;
    onStatusChange?: (status: { modelReady: boolean }) => void;
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
      <button type="button" disabled={disabled} onClick={() => onBusyChange?.(true)}>
        模拟开始模型下载
      </button>
      <button type="button" onClick={() => onBusyChange?.(false)}>
        模拟结束模型下载
      </button>
      <button type="button" onClick={() => onStatusChange?.({ modelReady: true })}>
        模拟模型就绪
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
      <button type="button" disabled={disabled} onClick={onSaved}>
        模拟保存模型偏好
      </button>
      <button type="button" disabled={disabled} onClick={() => onBusyChange?.(true)}>
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
  const MockWorkbenchShell = React.memo(({
    scope,
    requestedRecordId,
    requestedDraft,
    onCapture,
    modelReady,
    onRequireModel,
    showTips,
    onTipsComplete,
  }: {
    scope: "recent" | "pinned";
    requestedRecordId?: string | null;
    requestedDraft?: { recordId: string; prompt: string } | null;
    onCapture?: () => void;
    modelReady?: boolean;
    onRequireModel?: (context: { recordId: string; prompt: string }) => void | Promise<boolean>;
    showTips?: boolean;
    onTipsComplete?: () => void;
  }) => {
    const [draft, setDraft] = React.useState("");
    shellState.renders += 1;
    React.useEffect(() => {
      shellState.mounts += 1;
    }, []);
    React.useEffect(() => {
      if (requestedDraft) setDraft(requestedDraft.prompt);
    }, [requestedDraft]);
    return (
      <div
        data-testid="workbench-instance"
        data-scope={scope}
        data-requested-record-id={requestedRecordId ?? ""}
        data-model-ready={String(Boolean(modelReady))}
        data-show-tips={String(Boolean(showTips))}
      >
        <button type="button" onClick={onCapture}>工作台截图</button>
        <input
          aria-label="模拟问题"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="button"
          onClick={() => void onRequireModel?.({ recordId: "one", prompt: draft })}
        >
          模拟需要模型
        </button>
        {showTips ? (
          <button type="button" onClick={onTipsComplete}>模拟完成提示</button>
        ) : null}
      </div>
    );
  });
  return {
    WorkbenchShell: MockWorkbenchShell,
  };
});

describe("MainWindowShell navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainEventHandlers.clear();
    shellState.mounts = 0;
    shellState.renders = 0;
    settingsPanelState.mounts = 0;
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: true,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(updateSettings).mockResolvedValue({
      onboardingComplete: true,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof updateSettings>>);
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: true,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: true,
      environmentReady: true,
    });
  });

  it("shows no welcome or setup surface while settings are loading", async () => {
    const settingsLoad = deferred<Awaited<ReturnType<typeof loadSettings>>>();
    vi.mocked(loadSettings).mockReturnValue(settingsLoad.promise);

    render(<MainWindowShell />);

    const rail = screen.getByRole("navigation", { name: "应用导航" });
    expect(screen.queryByRole("heading", { name: "从一张截图开始" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();
    for (const button of within(rail).getAllByRole("button")) {
      expect(button).toBeDisabled();
      expect(button).not.toHaveAttribute("aria-current");
    }
    expect(screen.getByTestId("workbench-instance").closest(".main-surface")).toHaveAttribute("inert");

    await act(async () => settingsLoad.resolve({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>));

    expect(await screen.findByRole("heading", { name: "从一张截图开始" })).toBeVisible();
    expect(screen.getByLabelText("快捷键 Control+Option+Space")).toHaveTextContent("⌃⌥Space");
    expect(screen.queryByTestId("model-panel")).not.toBeInTheDocument();
    expect(getEnvironmentStatus).not.toHaveBeenCalled();
  });

  it("shows the startup surface before enabling navigation motion", async () => {
    const settingsLoad = deferred<Awaited<ReturnType<typeof loadSettings>>>();
    vi.mocked(loadSettings).mockReturnValue(settingsLoad.promise);

    const { container } = render(<MainWindowShell />);
    const surfaceStack = container.querySelector(".main-surface-stack");

    expect(surfaceStack).not.toHaveClass("is-motion-ready");

    await act(async () => settingsLoad.resolve({
      onboardingComplete: true,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>));

    await waitFor(() => expect(surfaceStack).toHaveClass("is-motion-ready"));
    expect(screen.getByTestId("workbench-instance").closest(".main-surface")).toHaveClass(
      "is-active",
    );
  });

  it("cleans up an event subscription that finishes registering after unmount", async () => {
    const registration = deferred<() => void>();
    const cleanup = vi.fn();
    const settingsLoad = deferred<Awaited<ReturnType<typeof loadSettings>>>();
    vi.mocked(listen).mockReturnValueOnce(registration.promise);
    vi.mocked(loadSettings).mockReturnValue(settingsLoad.promise);

    const view = render(<MainWindowShell />);
    view.unmount();

    await act(async () => registration.resolve(cleanup));

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps a settings load failure separate from first run and retries it", async () => {
    vi.mocked(loadSettings)
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockResolvedValueOnce({
        onboardingComplete: true,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>);

    render(<MainWindowShell />);

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法载入设置。");
    expect(screen.queryByRole("heading", { name: "从一张截图开始" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "设置" })).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
    });
    expect(loadSettings).toHaveBeenCalledTimes(2);
  });

  it("takes an existing user straight to the workbench without waiting for model status", async () => {
    const modelStatus = deferred<Awaited<ReturnType<typeof getEnvironmentStatus>>>();
    getEnvironmentStatus.mockReturnValue(modelStatus.promise);
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: true,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);

    render(<MainWindowShell />);

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
    });
    expect(screen.queryByRole("heading", { name: "从一张截图开始" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();
    expect(getEnvironmentStatus).toHaveBeenCalledOnce();

    await act(async () => modelStatus.resolve({
      onboardingComplete: true,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: true,
      environmentReady: true,
    }));
    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance")).toHaveAttribute("data-model-ready", "true");
    });
  });

  it("shows a useful notice when a workbench capture needs screen-recording permission", async () => {
    const settingsOpen = deferred<void>();
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("permission-denied"));
    vi.mocked(openScreenRecordingSettings).mockReturnValue(settingsOpen.promise);

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "工作台截图" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "需要屏幕录制权限。授权后重新打开 MiniVu。",
    );
    expect(captureClient.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "打开系统设置" }));
    expect(openScreenRecordingSettings).toHaveBeenCalledOnce();

    await act(async () => settingsOpen.reject(new Error("open failed at /private/tmp")));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "系统设置没有打开，请手动打开后重试。",
      ),
    );
    expect(screen.queryByText(/private|tmp|open failed/i)).not.toBeInTheDocument();
  });

  it("shows the same actionable recovery after a quick-panel capture fails", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");
    await waitFor(() => expect(mainEventHandlers.has("capture-recovery")).toBe(true));

    act(() => {
      mainEventHandlers.get("capture-recovery")?.({
        payload: { code: "permission-denied" },
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "需要屏幕录制权限。授权后重新打开 MiniVu。",
    );
    expect(screen.getByRole("button", { name: "打开系统设置" })).toBeVisible();
    expect(screen.getByTestId("workbench-instance")).toHaveAttribute("data-scope", "recent");
  });

  it("keeps a cancelled workbench capture silent", async () => {
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("cancelled"));

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "工作台截图" }));

    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledOnce());
    expect(screen.queryByText("截图没有保存，请重试。")).not.toBeInTheDocument();
    expect(captureClient.create).not.toHaveBeenCalled();
  });

  it("selects and processes a new workbench capture", async () => {
    const image = { name: "workbench.png", dataUrl: "data:image/png;base64,WORKBENCH" };
    const created = {
      id: "workbench-record",
      source: "capture",
      title: null,
      ocrText: "",
      ocrState: "pending",
      messages: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      expiresAtMs: 2,
      pinned: false,
    } as const;
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: true,
        workbenchTipsComplete: true,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockResolvedValueOnce({
        onboardingComplete: true,
        workbenchTipsComplete: true,
        shortcut: "Control+Option+Space",
        captureRetention: "7d",
        backgroundWarmup: true,
      } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockResolvedValue(image);
    vi.mocked(captureClient.create).mockResolvedValue(created);

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "工作台截图" }));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance")).toHaveAttribute(
        "data-requested-record-id",
        created.id,
      );
    });
    expect(captureClient.create).toHaveBeenCalledWith({
      dataUrl: image.dataUrl,
      source: "capture",
      retention: "7d",
    });
    expect(processCaptureInBackground).toHaveBeenCalledWith(created.id, image.dataUrl, {
      warmup: true,
    });
    expect(screen.getByTestId("workbench-instance")).toHaveAttribute("data-show-tips", "false");
  });

  it("shows tips only after a new capture and persists their completion", async () => {
    const image = { name: "tips.png", dataUrl: "data:image/png;base64,TIPS" };
    const created = {
      id: "tips-record",
      source: "capture",
      title: null,
      ocrText: "",
      ocrState: "pending",
      messages: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      expiresAtMs: 2,
      pinned: false,
    } as const;
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: true,
        workbenchTipsComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockResolvedValueOnce({
        onboardingComplete: true,
        workbenchTipsComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockResolvedValue(image);
    vi.mocked(captureClient.create).mockResolvedValue(created);

    render(<MainWindowShell />);
    const workbench = await screen.findByTestId("workbench-instance");
    expect(workbench).toHaveAttribute("data-show-tips", "false");

    fireEvent.click(screen.getByRole("button", { name: "工作台截图" }));
    await waitFor(() => expect(workbench).toHaveAttribute("data-show-tips", "true"));
    fireEvent.click(screen.getByRole("button", { name: "模拟完成提示" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      workbenchTipsComplete: true,
    }));
    expect(workbench).toHaveAttribute("data-show-tips", "false");
  });

  it("returns to the original screenshot and draft after installing a required model", async () => {
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: true,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: false,
      environmentReady: false,
    });

    render(<MainWindowShell />);
    const draft = await screen.findByRole("textbox", { name: "模拟问题" });
    fireEvent.change(draft, { target: { value: "解释这个错误" } });
    fireEvent.click(screen.getByRole("button", { name: "模拟需要模型" }));

    const settingsNav = await screen.findByRole("navigation", { name: "设置导航" });
    await waitFor(() => {
      expect(within(settingsNav).getByRole("button", { name: "模型" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
    expect(screen.getByTestId("workbench-instance").closest(".main-surface")).toHaveAttribute("inert");
    expect(draft).toHaveValue("解释这个错误");

    fireEvent.click(screen.getByRole("button", { name: "模拟模型就绪" }));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
      expect(screen.getByTestId("workbench-instance")).toHaveAttribute(
        "data-requested-record-id",
        "one",
      );
    });
    expect(draft).toHaveValue("解释这个错误");
  });

  it("does not restore an older draft after a delayed model check", async () => {
    const missing = {
      onboardingComplete: true,
      inferenceBackend: "llama" as const,
      runtimeReady: true,
      modelReady: false,
      environmentReady: false,
    };
    const readiness = deferred<typeof missing>();
    getEnvironmentStatus
      .mockResolvedValueOnce(missing)
      .mockReturnValueOnce(readiness.promise);

    render(<MainWindowShell />);
    const draft = await screen.findByRole("textbox", { name: "模拟问题" });
    await waitFor(() => expect(getEnvironmentStatus).toHaveBeenCalledOnce());
    fireEvent.change(draft, { target: { value: "原来的问题" } });
    fireEvent.click(screen.getByRole("button", { name: "模拟需要模型" }));
    await waitFor(() => expect(getEnvironmentStatus).toHaveBeenCalledTimes(2));
    fireEvent.change(draft, { target: { value: "我后来改的问题" } });

    await act(async () => readiness.resolve(missing));

    const settingsNav = await screen.findByRole("navigation", { name: "设置导航" });
    await waitFor(() => {
      expect(within(settingsNav).getByRole("button", { name: "模型" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
    expect(draft).toHaveValue("我后来改的问题");
  });

  it("opens model setup for a quick-panel question and restores its draft", async () => {
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: true,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: false,
      environmentReady: false,
    });

    render(<MainWindowShell />);
    await waitFor(() => expect(mainEventHandlers.has("model-required")).toBe(true));
    act(() => {
      mainEventHandlers.get("model-required")?.({
        payload: { recordId: "panel-record", prompt: "解释这个错误" },
      });
    });

    const settingsNav = await screen.findByRole("navigation", { name: "设置导航" });
    expect(within(settingsNav).getByRole("button", { name: "模型" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "模拟模型就绪" }));

    const workbench = screen.getByTestId("workbench-instance");
    await waitFor(() => {
      expect(workbench.closest(".main-surface")).not.toHaveAttribute("inert");
      expect(workbench).toHaveAttribute("data-requested-record-id", "panel-record");
      expect(screen.getByRole("textbox", { name: "模拟问题" })).toHaveValue("解释这个错误");
    });
  });

  it("keeps a newer draft when model setup finishes", async () => {
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: true,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: false,
      environmentReady: false,
    });

    render(<MainWindowShell />);
    await waitFor(() => expect(mainEventHandlers.has("model-required")).toBe(true));
    act(() => {
      mainEventHandlers.get("model-required")?.({
        payload: { recordId: "panel-record", prompt: "原来的问题" },
      });
    });

    const draft = screen.getByLabelText("模拟问题");
    await waitFor(() => expect(draft).toHaveValue("原来的问题"));
    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    fireEvent.change(draft, { target: { value: "我后来改的问题" } });
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟模型就绪" }));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
    });
    expect(draft).toHaveValue("我后来改的问题");
  });

  it("returns to a quick-panel question when a preference action completes setup", async () => {
    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: true,
      inferenceBackend: "mlx",
      runtimeReady: false,
      modelReady: false,
      environmentReady: false,
    });

    render(<MainWindowShell />);
    await waitFor(() => expect(mainEventHandlers.has("model-required")).toBe(true));
    act(() => {
      mainEventHandlers.get("model-required")?.({
        payload: { recordId: "panel-runtime-record", prompt: "这是什么界面" },
      });
    });
    await screen.findByTestId("model-preferences-panel");

    getEnvironmentStatus.mockResolvedValue({
      onboardingComplete: true,
      inferenceBackend: "mlx",
      runtimeReady: true,
      modelReady: true,
      environmentReady: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "模拟保存模型偏好" }));

    const workbench = screen.getByTestId("workbench-instance");
    await waitFor(() => {
      expect(workbench.closest(".main-surface")).not.toHaveAttribute("inert");
      expect(workbench).toHaveAttribute("data-requested-record-id", "panel-runtime-record");
      expect(screen.getByRole("textbox", { name: "模拟问题" })).toHaveValue("这是什么界面");
    });
  });

  it("refreshes readiness after model preferences change", async () => {
    getEnvironmentStatus
      .mockResolvedValueOnce({
        onboardingComplete: true,
        inferenceBackend: "llama",
        runtimeReady: true,
        modelReady: true,
        environmentReady: true,
      })
      .mockResolvedValueOnce({
        onboardingComplete: true,
        inferenceBackend: "mlx",
        runtimeReady: false,
        modelReady: false,
        environmentReady: false,
      });

    render(<MainWindowShell />);
    const workbench = await screen.findByTestId("workbench-instance");
    await waitFor(() => expect(workbench).toHaveAttribute("data-model-ready", "true"));
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "模型" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟保存模型偏好" }));

    await waitFor(() => {
      expect(getEnvironmentStatus).toHaveBeenCalledTimes(2);
      expect(workbench).toHaveAttribute("data-model-ready", "false");
    });
  });

  it("captures, stores, processes, saves, and selects the first screenshot in order", async () => {
    const image = { name: "first.png", dataUrl: "data:image/png;base64,FIRST" };
    const created = {
      id: "first-record",
      source: "capture",
      title: null,
      ocrText: "",
      ocrState: "pending",
      messages: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      expiresAtMs: 2,
      pinned: false,
    } as const;
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
        captureRetention: "7d",
      } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockResolvedValue(image);
    vi.mocked(captureClient.create).mockResolvedValue(created);

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance")).toHaveAttribute(
        "data-requested-record-id",
        "first-record",
      );
      expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
    });
    expect(captureClient.create).toHaveBeenCalledWith({
      dataUrl: image.dataUrl,
      source: "capture",
      retention: "7d",
    });
    expect(processCaptureInBackground).toHaveBeenCalledWith(created.id, image.dataUrl);
    expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true });
    expect(screen.getByTestId("workbench-instance")).toHaveAttribute("data-show-tips", "true");

    const order = [
      vi.mocked(captureScreenRegion).mock.invocationCallOrder[0],
      vi.mocked(loadSettings).mock.invocationCallOrder[1],
      vi.mocked(captureClient.create).mock.invocationCallOrder[0],
      vi.mocked(processCaptureInBackground).mock.invocationCallOrder[0],
      vi.mocked(updateSettings).mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("offers permission recovery and reports a settings-open failure locally", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("permission-denied"));
    vi.mocked(openScreenRecordingSettings).mockRejectedValue(new Error("open failed at /private/tmp"));

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));

    const openSettings = await screen.findByRole("button", { name: "打开系统设置" });
    expect(screen.getByRole("button", { name: "重试" })).toBeEnabled();
    expect(screen.getByText("允许屏幕录制后，就可以继续截图。")).toBeVisible();
    expect(screen.queryByText("框选屏幕上的内容，MiniVu 会把它保存到工作台。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "稍后进入" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("快捷键 Control+Option+Space")).not.toBeInTheDocument();
    fireEvent.click(openSettings);

    expect(await screen.findByText("系统设置没有打开，请手动打开后重试。")).toBeVisible();
    expect(openScreenRecordingSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText(/private|tmp|open failed/i)).not.toBeInTheDocument();
  });

  it("retries a permission-denied capture and enters with the recovered record", async () => {
    const image = { name: "retry.png", dataUrl: "data:image/png;base64,RETRY" };
    const created = {
      id: "permission-retry-record",
      source: "capture",
      title: null,
      ocrText: "",
      ocrState: "pending",
      messages: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      expiresAtMs: 2,
      pinned: false,
    } as const;
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
        captureRetention: "7d",
      } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion)
      .mockRejectedValueOnce(new CaptureError("permission-denied"))
      .mockResolvedValueOnce(image);
    vi.mocked(captureClient.create).mockResolvedValue(created);

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance")).toHaveAttribute(
        "data-requested-record-id",
        created.id,
      );
    });
    expect(captureScreenRegion).toHaveBeenCalledTimes(2);
    expect(openScreenRecordingSettings).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true });
  });

  it("prevents capture and skip from starting again while capture is pending", async () => {
    const capture = deferred<Awaited<ReturnType<typeof captureScreenRegion>>>();
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockReturnValue(capture.promise);

    render(<MainWindowShell />);
    const start = await screen.findByRole("button", { name: "开始截图" });
    fireEvent.click(start);
    fireEvent.click(start);

    expect(await screen.findByRole("button", { name: "正在截图" })).toBeDisabled();
    const skip = screen.getByRole("button", { name: "稍后进入" });
    expect(skip).toBeDisabled();
    fireEvent.click(skip);
    expect(captureScreenRegion).toHaveBeenCalledOnce();
    expect(loadSettings).toHaveBeenCalledOnce();

    await act(async () => capture.reject(new CaptureError("cancelled")));
  });

  it("loads the latest settings and saves completion before skipping to the workbench", async () => {
    const completionSave = deferred<Awaited<ReturnType<typeof updateSettings>>>();
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Command+Shift+4",
      } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(updateSettings).mockReturnValue(completionSave.promise);

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "稍后进入" }));

    const pending = await screen.findByRole("button", { name: "正在进入" });
    expect(pending).toBeDisabled();
    const captureAction = screen.getByRole("button", { name: "开始截图" });
    expect(captureAction).toBeDisabled();
    fireEvent.click(captureAction);
    expect(updateSettings).toHaveBeenCalledOnce();
    expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true });
    expect(captureScreenRegion).not.toHaveBeenCalled();
    expect(captureClient.create).not.toHaveBeenCalled();

    await act(async () => completionSave.resolve({
      onboardingComplete: true,
      shortcut: "Command+Shift+4",
    } as Awaited<ReturnType<typeof updateSettings>>));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
    });
    expect(screen.getByTestId("workbench-instance")).toHaveAttribute("data-requested-record-id", "");
    expect(loadSettings).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(loadSettings).mock.invocationCallOrder[1],
    ).toBeLessThan(vi.mocked(updateSettings).mock.invocationCallOrder[0]);
  });

  it("keeps screenshot cancellation silent and performs no writes", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("cancelled"));

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "开始截图" })).toBeEnabled());
    expect(screen.queryByText(/失败|权限/)).not.toBeInTheDocument();
    expect(loadSettings).toHaveBeenCalledOnce();
    expect(captureClient.create).not.toHaveBeenCalled();
    expect(processCaptureInBackground).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("stays on welcome when creating the first capture record fails", async () => {
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
        captureRetention: "24h",
      } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockResolvedValue({
      name: "first.png",
      dataUrl: "data:image/png;base64,FIRST",
    });
    vi.mocked(captureClient.create).mockRejectedValue(new Error("write failed at /private/path"));

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));

    expect(await screen.findByText("截图没有保存，请重试。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "从一张截图开始" })).toBeVisible();
    expect(screen.queryByText(/private|write failed/i)).not.toBeInTheDocument();
    expect(processCaptureInBackground).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("enters with the created record and warns when completion persistence fails", async () => {
    const image = { name: "first.png", dataUrl: "data:image/png;base64,FIRST" };
    const created = {
      id: "saved-record",
      source: "capture",
      title: null,
      ocrText: "",
      ocrState: "pending",
      messages: [],
      createdAtMs: 1,
      updatedAtMs: 1,
      expiresAtMs: 2,
      pinned: false,
    } as const;
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
        captureRetention: "24h",
      } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockResolvedValue(image);
    vi.mocked(captureClient.create).mockResolvedValue(created);
    vi.mocked(updateSettings).mockRejectedValue(new Error("settings store unavailable"));

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));

    expect(await screen.findByText("截图已保存，但首次设置未能保存。")).toBeVisible();
    expect(screen.getByTestId("workbench-instance")).toHaveAttribute(
      "data-requested-record-id",
      created.id,
    );
    expect(screen.getByTestId("workbench-instance").closest(".main-surface")).not.toHaveAttribute("inert");
    expect(processCaptureInBackground).toHaveBeenCalledWith(created.id, image.dataUrl);
    expect(
      vi.mocked(processCaptureInBackground).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(updateSettings).mock.invocationCallOrder[0]);
    expect(screen.queryByText(/store unavailable/i)).not.toBeInTheDocument();
  });

  it("stays on welcome with a save notice when skip persistence fails", async () => {
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(updateSettings).mockRejectedValue(new Error("save failed at /tmp/settings"));

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "稍后进入" }));

    expect(await screen.findByText("暂时无法保存设置，请重试。")).toBeVisible();
    expect(screen.getByRole("button", { name: "稍后进入" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "开始截图" })).toBeEnabled();
    expect(screen.getByTestId("workbench-instance").closest(".main-surface")).toHaveAttribute("inert");
    expect(captureClient.create).not.toHaveBeenCalled();
    expect(screen.queryByText(/tmp|save failed/i)).not.toBeInTheDocument();
  });

  it("stops the first-capture continuation after unmount", async () => {
    const capture = deferred<Awaited<ReturnType<typeof captureScreenRegion>>>();
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion).mockReturnValue(capture.promise);

    const view = render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));
    view.unmount();

    await act(async () => capture.resolve({
      name: "late.png",
      dataUrl: "data:image/png;base64,LATE",
    }));

    expect(loadSettings).toHaveBeenCalledOnce();
    expect(captureClient.create).not.toHaveBeenCalled();
    expect(processCaptureInBackground).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("stops the skip continuation after unmount", async () => {
    const latestSettings = deferred<Awaited<ReturnType<typeof loadSettings>>>();
    vi.mocked(loadSettings)
      .mockResolvedValueOnce({
        onboardingComplete: false,
        shortcut: "Control+Option+Space",
      } as Awaited<ReturnType<typeof loadSettings>>)
      .mockReturnValueOnce(latestSettings.promise);

    const view = render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "稍后进入" }));
    await waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(2));
    view.unmount();

    await act(async () => latestSettings.resolve({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>));

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("ignores a stale settings-open failure after screenshot retry begins", async () => {
    const settingsOpen = deferred<void>();
    const retryCapture = deferred<Awaited<ReturnType<typeof captureScreenRegion>>>();
    vi.mocked(loadSettings).mockResolvedValue({
      onboardingComplete: false,
      shortcut: "Control+Option+Space",
    } as Awaited<ReturnType<typeof loadSettings>>);
    vi.mocked(captureScreenRegion)
      .mockRejectedValueOnce(new CaptureError("permission-denied"))
      .mockReturnValueOnce(retryCapture.promise);
    vi.mocked(openScreenRecordingSettings).mockReturnValue(settingsOpen.promise);

    render(<MainWindowShell />);
    fireEvent.click(await screen.findByRole("button", { name: "开始截图" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开系统设置" }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("button", { name: "正在截图" })).toBeDisabled();

    await act(async () => settingsOpen.reject(new Error("late settings failure")));

    expect(screen.queryByText("系统设置没有打开，请手动打开后重试。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在截图" })).toBeDisabled();
  });

  it("keeps one SettingsPanel identity while isolating general and shortcut tasks", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    const settingsNav = await openSettings();
    const panel = await screen.findByTestId("settings-panel");
    const preferencesSurface = panel.closest(".unified-settings-surface");
    expect(panel).toHaveAttribute("data-view", "general");
    expect(preferencesSurface).toHaveClass("unified-settings-surface--plain");
    expect(screen.getByText("自动保留")).toBeVisible();
    expect(screen.queryByText("全局快捷键")).not.toBeInTheDocument();

    fireEvent.click(within(settingsNav).getByRole("button", { name: "快捷键" }));
    expect(screen.getByTestId("settings-panel")).toBe(panel);
    expect(panel).toHaveAttribute("data-view", "shortcut");
    expect(preferencesSurface).not.toHaveClass("unified-settings-surface--plain");
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

    await openSettings();
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
    await waitFor(() => expect(workbench).toHaveAttribute("data-model-ready", "true"));
    const initialRenders = shellState.renders;

    const settingsNav = await openSettings();
    const settingsMain = screen.getByRole("main");
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
    const workbench = await screen.findByTestId("workbench-instance");
    await waitFor(() => expect(workbench).toHaveAttribute("data-model-ready", "true"));
    const initialStatusChecks = getEnvironmentStatus.mock.calls.length;
    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();

    const settingsNav = await openSettings();
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
    expect(getEnvironmentStatus).toHaveBeenCalledTimes(initialStatusChecks + 2);
  });

  it("disables every model action as soon as inline repair opens", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    const settingsNav = await openSettings();
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));

    const preferences = await screen.findByTestId("model-preferences-panel");
    const model = screen.getByTestId("model-panel");
    fireEvent.click(within(model).getByRole("button", { name: "模拟修复模型组件" }));
    const repair = await screen.findByTestId("environment-setup");
    const startRepair = within(repair).getByRole("button", { name: "模拟开始修复" });

    expect(preferences).toHaveAttribute("data-disabled", "true");
    expect(model).toHaveAttribute("data-disabled", "true");
    expect(within(preferences).getByRole("button", { name: "模拟保存模型偏好" })).toBeDisabled();
    expect(within(preferences).getByRole("button", { name: "模拟开始偏好保存" })).toBeDisabled();
    expect(within(model).getByRole("button", { name: "模拟修复模型组件" })).toBeDisabled();
    expect(within(model).getByRole("button", { name: "模拟开始模型下载" })).toBeDisabled();
    expect(startRepair).toBeEnabled();

    fireEvent.click(startRepair);
    expect(preferences).toHaveAttribute("data-disabled", "true");
    expect(model).toHaveAttribute("data-disabled", "true");

    fireEvent.click(within(repair).getByRole("button", { name: "模拟结束修复" }));
    expect(preferences).toHaveAttribute("data-disabled", "true");
    expect(model).toHaveAttribute("data-disabled", "true");
  });

  it("closes inline repair before start and restores model controls", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    const settingsNav = await openSettings();
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));

    const preferences = await screen.findByTestId("model-preferences-panel");
    const model = screen.getByTestId("model-panel");
    fireEvent.click(within(model).getByRole("button", { name: "模拟修复模型组件" }));
    const repair = await screen.findByTestId("environment-setup");
    expect(preferences).toHaveAttribute("data-disabled", "true");
    expect(model).toHaveAttribute("data-disabled", "true");

    fireEvent.click(within(repair).getByRole("button", { name: "模拟关闭修复" }));

    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();
    expect(preferences).toHaveAttribute("data-disabled", "false");
    expect(model).toHaveAttribute("data-disabled", "false");
  });

  it("clears the repair busy lock when failed inline repair closes", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    const settingsNav = await openSettings();
    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));

    const preferences = await screen.findByTestId("model-preferences-panel");
    const model = screen.getByTestId("model-panel");
    fireEvent.click(within(model).getByRole("button", { name: "模拟修复模型组件" }));
    const repair = await screen.findByTestId("environment-setup");
    fireEvent.click(within(repair).getByRole("button", { name: "模拟开始修复" }));
    expect(preferences).toHaveAttribute("data-disabled", "true");
    expect(model).toHaveAttribute("data-disabled", "true");

    fireEvent.click(within(repair).getByRole("button", { name: "模拟结束修复" }));
    expect(preferences).toHaveAttribute("data-disabled", "true");
    expect(model).toHaveAttribute("data-disabled", "true");

    fireEvent.click(within(repair).getByRole("button", { name: "模拟关闭修复" }));

    expect(screen.queryByTestId("environment-setup")).not.toBeInTheDocument();
    expect(preferences).toHaveAttribute("data-disabled", "false");
    expect(model).toHaveAttribute("data-disabled", "false");
  });

  it("blocks repair and both model surfaces while a sibling model operation is pending", async () => {
    render(<MainWindowShell />);
    await screen.findByTestId("workbench-instance");

    const settingsNav = await openSettings();
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
    const workbench = await screen.findByTestId("workbench-instance");
    await waitFor(() => expect(workbench).toHaveAttribute("data-model-ready", "true"));

    const settingsNav = await openSettings();
    const settingsMain = screen.getByRole("main");
    settingsMain.scrollTop = 180;

    fireEvent.click(within(settingsNav).getByRole("button", { name: "模型" }));
    expect(settingsMain.scrollTop).toBe(0);
    settingsMain.scrollTop = 40;

    fireEvent.click(screen.getByRole("button", { name: "固定" }));
    await openSettings();
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

  it("keeps the crop-corner welcome motion brief and disables it for reduced motion", () => {
    expect(workbenchCss).toMatch(
      /\.first-run-welcome__corner\s*{[^}]*animation:\s*first-run-corner-in 280ms[^}]*}/,
    );
    expect(workbenchCss).toMatch(
      /@keyframes first-run-corner-in\s*{[\s\S]*?opacity:\s*0[\s\S]*?transform:[^;]+[\s\S]*?opacity:\s*1[\s\S]*?transform:\s*none/,
    );
    expect(workbenchCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.first-run-welcome__corner\s*{[^}]*animation:\s*none[^}]*transform:\s*none/,
    );
    expect(workbenchCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.first-run-welcome \.is-spinning\s*{[^}]*animation:\s*none/,
    );
    expect(workbenchCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.capture-inspector__tip\s*{[^}]*animation:\s*none/,
    );
    expect(cssRuleBody(workbenchCss, ".first-run-welcome__primary")).toMatch(
      /min-width:\s*174px[\s\S]*height:\s*44px/,
    );
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
    expect(settingsCss).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.preference-switch\s*,[\s\S]*?\.preference-switch::before\s*{[^}]*transition:\s*none/,
    );
  });

  it("keeps active product typography and primary controls comfortably sized", () => {
    expect(`${settingsCss}\n${workbenchCss}`).not.toMatch(/letter-spacing:\s*-/);
    expect(stylesEntry).not.toContain('styles/home.css');
    expect(cssRuleBody(workbenchCss, ".app-rail button,\n.capture-canvas__toolbar button,\n.workbench-detail__actions button")).toMatch(
      /width:\s*44px[\s\S]*height:\s*44px/,
    );
    expect(cssRuleBody(settingsCss, ".settings-navigation-pane__nav button")).toMatch(
      /min-height:\s*44px/,
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
