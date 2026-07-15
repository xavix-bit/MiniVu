import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaptureRecord } from "../src/captures/types";
import type { CaptureLibraryState } from "../src/captures/useCaptureLibrary";
import { WorkbenchView } from "../src/workbench/WorkbenchShell";

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "one",
    source: "capture",
    title: "登录页",
    ocrText: "欢迎回来",
    ocrState: "ready",
    messages: [],
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    expiresAtMs: Date.now() + 86_400_000,
    pinned: false,
    imageDataUrl: "data:image/png;base64,a",
    thumbnailDataUrl: "data:image/jpeg;base64,a",
    ...overrides,
  };
}

function library(records: CaptureRecord[] = []): CaptureLibraryState {
  return {
    records,
    visibleRecords: records,
    selected: records[0] ?? null,
    query: "",
    setQuery: vi.fn(),
    loading: false,
    error: "",
    select: vi.fn(async () => {}),
    create: vi.fn(async () => records[0]),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  } as CaptureLibraryState;
}

describe("WorkbenchView", () => {
  it("shows a capture-first empty state without readiness cards", () => {
    render(<WorkbenchView library={library()} onOpenSettings={vi.fn()} onCapture={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "还没有截图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "截图" })).toBeInTheDocument();
    expect(screen.queryByText(/Metal|运行时|模型就绪/)).not.toBeInTheDocument();
  });

  it("filters pinned records and switches between AI and recognized text", () => {
    const first = record();
    const pinned = record({ id: "two", title: "固定截图", pinned: true });
    const api = library([first, pinned]);
    render(<WorkbenchView library={api} onOpenSettings={vi.fn()} onCapture={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "固定" }));
    expect(screen.getByRole("listitem", { name: /固定截图/ })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: /登录页/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "文字" }));
    expect(screen.getByText("欢迎回来")).toBeInTheDocument();
  });

  it("keeps one AI composer and persists the answer to the selected record", async () => {
    const api = library([record()]);
    const ask = vi.fn(async () => "这是一个登录界面。" );
    render(
      <WorkbenchView
        library={api}
        onOpenSettings={vi.fn()}
        onCapture={vi.fn()}
        onAsk={ask}
      />,
    );

    expect(screen.queryByRole("button", { name: "翻译" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "帮我看懂" }));

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "这是一个登录界面。" }),
      ]) }),
    ));
  });
});
