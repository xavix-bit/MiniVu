import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/chat/ChatPanel";
import { useImageSession } from "../src/chat/useImageSession";

vi.mock("../src/chat/useImageSession", () => ({ useImageSession: vi.fn() }));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../src/export/exportSession", () => ({ exportCurrentSession: vi.fn() }));
vi.mock("../src/image/captureScreen", () => ({ captureScreenRegion: vi.fn() }));
vi.mock("../src/image/imageIntake", () => ({
  filterAcceptedFiles: vi.fn().mockReturnValue([]),
  readClipboardImage: vi.fn().mockResolvedValue(null),
  readFileAsDataUrl: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const useImageSessionMock = vi.mocked(useImageSession);

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useImageSessionMock.mockReturnValue({
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
    } as unknown as ReturnType<typeof useImageSession>);
  });

  it("uses a clear image icon and readable action hierarchy in the empty state", () => {
    render(<ChatPanel />);

    const emptyImageIcon = screen.getByTestId("empty-image-icon");
    expect(emptyImageIcon).toHaveAttribute("aria-hidden", "true");
    expect(emptyImageIcon.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "截图" })).toHaveClass("drop-zone__capture");
    expect(screen.getByRole("button", { name: "粘贴" })).toHaveClass("drop-zone__secondary");
  });
});
