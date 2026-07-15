import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/chat/ChatPanel";
import { captureClient } from "../src/captures/captureClient";
import { captureScreenRegion } from "../src/image/captureScreen";
import { readClipboardImage, readFileAsDataUrl } from "../src/image/imageIntake";
import type { CaptureRecord } from "../src/captures/types";

const { invokeMock, modelClientMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  modelClientMock: {
    askImage: vi.fn(),
    cancelGeneration: vi.fn(),
    warmupModel: vi.fn(),
    getModelStatus: vi.fn(),
    onSidecarLoadProgress: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../src/model/modelClient", () => ({ modelClient: modelClientMock }));
vi.mock("../src/settings/settingsStore", () => ({
  loadSettings: vi.fn().mockResolvedValue({ shortcut: "Control+Option+Space" }),
}));
vi.mock("../src/export/exportSession", () => ({ exportCurrentSession: vi.fn() }));
vi.mock("../src/image/captureScreen", () => ({ captureScreenRegion: vi.fn() }));
vi.mock("../src/image/imageIntake", async () => {
  const actual = await vi.importActual<typeof import("../src/image/imageIntake")>(
    "../src/image/imageIntake",
  );
  return {
    ...actual,
    readClipboardImage: vi.fn().mockResolvedValue(null),
    readFileAsDataUrl: vi.fn(),
  };
});
vi.mock("../src/captures/captureClient", () => ({
  captureClient: {
    get: vi.fn(),
    readImage: vi.fn(),
    update: vi.fn().mockResolvedValue(null),
  },
}));

const imageA = { name: "a.png", dataUrl: "data:image/png;base64,AAA" };
const imageB = { name: "b.png", dataUrl: "data:image/png;base64,BBB" };

function record(
  id: string,
  overrides: Partial<CaptureRecord> = {},
): CaptureRecord {
  return {
    id,
    source: "capture",
    title: null,
    ocrText: "",
    ocrState: "pending",
    messages: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    expiresAtMs: null,
    pinned: false,
    ...overrides,
  };
}

describe("ChatPanel record integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelClientMock.getModelStatus.mockResolvedValue({ inferenceBackend: "llama" });
    modelClientMock.warmupModel.mockResolvedValue(undefined);
    modelClientMock.onSidecarLoadProgress.mockResolvedValue(() => {});
    vi.mocked(captureClient.update).mockResolvedValue(null);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("applies a pending initial image once while OCR state rerenders", async () => {
    vi.mocked(captureClient.get).mockResolvedValue(record("record-a"));
    vi.mocked(captureClient.readImage).mockResolvedValue(imageA.dataUrl);
    invokeMock.mockImplementation((command: string) => {
      if (command === "recognize_text_from_image_data_url") {
        return Promise.resolve({ text: "A OCR" });
      }
      return Promise.resolve(undefined);
    });

    const { rerender } = render(
      <ChatPanel recordId="record-a" initialImage={imageA} onImageInput={vi.fn()} />,
    );
    rerender(
      <ChatPanel
        recordId="record-a"
        initialImage={{ ...imageA }}
        onImageInput={vi.fn()}
      />,
    );

    await screen.findByText("A OCR");
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "recognize_text_from_image_data_url"),
    ).toHaveLength(1);
  });

  it("loads each record's own conversation and never writes A into B", async () => {
    vi.mocked(captureClient.get).mockImplementation(async (id) =>
      id === "record-a"
        ? record("record-a", {
            ocrText: "OCR A",
            ocrState: "ready",
            messages: [{ role: "user", content: "message A" }],
          })
        : record("record-b", {
            ocrText: "OCR B",
            ocrState: "ready",
            messages: [{ role: "user", content: "message B" }],
          }),
    );
    vi.mocked(captureClient.readImage).mockImplementation(async (id) =>
      id === "record-a" ? imageA.dataUrl : imageB.dataUrl,
    );

    const { rerender, unmount } = render(
      <ChatPanel recordId="record-a" initialImage={imageA} onImageInput={vi.fn()} />,
    );
    await screen.findByText("message A");

    rerender(
      <ChatPanel recordId="record-b" initialImage={imageB} onImageInput={vi.fn()} />,
    );
    await screen.findByText("message B");
    expect(screen.queryByText("message A")).not.toBeInTheDocument();

    unmount();
    render(<ChatPanel recordId="record-b" initialImage={imageB} onImageInput={vi.fn()} />);
    await screen.findByText("message B");

    const writesToB = vi.mocked(captureClient.update).mock.calls.filter(([id]) => id === "record-b");
    expect(writesToB.some(([, patch]) =>
      patch.messages?.some((message) => message.content === "message A"),
    )).toBe(false);
    expect(writesToB.some(([, patch]) => patch.messages?.length === 0)).toBe(false);
  });

  it("hands a new screenshot to the owner instead of replacing the current record image", async () => {
    vi.mocked(captureClient.get).mockResolvedValue(record("record-a", {
      ocrText: "OCR A",
      ocrState: "ready",
    }));
    vi.mocked(captureClient.readImage).mockResolvedValue(imageA.dataUrl);
    vi.mocked(captureScreenRegion).mockResolvedValue(imageB);
    const onImageInput = vi.fn().mockResolvedValue(undefined);

    render(<ChatPanel recordId="record-a" initialImage={imageA} onImageInput={onImageInput} />);
    await screen.findByText("OCR A");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "截图" }));
    });

    expect(onImageInput).toHaveBeenCalledWith(imageB, "capture");
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "recognize_text_from_image_data_url"),
    ).toHaveLength(0);
    await waitFor(() => expect(screen.getByText("OCR A")).toBeInTheDocument());
  });

  it("routes paste, drop, and file selection through new capture records", async () => {
    vi.mocked(captureClient.get).mockResolvedValue(record("record-a", {
      ocrText: "OCR A",
      ocrState: "ready",
    }));
    vi.mocked(captureClient.readImage).mockResolvedValue(imageA.dataUrl);
    vi.mocked(readClipboardImage).mockResolvedValue(imageB);
    vi.mocked(readFileAsDataUrl).mockResolvedValue(imageB);
    const onImageInput = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <ChatPanel recordId="record-a" initialImage={imageA} onImageInput={onImageInput} />,
    );
    await screen.findByText("OCR A");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "换图" }));
      const input = container.querySelector<HTMLInputElement>('input[type="file"]');
      fireEvent.change(input!, {
        target: { files: [new File(["file"], "picked.png", { type: "image/png" })] },
      });
    });
    await waitFor(() => expect(onImageInput).toHaveBeenCalledWith(imageB, "file"));

    await act(async () => {
      fireEvent.paste(window, { clipboardData: { items: [] } });
    });
    await waitFor(() => expect(onImageInput).toHaveBeenCalledWith(imageB, "paste"));

    const dropTarget = container.querySelector(".chat-panel__meta");
    await act(async () => {
      fireEvent.drop(dropTarget!, {
        dataTransfer: {
          files: [new File(["drop"], "dropped.png", { type: "image/png" })],
        },
      });
    });
    await waitFor(() => expect(onImageInput).toHaveBeenCalledWith(imageB, "drag"));

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "recognize_text_from_image_data_url"),
    ).toHaveLength(0);
  });

  it("saves message snapshots in order for the same record", async () => {
    vi.mocked(captureClient.get).mockResolvedValue(record("record-a", {
      ocrText: "OCR A",
      ocrState: "ready",
      messages: [{ role: "assistant", content: "existing answer" }],
    }));
    vi.mocked(captureClient.readImage).mockResolvedValue(imageA.dataUrl);

    let releaseFirstWrite: (() => void) | undefined;
    vi.mocked(captureClient.update).mockImplementation((_id, patch) => {
      if (patch.messages && !releaseFirstWrite) {
        return new Promise((resolve) => {
          releaseFirstWrite = () => resolve(null);
        });
      }
      return Promise.resolve(null);
    });

    render(<ChatPanel recordId="record-a" initialImage={imageA} onImageInput={vi.fn()} />);
    await screen.findByText("existing answer");
    await waitFor(() => {
      const messageWrites = vi.mocked(captureClient.update).mock.calls
        .filter(([, patch]) => patch.messages);
      expect(messageWrites).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    const writesBeforeRelease = vi.mocked(captureClient.update).mock.calls
      .filter(([, patch]) => patch.messages);
    expect(writesBeforeRelease).toHaveLength(1);

    await act(async () => {
      releaseFirstWrite?.();
    });
    await waitFor(() => {
      const messageWrites = vi.mocked(captureClient.update).mock.calls
        .filter(([, patch]) => patch.messages);
      expect(messageWrites).toHaveLength(2);
      expect(messageWrites[1][1].messages).toEqual([]);
    });
  });
});
