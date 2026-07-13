import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/chat/ChatPanel";
import { useImageSession } from "../src/chat/useImageSession";
import { exportCurrentSession } from "../src/export/exportSession";
import { captureScreenRegion, isCaptureCancelled } from "../src/image/captureScreen";

vi.mock("../src/chat/useImageSession", () => ({ useImageSession: vi.fn() }));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../src/export/exportSession", () => ({ exportCurrentSession: vi.fn() }));
vi.mock("../src/image/captureScreen", () => ({
  captureScreenRegion: vi.fn(),
  isCaptureCancelled: vi.fn().mockReturnValue(false),
}));
vi.mock("../src/image/imageIntake", () => ({
  filterAcceptedFiles: vi.fn().mockReturnValue([]),
  readClipboardImage: vi.fn().mockResolvedValue(null),
  readFileAsDataUrl: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const useImageSessionMock = vi.mocked(useImageSession);
const captureScreenRegionMock = vi.mocked(captureScreenRegion);
const isCaptureCancelledMock = vi.mocked(isCaptureCancelled);
const exportCurrentSessionMock = vi.mocked(exportCurrentSession);

function session(overrides: Record<string, unknown> = {}) {
  return {
    state: { image: null, ocrText: "", messages: [] },
    streamingText: "",
    isAnswering: false,
    ocrLoading: false,
    ocrStatus: "idle",
    ocrError: "",
    error: "",
    answerError: "",
    statusBar: { visible: false, message: "", detail: undefined },
    clearError: vi.fn(),
    setImage: vi.fn(),
    retryOcr: vi.fn(),
    pendingReplaceImage: null,
    confirmReplaceImage: vi.fn(),
    cancelReplaceImage: vi.fn(),
    ask: vi.fn(),
    retryAnswer: vi.fn(),
    stopGeneration: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useImageSession>;
}

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats top commands as actions and makes screenshot primary in the empty state", () => {
    useImageSessionMock.mockReturnValue(session());
    render(<ChatPanel />);

    for (const name of ["截图 OCR", "截图翻译", "图片问答", "更多"]) {
      expect(screen.getByRole("button", { name })).not.toHaveClass("is-active");
    }
    expect(screen.getByRole("button", { name: "截图" })).toHaveClass("drop-zone__capture");
    expect(screen.getByRole("button", { name: "粘贴图片" })).toHaveClass("drop-zone__secondary");
    expect(screen.getByRole("button", { name: "选择图片" })).toHaveClass("drop-zone__secondary");
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByPlaceholderText("先截图、粘贴或选择一张图片")).toBeDisabled();
  });

  it("locks destructive image actions while answering and shows only one stop", () => {
    useImageSessionMock.mockReturnValue(session({
      state: {
        image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
        ocrText: "文字",
        messages: [{ role: "user", content: "问题" }],
      },
      isAnswering: true,
      ocrStatus: "recognized",
      statusBar: { visible: true, message: "回答中…", detail: undefined },
    }));
    render(<ChatPanel />);

    expect(screen.getAllByRole("button", { name: "停止" })).toHaveLength(1);
    for (const name of ["截图 OCR", "截图翻译", "图片问答", "更多", "换图", "清空"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("offers retry beside a failed answer while keeping the question visible", () => {
    const retryAnswer = vi.fn();
    useImageSessionMock.mockReturnValue(session({
      state: {
        image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
        ocrText: "",
        messages: [{ role: "user", content: "这是什么？" }],
      },
      ocrStatus: "empty",
      answerError: "回答没有完成，请重试",
      retryAnswer,
    }));
    render(<ChatPanel />);

    expect(screen.getByText("这是什么？")).toBeInTheDocument();
    expect(screen.getByText("回答没有完成，请重试")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试回答" }));
    expect(retryAnswer).toHaveBeenCalledOnce();
  });

  it("keeps screenshot cancellation silent and maps real failures to safe copy", async () => {
    useImageSessionMock.mockReturnValue(session());
    captureScreenRegionMock.mockRejectedValueOnce(new Error("已取消截图"));
    isCaptureCancelledMock.mockReturnValueOnce(true);
    const { unmount } = render(<ChatPanel />);

    fireEvent.click(screen.getByRole("button", { name: "截图 OCR" }));
    await waitFor(() => expect(captureScreenRegionMock).toHaveBeenCalledOnce());
    expect(screen.queryByText("未能截图，请重试")).not.toBeInTheDocument();
    unmount();

    useImageSessionMock.mockReturnValue(session());
    captureScreenRegionMock.mockRejectedValueOnce(new Error("/private/tmp/capture failed"));
    isCaptureCancelledMock.mockReturnValueOnce(false);
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: "截图 OCR" }));

    expect(await screen.findByText("未能截图，请重试")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("/private/tmp");
  });

  it("does not expose export errors", async () => {
    useImageSessionMock.mockReturnValue(session({
      state: {
        image: { name: "screen.png", dataUrl: "data:image/png;base64,abc" },
        ocrText: "",
        messages: [],
      },
      ocrStatus: "empty",
    }));
    exportCurrentSessionMock.mockRejectedValueOnce(new Error("/private/tmp/export stderr"));
    render(<ChatPanel />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    expect(await screen.findByText("导出未完成，请重试")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("/private/tmp");
    expect(document.body.textContent).not.toContain("stderr");
  });
});
