import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CaptureClient, CaptureRecord } from "../src/captures/types";
import { useCaptureLibrary, type CaptureLibraryState } from "../src/captures/useCaptureLibrary";
import { WorkbenchShell, WorkbenchView } from "../src/workbench/WorkbenchShell";

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

function modelAvailableProps() {
  return {
    modelReady: true,
    onRequireModel: vi.fn(async () => true),
    showTips: false,
    onTipsComplete: vi.fn(),
  };
}

function RealLibraryHarness({ api, scope }: { api: CaptureClient; scope: "recent" | "pinned" }) {
  const state = useCaptureLibrary(api);
  return (
    <WorkbenchView
      library={state}
      scope={scope}
      onCapture={vi.fn()}
      {...modelAvailableProps()}
    />
  );
}

describe("WorkbenchView", () => {
  it("refreshes once and selects a newly requested record", async () => {
    const current = record({ id: "current", title: "当前截图", createdAtMs: 200 });
    const requested = record({ id: "requested", title: "首张截图", createdAtMs: 100 });
    const api: CaptureClient = {
      list: vi.fn(async () => [current, requested]),
      get: vi.fn(async (id) => id === requested.id ? requested : current),
      readImage: vi.fn(async () => "data:image/png;base64,image"),
      create: vi.fn(async () => requested),
      update: vi.fn(async () => requested),
      remove: vi.fn(async () => {}),
      cleanup: vi.fn(async () => 0),
      subscribe: vi.fn(async () => () => {}),
    };
    const view = render(
      <WorkbenchShell
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
        requestedRecordId={null}
        captureApi={api}
      />,
    );
    await within(screen.getByRole("main")).findByText("当前截图");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索截图" }), {
      target: { value: "当前" },
    });
    const callsBeforeRequest = vi.mocked(api.list).mock.calls.length;

    view.rerender(
      <WorkbenchShell
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
        requestedRecordId={requested.id}
        captureApi={api}
      />,
    );

    await waitFor(() => expect(within(screen.getByRole("main")).getByText("首张截图")).toBeVisible());
    expect(screen.getByRole("textbox", { name: "搜索截图" })).toHaveValue("");
    expect(vi.mocked(api.list)).toHaveBeenCalledTimes(callsBeforeRequest + 1);
    expect(api.get).toHaveBeenLastCalledWith(requested.id);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索截图" }), {
      target: { value: "当前" },
    });
    view.rerender(
      <WorkbenchShell
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
        requestedRecordId={requested.id}
        requestedDraft={{ recordId: requested.id, prompt: "继续解释" }}
        captureApi={api}
      />,
    );

    await waitFor(() => expect(screen.getByRole("textbox", { name: "搜索截图" })).toHaveValue(""));
    expect(within(screen.getByRole("main")).getByText("首张截图")).toBeVisible();
  });

  it("shows a capture-first empty state without readiness cards", () => {
    render(
      <WorkbenchView
        library={library()}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );

    expect(screen.getByRole("heading", { name: "还没有截图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "截图" })).toBeInTheDocument();
    expect(screen.queryByText(/Metal|运行时|模型就绪/)).not.toBeInTheDocument();
  });

  it("filters pinned records and switches between AI and recognized text", async () => {
    const first = record();
    const pinned = record({ id: "two", title: "固定截图", pinned: true });
    const api = library([first, pinned]);
    const view = render(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );

    view.rerender(
      <WorkbenchView
        library={api}
        scope="pinned"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );
    expect(screen.getByRole("listitem", { name: /固定截图/ })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: /登录页/ })).not.toBeInTheDocument();
    await waitFor(() => expect(api.select).toHaveBeenCalledWith(pinned.id));

    api.selected = pinned;
    view.rerender(
      <WorkbenchView
        library={api}
        scope="pinned"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );

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
        {...modelAvailableProps()}
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

  it("keeps the draft and requests a model before writing any AI message", async () => {
    const api = library([record()]);
    const ask = vi.fn(async () => "不应发送");
    const requireModel = vi.fn(async () => false);
    render(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        modelReady={false}
        onRequireModel={requireModel}
        onAsk={ask}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("问这张截图…"), {
      target: { value: "解释这个错误" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(requireModel).toHaveBeenCalledWith({
      recordId: "one",
      prompt: "解释这个错误",
    }));
    expect(ask).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("解释这个错误")).toBeVisible();
  });

  it("shows one pending model check and prevents duplicate submits", async () => {
    let finishCheck: ((ready: boolean) => void) | undefined;
    const requireModel = vi.fn(() => new Promise<boolean>((resolve) => {
      finishCheck = resolve;
    }));
    render(
      <WorkbenchView
        library={library([record()])}
        scope="recent"
        onCapture={vi.fn()}
        modelReady={false}
        onRequireModel={requireModel}
        showTips={false}
        onTipsComplete={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("问这张截图…"), {
      target: { value: "解释这个错误" },
    });
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.click(send);

    await waitFor(() => expect(requireModel).toHaveBeenCalledOnce());
    expect(send).toBeDisabled();
    expect(send.closest(".capture-inspector__composer")).toHaveAttribute("aria-busy", "true");
    fireEvent.click(send);
    expect(requireModel).toHaveBeenCalledOnce();

    await act(async () => finishCheck?.(false));
    await waitFor(() => expect(send).toBeEnabled());
    expect(screen.getByDisplayValue("解释这个错误")).toBeVisible();
  });

  it("continues the same submit when the readiness check finds an installed model", async () => {
    const api = library([record()]);
    const ask = vi.fn(async () => "已经可以使用");
    const requireModel = vi.fn(async () => true);
    render(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        modelReady={false}
        onRequireModel={requireModel}
        showTips={false}
        onTipsComplete={vi.fn()}
        onAsk={ask}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("问这张截图…"), {
      target: { value: "解释这个错误" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(requireModel).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][1]).toBe("解释这个错误");
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "已经可以使用" }),
      ]) }),
    ));
  });

  it("keeps text typed during a readiness check as the next draft", async () => {
    let finishCheck: ((ready: boolean) => void) | undefined;
    const requireModel = vi.fn(() => new Promise<boolean>((resolve) => {
      finishCheck = resolve;
    }));
    const ask = vi.fn(async () => "已经可以使用");
    render(
      <WorkbenchView
        library={library([record()])}
        scope="recent"
        onCapture={vi.fn()}
        modelReady={false}
        onRequireModel={requireModel}
        showTips={false}
        onTipsComplete={vi.fn()}
        onAsk={ask}
      />,
    );

    const composer = screen.getByPlaceholderText("问这张截图…");
    fireEvent.change(composer, { target: { value: "解释这个错误" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(requireModel).toHaveBeenCalledOnce());
    fireEvent.change(composer, { target: { value: "顺便告诉我怎么修" } });

    await act(async () => finishCheck?.(true));

    await waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(ask.mock.calls[0][1]).toBe("解释这个错误");
    expect(composer).toHaveValue("顺便告诉我怎么修");
  });

  it("reveals two dismissible tips only after recognized text is ready", async () => {
    const pending = record({ ocrState: "pending", ocrText: "" });
    const api = library([pending]);
    const tipsComplete = vi.fn();
    const view = render(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
        showTips
        onTipsComplete={tipsComplete}
      />,
    );

    expect(screen.queryByText("识别出的文字在这里")).not.toBeInTheDocument();

    const ready = record({ ocrState: "ready", ocrText: "欢迎回来" });
    api.records = [ready];
    api.visibleRecords = [ready];
    api.selected = ready;
    api.selectedId = ready.id;
    view.rerender(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
        showTips
        onTipsComplete={tipsComplete}
      />,
    );

    expect(screen.getByText("识别出的文字在这里")).toBeVisible();
    expect(screen.getByRole("tab", { name: "文字" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.queryByText("识别出的文字在这里")).not.toBeInTheDocument();
    expect(screen.getByText("也可以直接问这张截图")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));

    expect(tipsComplete).toHaveBeenCalledOnce();
  });

  it("switches inspector tabs with the arrow keys", async () => {
    render(
      <WorkbenchView
        library={library([record()])}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );

    const aiTab = screen.getByRole("tab", { name: "问图" });
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
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
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
        {...modelAvailableProps()}
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

    render(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );

    await waitFor(() => expect(api.select).toHaveBeenCalledWith(summary.id));
    expect(within(screen.getByRole("main")).queryByText("搜索结果")).not.toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText("正在载入截图")).toBeInTheDocument();
  });

  it("requalifies the same fallback record across rapid scope changes", async () => {
    const sharedFallback = record({ id: "shared", pinned: true });
    const api = library([sharedFallback, record({ id: "recent-only", pinned: false })]);
    api.selected = null;
    api.selectedId = null;

    const view = render(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );
    await waitFor(() => expect(api.select).toHaveBeenCalledTimes(1));

    view.rerender(
      <WorkbenchView
        library={api}
        scope="pinned"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );
    await waitFor(() => expect(api.select).toHaveBeenCalledTimes(2));

    view.rerender(
      <WorkbenchView
        library={api}
        scope="recent"
        onCapture={vi.fn()}
        {...modelAvailableProps()}
      />,
    );
    await waitFor(() => expect(api.select).toHaveBeenCalledTimes(3));
    expect(api.select).toHaveBeenNthCalledWith(1, sharedFallback.id);
    expect(api.select).toHaveBeenNthCalledWith(2, sharedFallback.id);
    expect(api.select).toHaveBeenNthCalledWith(3, sharedFallback.id);
  });

  it("supersedes a deferred pinned fallback when returning to recent", async () => {
    const recent = record({ id: "recent", title: "最近截图", createdAtMs: 200 });
    const pinned = record({ id: "pinned", title: "固定截图", createdAtMs: 100, pinned: true });
    let resolvePinned: ((value: CaptureRecord | null) => void) | undefined;
    const api: CaptureClient = {
      list: vi.fn(async () => [recent, pinned]),
      get: vi.fn((id) => id === pinned.id
        ? new Promise((resolve) => { resolvePinned = resolve; })
        : Promise.resolve(recent)),
      readImage: vi.fn(async () => ""),
      create: vi.fn(async () => recent),
      update: vi.fn(async () => recent),
      remove: vi.fn(async () => {}),
      cleanup: vi.fn(async () => 0),
      subscribe: vi.fn(async () => () => {}),
    };

    const view = render(<RealLibraryHarness api={api} scope="recent" />);
    await waitFor(() => expect(within(screen.getByRole("main")).getByText("最近截图")).toBeInTheDocument());

    view.rerender(<RealLibraryHarness api={api} scope="pinned" />);
    await waitFor(() => expect(resolvePinned).toBeDefined());

    view.rerender(<RealLibraryHarness api={api} scope="recent" />);
    await act(async () => resolvePinned?.(pinned));

    await waitFor(() => expect(within(screen.getByRole("main")).getByText("最近截图")).toBeInTheDocument());
    expect(within(screen.getByRole("main")).queryByText("固定截图")).not.toBeInTheDocument();
  });
});
