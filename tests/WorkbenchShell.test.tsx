import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    selectedId: records[0]?.id ?? null,
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
    render(<WorkbenchView library={library()} scope="recent" onCapture={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "还没有截图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "截图" })).toBeInTheDocument();
    expect(screen.queryByText(/Metal|运行时|模型就绪/)).not.toBeInTheDocument();
  });

  it("filters pinned records and switches between AI and recognized text", async () => {
    const first = record();
    const pinned = record({ id: "two", title: "固定截图", pinned: true });
    const api = library([first, pinned]);
    const view = render(<WorkbenchView library={api} scope="recent" onCapture={vi.fn()} />);

    view.rerender(<WorkbenchView library={api} scope="pinned" onCapture={vi.fn()} />);
    expect(screen.getByRole("listitem", { name: /固定截图/ })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: /登录页/ })).not.toBeInTheDocument();
    await waitFor(() => expect(api.select).toHaveBeenCalledWith(pinned.id));

    api.selected = pinned;
    view.rerender(<WorkbenchView library={api} scope="pinned" onCapture={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "文字" }));
    expect(screen.getByText("欢迎回来")).toBeInTheDocument();
  });

  it("keeps one AI composer and persists the answer to the selected record", async () => {
    const api = library([record()]);
    const ask = vi.fn(async () => "这是一个登录界面。" );
    render(
      <WorkbenchView
        library={api}
        scope="recent"
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

  it("switches inspector tabs with the arrow keys", async () => {
    render(<WorkbenchView library={library([record()])} scope="recent" onCapture={vi.fn()} />);

    const aiTab = screen.getByRole("tab", { name: "AI" });
    aiTab.focus();
    fireEvent.keyDown(aiTab, { key: "ArrowRight" });

    const textTab = screen.getByRole("tab", { name: "文字" });
    await waitFor(() => expect(textTab).toHaveFocus());
    expect(textTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "文字" })).toBeVisible();

    fireEvent.keyDown(textTab, { key: "ArrowRight" });
    await waitFor(() => expect(aiTab).toHaveFocus());
    expect(aiTab).toHaveAttribute("aria-selected", "true");
  });

  it("makes the previous detail inert while another screenshot loads", () => {
    const first = record({ id: "one" });
    const second = record({ id: "two" });
    const api = library([first, second]);
    api.selected = first;
    api.selectedId = second.id;

    const { container } = render(
      <WorkbenchView library={api} scope="recent" onCapture={vi.fn()} />,
    );

    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("正在载入");
    expect(container.querySelector(".workbench-detail__selection")).toHaveAttribute("inert");
  });

  it("cancels only the active request for the selected record", async () => {
    let finishAsk: ((answer: string) => void) | undefined;
    const ask = vi.fn((_record, _prompt, _requestId, _onChunk) => (
      new Promise<string>((resolve) => { finishAsk = resolve; })
    ));
    const cancel = vi.fn(async () => {});
    const api = library([record()]);
    render(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        onAsk={ask}
        onCancel={cancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "帮我看懂" }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    const requestId = ask.mock.calls[0][2];
    expect(requestId).toEqual(expect.any(String));

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(cancel).toHaveBeenCalledWith(requestId);

    finishAsk?.("");
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument());
  });

  it("hydrates the first visible record when filtering hides the selection", async () => {
    const current = record({ id: "current", title: "当前截图" });
    const summary = record({
      id: "search-result",
      title: "搜索结果",
      imageDataUrl: undefined,
    });
    const api = library([current, summary]);
    api.visibleRecords = [summary];

    render(<WorkbenchView library={api} scope="recent" onCapture={vi.fn()} />);

    await waitFor(() => expect(api.select).toHaveBeenCalledWith(summary.id));
    expect(within(screen.getByRole("main")).queryByText("搜索结果")).not.toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText("正在载入截图")).toBeInTheDocument();
  });

  it("requalifies the same fallback record across rapid scope changes", async () => {
    const sharedFallback = record({ id: "shared", pinned: true });
    const api = library([sharedFallback, record({ id: "recent-only", pinned: false })]);
    api.selected = null;
    api.selectedId = null;

    const view = render(<WorkbenchView library={api} scope="recent" onCapture={vi.fn()} />);
    await waitFor(() => expect(api.select).toHaveBeenCalledTimes(1));

    view.rerender(<WorkbenchView library={api} scope="pinned" onCapture={vi.fn()} />);
    await waitFor(() => expect(api.select).toHaveBeenCalledTimes(2));

    view.rerender(<WorkbenchView library={api} scope="recent" onCapture={vi.fn()} />);
    await waitFor(() => expect(api.select).toHaveBeenCalledTimes(3));
    expect(api.select).toHaveBeenNthCalledWith(1, sharedFallback.id);
    expect(api.select).toHaveBeenNthCalledWith(2, sharedFallback.id);
    expect(api.select).toHaveBeenNthCalledWith(3, sharedFallback.id);
  });
});
