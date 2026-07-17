import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickLauncher, QuickPanelShell } from "../src/app-shell/QuickPanelShell";
import { CaptureError, captureScreenRegion } from "../src/image/captureScreen";
import { readClipboardImage } from "../src/image/imageIntake";
import { captureClient } from "../src/captures/captureClient";

const { invokeMock, emitToMock, eventHandlers, chatPanelProps, getEnvironmentStatus } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  emitToMock: vi.fn(),
  eventHandlers: new Map<string, (event: { payload: never }) => void>(),
  chatPanelProps: { current: null as Record<string, unknown> | null },
  getEnvironmentStatus: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  captureClient: { create: vi.fn(), remove: vi.fn() },
}));

async function setPanelMode(mode: "expanded" | "launcher" | "pet" | "hidden") {
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_quick_panel_mode"));
  await act(async () => {
    eventHandlers.get("quick-panel-mode")?.({ payload: mode as never });
  });
}

describe("QuickLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_quick_panel_mode") return Promise.resolve("hidden");
      if (command === "take_pending_capture_request") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });
    emitToMock.mockReset();
    getEnvironmentStatus.mockReset();
    vi.mocked(captureScreenRegion).mockReset();
    vi.mocked(readClipboardImage).mockReset();
    vi.mocked(captureClient.create).mockReset();
    vi.mocked(captureClient.remove).mockReset();
    vi.mocked(captureClient.remove).mockResolvedValue(undefined);
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
      if (command === "get_quick_panel_mode") return Promise.resolve("hidden");
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

  it("restores pet mode from the native snapshot after listener registration", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_quick_panel_mode") return Promise.resolve("pet");
      if (command === "take_pending_capture_request") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    render(<QuickPanelShell />);

    expect(await screen.findByRole("button", { name: "展开 MiniVu" })).toBeVisible();
    expect(invokeMock).toHaveBeenCalledWith("get_quick_panel_mode");
  });

  it("does not let an older native snapshot overwrite a newer mode event", async () => {
    const pendingMode = deferred<"hidden">();
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_quick_panel_mode") return pendingMode.promise;
      if (command === "take_pending_capture_request") return Promise.resolve(false);
      return Promise.resolve(undefined);
    });

    render(<QuickPanelShell />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_quick_panel_mode"));
    await act(async () => {
      eventHandlers.get("quick-panel-mode")?.({ payload: "pet" as never });
      pendingMode.resolve("hidden");
      await pendingMode.promise;
    });

    expect(screen.getByRole("button", { name: "展开 MiniVu" })).toBeVisible();
  });

  it("shows a status notice when launcher paste finds no image", async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(null);
    render(<QuickPanelShell />);

    await setPanelMode("launcher");
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));

    expect(await screen.findByRole("status")).toHaveTextContent("剪贴板里没有图片");
    expect(invokeMock).not.toHaveBeenCalledWith("expand_quick_panel_command");
  });

  it("clears launcher feedback and Escape handling after leaving launcher mode", async () => {
    vi.mocked(readClipboardImage).mockResolvedValue(null);
    render(<QuickPanelShell />);

    await setPanelMode("launcher");
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    expect(await screen.findByRole("status")).toHaveTextContent("剪贴板里没有图片");

    await setPanelMode("expanded");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(invokeMock).not.toHaveBeenCalledWith("close_quick_panel_command");
  });

  it("closes the launcher when Escape is pressed", async () => {
    render(<QuickPanelShell />);

    await setPanelMode("launcher");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(invokeMock).toHaveBeenCalledWith("close_quick_panel_command");
  });

  it("ignores a paste result that arrives after leaving launcher mode", async () => {
    const pending = deferred<null>();
    vi.mocked(readClipboardImage).mockReturnValueOnce(pending.promise);
    render(<QuickPanelShell />);

    await setPanelMode("launcher");
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    await waitFor(() => expect(readClipboardImage).toHaveBeenCalledOnce());

    await act(async () => {
      eventHandlers.get("quick-panel-mode")?.({ payload: "expanded" as never });
      pending.resolve(null);
      await pending.promise;
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("expand_quick_panel_command");
  });

  it("removes a pasted capture that finishes saving after leaving launcher mode", async () => {
    const pendingCreate = deferred<{ id: string }>();
    vi.mocked(readClipboardImage).mockResolvedValue({
      name: "paste.png",
      dataUrl: "data:image/png;base64,PASTE",
    });
    vi.mocked(captureClient.create).mockReturnValueOnce(pendingCreate.promise as never);
    render(<QuickPanelShell />);

    await setPanelMode("launcher");
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    await waitFor(() => expect(captureClient.create).toHaveBeenCalledOnce());

    await act(async () => {
      eventHandlers.get("quick-panel-mode")?.({ payload: "pet" as never });
      pendingCreate.resolve({ id: "cancelled-paste" });
      await pendingCreate.promise;
    });

    await waitFor(() => expect(captureClient.remove).toHaveBeenCalledWith("cancelled-paste"));
    expect(invokeMock).not.toHaveBeenCalledWith("expand_quick_panel_command");
  });

  it("keeps a newer paste result from being overwritten by an older one", async () => {
    const first = deferred<{ name: string; dataUrl: string } | null>();
    const second = deferred<{ name: string; dataUrl: string } | null>();
    vi.mocked(readClipboardImage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<QuickPanelShell />);

    await setPanelMode("launcher");
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    await waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(null);
      await second.promise;
    });
    expect(await screen.findByRole("status")).toHaveTextContent("剪贴板里没有图片");

    await act(async () => {
      first.resolve({ name: "late.png", dataUrl: "data:image/png;base64,LATE" });
      await first.promise;
    });

    expect(screen.getByRole("status")).toHaveTextContent("剪贴板里没有图片");
    expect(captureClient.create).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("expand_quick_panel_command");
  });

  it("does not create or expand after the launcher unmounts", async () => {
    const pending = deferred<{ name: string; dataUrl: string } | null>();
    vi.mocked(readClipboardImage).mockReturnValueOnce(pending.promise);
    const view = render(<QuickPanelShell />);

    await setPanelMode("launcher");
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    await waitFor(() => expect(readClipboardImage).toHaveBeenCalledOnce());
    view.unmount();

    await act(async () => {
      pending.resolve({ name: "late.png", dataUrl: "data:image/png;base64,LATE" });
      await pending.promise;
    });

    expect(captureClient.create).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("expand_quick_panel_command");
  });

  it("keeps a typed screenshot cancellation silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => (
      Promise.resolve(command === "get_quick_panel_mode"
        ? "hidden"
        : command === "take_pending_capture_request")
    ));
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("cancelled"));

    render(<QuickPanelShell />);

    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledOnce());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("routes capture failures to the main recovery surface without logging raw errors", async () => {
    const failure = new Error("Metal sidecar failed at /private/tmp/model.gguf");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => (
      Promise.resolve(command === "get_quick_panel_mode"
        ? "hidden"
        : command === "take_pending_capture_request")
    ));
    vi.mocked(captureScreenRegion).mockRejectedValue(failure);

    render(<QuickPanelShell />);

    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledOnce());
    expect(emitToMock).toHaveBeenCalledWith("main", "capture-recovery", { code: "unknown" });
    expect(invokeMock).toHaveBeenCalledWith("show_main");
    expect(warn).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(failure);
    warn.mockRestore();
  });

  it("routes screenshot permission recovery to the main window", async () => {
    invokeMock.mockImplementation((command: string) => (
      Promise.resolve(command === "get_quick_panel_mode"
        ? "hidden"
        : command === "take_pending_capture_request")
    ));
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("permission-denied"));

    render(<QuickPanelShell />);

    await waitFor(() => expect(captureScreenRegion).toHaveBeenCalledOnce());
    expect(emitToMock).toHaveBeenCalledWith("main", "capture-recovery", {
      code: "permission-denied",
    });
    expect(invokeMock).toHaveBeenCalledWith("show_main");
  });

  it("opens model setup from the quick panel and preserves the question", async () => {
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,AAA" };
    vi.mocked(captureClient.create).mockResolvedValue({ id: "panel-record" } as never);
    getEnvironmentStatus.mockResolvedValue({ modelReady: false });

    render(<QuickPanelShell />);
    await setPanelMode("expanded");
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
