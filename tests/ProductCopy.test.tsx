import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeOverview } from "../src/app-shell/HomeOverview";
import { SettingsSidebar } from "../src/app-shell/SettingsSidebar";
import { PrivacyNotice } from "../src/privacy/PrivacyNotice";
import { SettingsPanel } from "../src/settings/SettingsPanel";
import { createDefaultSettings } from "../src/settings/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const banned = /Metal|GGUF|MLX|llama|sidecar|runtime|推理引擎|权重|视觉投影器/i;

function defaultVisibleText(container: HTMLElement) {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("details:not([open]) > :not(summary)").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

beforeEach(() => {
  listenMock.mockResolvedValue(vi.fn());
  invokeMock.mockImplementation(async (command) => {
    if (command === "load_app_settings") return createDefaultSettings();
    if (command === "get_device_info") {
      return {
        platform: "macOS",
        isAppleSilicon: true,
        memoryGb: 16,
        recommended: true,
        message: "Metal runtime ready at /private/path",
      };
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("natural product copy", () => {
  it("uses the requested navigation labels", () => {
    render(<SettingsSidebar active="home" shortcut="Control+Option+Space" modelReady onNavigate={vi.fn()} onOpenSetup={vi.fn()} />);
    expect(screen.getByRole("button", { name: "首次设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载内容" })).toBeInTheDocument();
    expect(screen.queryByText("环境配置")).not.toBeInTheDocument();
    expect(screen.queryByText("模型文件")).not.toBeInTheDocument();
  });

  it("describes home capabilities without implementation terms or raw device messages", async () => {
    const { container } = render(<HomeOverview environmentStatus={{
      onboardingComplete: true,
      inferenceBackend: "llama",
      runtimeReady: true,
      modelReady: true,
      environmentReady: true,
    }} onOpenSetup={vi.fn()} onOpenModel={vi.fn()} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_device_info"));
    expect(container).toHaveTextContent("本机处理");
    expect(container).toHaveTextContent("图片理解");
    expect(container).toHaveTextContent("文字识别");
    expect(container).toHaveTextContent("导出文档");
    expect(defaultVisibleText(container)).not.toMatch(banned);
    expect(container).not.toHaveTextContent("/private/path");
  });

  it("keeps compatibility implementation choices inside closed advanced settings", async () => {
    const { container } = render(<SettingsPanel />);
    await screen.findByText("本机处理");
    expect(container).toHaveTextContent("处理方式");
    expect(container).toHaveTextContent("保持快速响应");
    expect(container).toHaveTextContent("启动时提前准备");
    expect(container).toHaveTextContent("下载设置");
    expect(container).toHaveTextContent("下载来源");
    expect(defaultVisibleText(container)).not.toMatch(banned);
    expect(container).not.toHaveTextContent("/private/path");
    expect(screen.getByText("高级设置").closest("details")).not.toHaveAttribute("open");
  });

  it("hides standard-mode download sources when compatibility mode is selected", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "load_app_settings") {
        return { ...createDefaultSettings(), inferenceBackend: "mlx" };
      }
      if (command === "get_device_info") {
        return { platform: "macOS", isAppleSilicon: true, memoryGb: 16, recommended: true, message: "ready" };
      }
      return undefined;
    });
    render(<SettingsPanel />);

    await screen.findByText("兼容模式", { selector: "strong" });
    expect(screen.queryByText("下载设置")).not.toBeInTheDocument();
    expect(screen.queryByText("下载来源")).not.toBeInTheDocument();
  });

  it("explains privacy with user-facing capability names", () => {
    const { container } = render(<PrivacyNotice />);
    expect(container).toHaveTextContent("文字识别");
    expect(container).toHaveTextContent("图片理解");
    expect(defaultVisibleText(container)).not.toMatch(banned);
  });
});
