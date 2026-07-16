import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CaptureClient,
  CaptureRecord,
  CaptureRecordChanged,
  CaptureRecordPatch,
  CreateCaptureInput,
} from "../src/captures/types";
import { useCaptureLibrary } from "../src/captures/useCaptureLibrary";

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "capture-a",
    source: "capture",
    title: null,
    ocrText: "发票总额 128 元",
    ocrState: "ready",
    messages: [],
    createdAtMs: 100,
    updatedAtMs: 100,
    expiresAtMs: 86_400_100,
    pinned: false,
    imageDataUrl: "data:image/png;base64,a",
    thumbnailDataUrl: "data:image/jpeg;base64,a",
    ...overrides,
  };
}

function client(initial: CaptureRecord[]): CaptureClient {
  let records = [...initial];
  return {
    list: vi.fn(async () => [...records].sort((a, b) => b.createdAtMs - a.createdAtMs)),
    get: vi.fn(async (id) => records.find((item) => item.id === id) ?? null),
    readImage: vi.fn(async (id, thumbnail) => {
      const item = records.find((entry) => entry.id === id);
      return thumbnail ? item?.thumbnailDataUrl ?? "" : item?.imageDataUrl ?? "";
    }),
    create: vi.fn(async (input: CreateCaptureInput) => {
      const next = record({
        id: `capture-${records.length + 1}`,
        source: input.source,
        imageDataUrl: input.dataUrl,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      records = [next, ...records];
      return next;
    }),
    update: vi.fn(async (id: string, patch: CaptureRecordPatch) => {
      records = records.map((item) => item.id === id ? { ...item, ...patch } : item);
      return records.find((item) => item.id === id) ?? null;
    }),
    remove: vi.fn(async (id) => {
      records = records.filter((item) => item.id !== id);
    }),
    cleanup: vi.fn(async () => 0),
    subscribe: vi.fn(async () => () => {}),
  };
}

describe("useCaptureLibrary", () => {
  it("loads newest first and searches title plus OCR text", async () => {
    const api = client([
      record({ id: "old", title: "订单", createdAtMs: 10 }),
      record({ id: "new", ocrText: "会议纪要", createdAtMs: 20 }),
    ]);
    const { result } = renderHook(() => useCaptureLibrary(api));

    await waitFor(() => expect(result.current.records.map((item) => item.id)).toEqual(["new", "old"]));
    expect(result.current.selected?.id).toBe("new");

    act(() => result.current.setQuery("  订单 "));
    expect(result.current.visibleRecords.map((item) => item.id)).toEqual(["old"]);

    act(() => result.current.setQuery("会议"));
    expect(result.current.visibleRecords.map((item) => item.id)).toEqual(["new"]);
  });

  it("keeps record conversations isolated while switching selection", async () => {
    const api = client([
      record({ id: "a", messages: [{ role: "assistant", content: "A" }] }),
      record({ id: "b", messages: [{ role: "assistant", content: "B" }], createdAtMs: 90 }),
    ]);
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));

    await act(async () => result.current.select("b"));
    expect(result.current.selected?.messages).toEqual([{ role: "assistant", content: "B" }]);

    await act(async () => result.current.select("a"));
    expect(result.current.selected?.messages).toEqual([{ role: "assistant", content: "A" }]);
  });

  it("updates the highlighted selection before its full image finishes loading", async () => {
    let resolveB: ((value: CaptureRecord | null) => void) | undefined;
    const a = record({ id: "a" });
    const b = record({ id: "b", createdAtMs: 90 });
    const api = client([a, b]);
    api.get = vi.fn((id) => id === "b"
      ? new Promise((resolve) => { resolveB = resolve; })
      : Promise.resolve(a));
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.select("b");
    });
    expect(result.current.selectedId).toBe("b");
    expect(result.current.selected?.id).toBe("a");

    resolveB?.(b);
    await act(async () => pending);
    expect(result.current.selected?.id).toBe("b");
  });

  it("rolls back the highlight when a detail cannot be loaded", async () => {
    const a = record({ id: "a" });
    const b = record({ id: "b", createdAtMs: 90 });
    const api = client([a, b]);
    api.get = vi.fn((id) => Promise.resolve(id === "a" ? a : null));
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));

    await act(async () => result.current.select("b"));

    expect(result.current.selectedId).toBe("a");
    expect(result.current.selected?.id).toBe("a");
    expect(result.current.error).toBe("这张截图暂时打不开，请重试。");
  });

  it("rolls back the highlight when reading a detail rejects", async () => {
    const a = record({ id: "a" });
    const b = record({ id: "b", createdAtMs: 90 });
    const api = client([a, b]);
    api.get = vi.fn((id) => id === "a" ? Promise.resolve(a) : Promise.reject(new Error("读取失败")));
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));

    await act(async () => result.current.select("b"));

    expect(result.current.selectedId).toBe("a");
    expect(result.current.selected?.id).toBe("a");
    expect(result.current.error).toBe("这张截图暂时打不开，请重试。");
  });

  it("does not let a delayed detail overwrite a newer record update", async () => {
    let resolveStale: ((value: CaptureRecord | null) => void) | undefined;
    let reads = 0;
    const a = record({ id: "a", pinned: false });
    const api = client([a]);
    api.get = vi.fn(() => {
      reads += 1;
      return reads === 1
        ? Promise.resolve(a)
        : new Promise((resolve) => { resolveStale = resolve; });
    });
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.select("a");
    });
    await act(async () => result.current.update("a", { pinned: true }));
    resolveStale?.(a);
    await act(async () => pending);

    expect(result.current.selected?.pinned).toBe(true);
  });

  it("restores the previous selection when a preferred refresh fails", async () => {
    const a = record({ id: "a" });
    const api = client([a]);
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));
    api.list = vi.fn(async () => { throw new Error("刷新失败"); });

    await act(async () => result.current.refresh("new-capture"));

    expect(result.current.selectedId).toBe("a");
    expect(result.current.selected?.id).toBe("a");
  });

  it("restores a transient preferred record that is absent from the saved list", async () => {
    const saved = record({ id: "saved", createdAtMs: 100 });
    const transient = record({
      id: "transient",
      createdAtMs: 200,
      expiresAtMs: null,
      imageDataUrl: undefined,
      thumbnailDataUrl: undefined,
    });
    const api = client([saved]);
    api.get = vi.fn(async (id) => id === transient.id ? transient : saved);
    api.readImage = vi.fn(async (id, thumbnail) => (
      `data:image/${thumbnail ? "jpeg" : "png"};base64,${id}`
    ));
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe(saved.id));

    await act(async () => result.current.refresh(transient.id));

    expect(result.current.records.map((item) => item.id)).toEqual([transient.id, saved.id]);
    expect(result.current.selected?.id).toBe(transient.id);
    expect(result.current.selected?.imageDataUrl).toBe(
      `data:image/png;base64,${transient.id}`,
    );
  });

  it("keeps a transient record selected after it is updated", async () => {
    const saved = record({ id: "saved", createdAtMs: 100 });
    const transient = record({ id: "transient", createdAtMs: 200, expiresAtMs: null });
    let onChange: ((event: CaptureRecordChanged) => void) | undefined;
    const api = client([saved]);
    api.get = vi.fn(async (id) => id === transient.id ? transient : saved);
    api.subscribe = vi.fn(async (callback) => {
      onChange = callback;
      return () => {};
    });
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(onChange).toBeDefined());
    await act(async () => result.current.refresh(transient.id));
    expect(result.current.selected?.id).toBe(transient.id);

    act(() => onChange?.({ action: "updated", id: transient.id, summary: transient }));

    await waitFor(() => expect(result.current.selected?.id).toBe(transient.id));
    expect(result.current.records.map((item) => item.id)).toContain(transient.id);
  });

  it("does not change selection when another transient record is updated", async () => {
    const saved = record({ id: "saved", createdAtMs: 100 });
    const transient = record({ id: "transient", createdAtMs: 200, expiresAtMs: null });
    let onChange: ((event: CaptureRecordChanged) => void) | undefined;
    const api = client([saved]);
    api.get = vi.fn(async (id) => id === transient.id ? transient : saved);
    api.subscribe = vi.fn(async (callback) => {
      onChange = callback;
      return () => {};
    });
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(onChange).toBeDefined());
    await act(async () => result.current.refresh(transient.id));
    await act(async () => result.current.select(saved.id));
    expect(result.current.selected?.id).toBe(saved.id);

    act(() => onChange?.({ action: "updated", id: transient.id, summary: transient }));

    await waitFor(() => expect(result.current.records.map((item) => item.id)).toContain(transient.id));
    expect(result.current.selected?.id).toBe(saved.id);
  });

  it("leaves a cached record when the source reports it was deleted", async () => {
    const a = record({ id: "a" });
    const b = record({ id: "b", createdAtMs: 90 });
    const api = client([a, b]);
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));
    await act(async () => result.current.select("b"));
    await act(async () => result.current.select("a"));
    api.get = vi.fn(async (id) => id === "b" ? null : a);

    await act(async () => result.current.select("b"));

    expect(result.current.selectedId).toBe("a");
    expect(result.current.selected?.id).toBe("a");
  });

  it("pins and deletes records without losing a valid selection", async () => {
    const api = client([record({ id: "a" }), record({ id: "b", createdAtMs: 90 })]);
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe("a"));

    await act(async () => result.current.update("a", { pinned: true }));
    expect(result.current.selected?.pinned).toBe(true);

    await act(async () => result.current.remove("a"));
    expect(result.current.records.map((item) => item.id)).toEqual(["b"]);
    expect(result.current.selected?.id).toBe("b");
  });

  it("ignores a stale detail response after a newer selection", async () => {
    let resolveA: ((value: CaptureRecord | null) => void) | undefined;
    const a = record({ id: "a" });
    const b = record({ id: "b", createdAtMs: 90 });
    const api = client([a, b]);
    api.get = vi.fn((id) => {
      if (id === "a") {
        return new Promise((resolve) => { resolveA = resolve; });
      }
      return Promise.resolve(b);
    });
    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.records).toHaveLength(2));

    await act(async () => result.current.select("b"));
    act(() => resolveA?.(a));
    await waitFor(() => expect(result.current.selected?.id).toBe("b"));
  });

  it("selects and hydrates a record created by another webview", async () => {
    const existing = record({ id: "existing", createdAtMs: 100 });
    const created = record({
      id: "created-elsewhere",
      createdAtMs: 200,
      imageDataUrl: undefined,
      thumbnailDataUrl: undefined,
    });
    let listed = [existing];
    let onChange: ((event: CaptureRecordChanged) => void) | undefined;
    const api = client(listed);
    api.list = vi.fn(async () => listed);
    api.get = vi.fn(async (id) => id === created.id ? created : existing);
    api.readImage = vi.fn(async (id, thumbnail) => (
      `data:image/${thumbnail ? "jpeg" : "png"};base64,${id}`
    ));
    api.subscribe = vi.fn(async (callback) => {
      onChange = callback;
      return () => {};
    });

    const { result } = renderHook(() => useCaptureLibrary(api));
    await waitFor(() => expect(result.current.selected?.id).toBe(existing.id));
    await waitFor(() => expect(onChange).toBeDefined());

    listed = [created, existing];
    act(() => onChange?.({ action: "created", id: created.id, summary: created }));

    await waitFor(() => expect(result.current.selected?.id).toBe(created.id));
    expect(result.current.selected?.imageDataUrl).toBe(
      `data:image/png;base64,${created.id}`,
    );
  });
});
