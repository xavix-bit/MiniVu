import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/chat/ChatPanel";
import { useImageSession } from "../src/chat/useImageSession";
import { CaptureError, captureScreenRegion } from "../src/image/captureScreen";

vi.mock("../src/chat/useImageSession", () => ({ useImageSession: vi.fn() }));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../src/export/exportSession", () => ({ exportCurrentSession: vi.fn() }));
vi.mock("../src/image/captureScreen", async () => {
  const actual = await vi.importActual<typeof import("../src/image/captureScreen")>(
    "../src/image/captureScreen",
  );
  return { ...actual, captureScreenRegion: vi.fn() };
});
vi.mock("../src/image/imageIntake", () => ({
  filterAcceptedFiles: vi.fn().mockReturnValue([]),
  readClipboardImage: vi.fn().mockResolvedValue(null),
  readFileAsDataUrl: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const useImageSessionMock = vi.mocked(useImageSession);

function session(overrides: Record<string, unknown> = {}) {
  return {
    state: { image: null, ocrText: "", messages: [] },
    streamingText: "",
    isAnswering: false,
    ocrLoading: false,
    error: "",
    statusBar: { visible: false, message: "", detail: undefined },
    clearError: vi.fn(),
    setImage: vi.fn(),
    pendingReplaceImage: null,
    confirmReplaceImage: vi.fn(),
    cancelReplaceImage: vi.fn(),
    ask: vi.fn(),
    stopGeneration: vi.fn(),
    clearConversation: vi.fn(),
    loadSession: vi.fn(),
    resetSession: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useImageSession>;
}

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    useImageSessionMock.mockReturnValue(session());
  });

  it("uses a clear image icon and readable action hierarchy in the empty state", () => {
    render(<ChatPanel />);

    const emptyImageIcon = screen.getByTestId("empty-image-icon");
    expect(emptyImageIcon).toHaveAttribute("aria-hidden", "true");
    expect(emptyImageIcon.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "截图" })).toHaveClass("drop-zone__capture");
    expect(screen.getByRole("button", { name: "粘贴" })).toHaveClass("drop-zone__secondary");
    expect(screen.queryByLabelText("识别模式")).not.toBeInTheDocument();
  });

  it("offers four contextual actions and sends summary and explanation prompts", () => {
    const ask = vi.fn();
    useImageSessionMock.mockReturnValue(session({
      state: {
        image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
        ocrText: "识别文字",
        messages: [],
      },
      ask,
    }));

    render(<ChatPanel />);

    expect(screen.getByRole("button", { name: "复制文字" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "翻译" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "总结" }));
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("概括这张截图"),
      "总结截图",
    );

    fireEvent.click(screen.getByRole("button", { name: "解释" }));
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("错误或警告"),
      "解释截图",
    );
    expect(screen.queryAllByRole("button", { name: "问图" })).toHaveLength(0);
  });

  it("keeps only copy text disabled until OCR text is available", () => {
    useImageSessionMock.mockReturnValue(session({
      state: {
        image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
        ocrText: "",
        messages: [],
      },
    }));

    render(<ChatPanel />);

    expect(screen.getByRole("button", { name: "复制文字" })).toBeDisabled();
    for (const name of ["翻译", "总结", "解释"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });

  it("hides all four quick actions after a conversation begins", () => {
    useImageSessionMock.mockReturnValue(session({
      state: {
        image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
        ocrText: "识别文字",
        messages: [{ role: "user", content: "解释这个错误" }],
      },
    }));

    render(<ChatPanel />);

    for (const name of ["复制文字", "翻译", "总结", "解释"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("keeps the question and defers asking when model setup is required", async () => {
    const ask = vi.fn();
    const onRequireModel = vi.fn().mockResolvedValue(false);
    useImageSessionMock.mockReturnValue(session({
      state: {
        image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
        ocrText: "识别文字",
        messages: [],
      },
      ask,
    }));

    render(<ChatPanel onRequireModel={onRequireModel} />);
    const composer = screen.getByPlaceholderText("问这张图…");
    fireEvent.change(composer, { target: { value: "解释这个错误" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(onRequireModel).toHaveBeenCalledWith("解释这个错误"));
    expect(ask).not.toHaveBeenCalled();
    expect(composer).toHaveValue("解释这个错误");
  });

  it("shows a concise capture notice without exposing backend details", async () => {
    vi.mocked(captureScreenRegion).mockRejectedValue(
      new Error("Metal sidecar failed at /private/tmp/model.gguf"),
    );
    render(<ChatPanel />);

    fireEvent.click(screen.getByRole("button", { name: "截图" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("截图失败，请重试。"));
    expect(screen.queryByText(/Metal|GGUF|sidecar|\/tmp/i)).not.toBeInTheDocument();
  });

  it("keeps typed cancellation silent", async () => {
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("cancelled"));
    render(<ChatPanel />);

    fireEvent.click(screen.getByRole("button", { name: "截图" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "截图" })).toBeEnabled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a concise permission notice for typed denial", async () => {
    vi.mocked(captureScreenRegion).mockRejectedValue(new CaptureError("permission-denied"));
    render(<ChatPanel />);

    fireEvent.click(screen.getByRole("button", { name: "截图" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("请在系统设置中允许屏幕录制后重试。");
    });
  });
});
