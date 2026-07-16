import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickLauncher, QuickPanelShell } from "../src/app-shell/QuickPanelShell";
import { CaptureError, captureScreenRegion } from "../src/image/captureScreen";
import { captureClient } from "../src/captures/captureClient";

const { invokeMock, emitToMock, eventHandlers, chatPanelProps, getEnvironmentStatus } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  emitToMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: never }) => void>(),
  chatPanelProps: { current: null as Record<string, unknown> | null },
  getEnvironmentStatus: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (...args: unknown[]) => emitToMock(...args),
  listen: vi.fn(async (name: string, callback: (event: { payload: never }) => void) => {
    eventHandlers.set(name, callback);
    return () => eventHandlers.delete(name);
  }),
}));
vi.mock("../src/chat/ChatPanel", () => ({
  ChatPanel: (props: Record<string, unknown>) => {
    chatPanelProps.current = props;
    return null;
  },
}));
vi.mock("../src/model/modelClient", () => ({
  modelClient: { getEnvironmentStatus },
}));
vi.mock("../src/image/captureScreen", async () => {
  const actual = await vi.importActual<typeof import("../src/image/captureScreen")>(
    "../src/image/captureScreen",
  );
  return { ...actual, captureScreenRegion: vi.fn() };
});
vi.mock("../src/image/imageIntake", () => ({ readClipboardImage: vi.fn() }));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn().mockResolvedValue({ captureRetention: "24h" }),
}));
vi.mock("../src/captures/captureClient", () => ({
  captureClient: { create: vi.fn() },
}));

describe("QuickLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    emitToMock.mockReset();
    getEnvironmentStatus.mockReset();
    vi.mocked(captureScreenRegion).mockReset();
    vi.mocked(captureClient.create).mockReset();
    eventHandlers.clear();
    chatPanelProps.current = null;
    getEnvironmentStatus.mockResolvedValue({ modelReady: true });
  });

  it("exposes only the three primary screenshot actions", () => {
    const onCapture = vi.fn();
    const onPaste = vi.fn();
    const onRecent = vi.fn();
    render(<QuickLauncher onCapture={onCapture} onPaste={onPaste} onRecent={onRecent} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["截图", "粘贴", "最近"]);
    fireEvent.click(screen.getByRole("button", { name: "截图" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onRecent).toHaveBeenCalledOnce();
  });

  it("consumes a pending shortcut after listener registration without duplicate capture", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "take_pending_capture_request") {
        return Promise.resolve(invokeMock.mock.calls.filter(([name]) =>
          name === "take_pending_capture_request").length === 1);
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(captureScreenRegion).mockResolvedValue({
      name: "capture.png",
      dataUrl: "data:image/png;base64,AAA",
    });
    vi.mocked(captureClient.create).mockResolvedValue({ id: "record-a" } as never);

    render(<QuickPanelShell />);
    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledOnce());

    await act(async () => {
      eventHandlers.get("capture-requested")?.({ payload: undefined as never });
    });
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([name]) =>
        name === "take_pending_capture_request")).toHaveLength(2);
    });
    expect(captureScreenRegion).toHaveBeenCalledOnce();
  });

  it("keeps a typed screenshot cancellation silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => (
      Promise.resolve(command === "take_pending_capture_request")
    ));
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("cancelled"));

    render(<QuickPanelShell />);

    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledOnce());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never logs raw capture failures", async () => {
    const failure = new Error("Metal sidecar failed at /private/tmp/model.gguf");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => (
      Promise.resolve(command === "take_pending_capture_request")
    ));
    vi.mocked(captureScreenRegion).mockRejectedValue(failure);

    render(<QuickPanelShell />);

    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledOnce());
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("截图失败");
    expect(warn).not.toHaveBeenCalledWith(failure);
    warn.mockRestore();
  });

  it("opens model setup from the quick panel and preserves the question", async () => {
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,AAA" };
    vi.mocked(captureClient.create).mockResolvedValue({ id: "panel-record" } as never);
    getEnvironmentStatus.mockResolvedValue({ modelReady: false });

    render(<QuickPanelShell />);
    await act(async () => {
      await (chatPanelProps.current?.onImageInput as (
        image: typeof image,
        source: "paste",
      ) => Promise<void>)(image, "paste");
    });

    const ready = await (chatPanelProps.current?.onRequireModel as (
      prompt: string,
    ) => Promise<boolean>)("解释这个错误");

    expect(ready).toBe(false);
    expect(emitToMock).toHaveBeenCalledWith("main", "model-required", {
      recordId: "panel-record",
      prompt: "解释这个错误",
    });
    expect(invokeMock).toHaveBeenCalledWith("show_main");
  });
});
