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
