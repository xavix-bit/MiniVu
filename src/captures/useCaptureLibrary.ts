import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureClient } from "./captureClient";
import type {
  CaptureClient,
  CaptureRecord,
  CaptureRecordPatch,
  CreateCaptureInput,
} from "./types";

function newestFirst(records: CaptureRecord[]) {
  return [...records].sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function matchesQuery(record: CaptureRecord, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return `${record.title ?? ""}\n${record.ocrText}`.toLocaleLowerCase().includes(needle);
}

function cacheDetail(cache: Map<string, CaptureRecord>, record: CaptureRecord) {
  cache.delete(record.id);
  cache.set(record.id, record);
  while (cache.size > 4) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

export function useCaptureLibrary(api: CaptureClient = captureClient) {
  const [records, setRecords] = useState<CaptureRecord[]>([]);
  const [selected, setSelected] = useState<CaptureRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const selectionRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const selectedRef = useRef<CaptureRecord | null>(null);
  const detailCacheRef = useRef(new Map<string, CaptureRecord>());
  const detailRevisionRef = useRef(new Map<string, number>());

  const hydrate = useCallback(async (record: CaptureRecord) => {
    const [imageDataUrl, thumbnailDataUrl] = await Promise.all([
      record.imageDataUrl ? Promise.resolve(record.imageDataUrl) : api.readImage(record.id, false),
      record.thumbnailDataUrl ? Promise.resolve(record.thumbnailDataUrl) : api.readImage(record.id, true),
    ]);
    return { ...record, imageDataUrl, thumbnailDataUrl };
  }, [api]);

  const select = useCallback(async (id: string) => {
    const request = ++selectionRequestRef.current;
    const previous = selectedRef.current;
    const revision = detailRevisionRef.current.get(id) ?? 0;
    selectedIdRef.current = id;
    setSelectedId(id);
    const cached = detailCacheRef.current.get(id);
    if (cached) {
      selectedRef.current = cached;
      setSelected(cached);
    }
    try {
      const detail = await api.get(id);
      if (!detail) throw new Error("截图不存在");
      const hydrated = await hydrate(cached ? {
        ...detail,
        imageDataUrl: cached.imageDataUrl,
        thumbnailDataUrl: cached.thumbnailDataUrl,
      } : detail);
      if (selectionRequestRef.current !== request || selectedIdRef.current !== id) return;

      const latest = detailCacheRef.current.get(id);
      const next = (detailRevisionRef.current.get(id) ?? 0) === revision || !latest
        ? hydrated
        : { ...hydrated, ...latest };
      cacheDetail(detailCacheRef.current, next);
      selectedRef.current = next;
      setSelected(next);
      setError("");
    } catch (reason) {
      if (selectionRequestRef.current !== request || selectedIdRef.current !== id) return;
      selectedRef.current = previous;
      setSelected(previous);
      selectedIdRef.current = previous?.id ?? null;
      setSelectedId(previous?.id ?? null);
      setError("这张截图暂时打不开，请重试。");
    }
  }, [api, hydrate]);

  const refresh = useCallback(async (preferredId?: string) => {
    const request = ++refreshRequestRef.current;
    const previousSelected = selectedRef.current;
    const previousSelectedId = selectedIdRef.current;
    ++selectionRequestRef.current;
    if (preferredId) {
      selectedIdRef.current = preferredId;
      setSelectedId(preferredId);
    }
    setLoading(true);
    try {
      const listed = newestFirst(await api.list());
      const next = await Promise.all(listed.map(async (record) => ({
        ...record,
        thumbnailDataUrl: record.thumbnailDataUrl || await api.readImage(record.id, true),
      })));
      if (refreshRequestRef.current !== request) {
        return;
      }
      setRecords(next);
      setError("");

      const selectedId = selectedIdRef.current;
      const nextId = preferredId && next.some((item) => item.id === preferredId)
        ? preferredId
        : selectedId && next.some((item) => item.id === selectedId)
          ? selectedId
          : next[0]?.id;
      if (nextId) {
        await select(nextId);
      } else {
        ++selectionRequestRef.current;
        selectedIdRef.current = null;
        setSelectedId(null);
        selectedRef.current = null;
        setSelected(null);
      }
    } catch (reason) {
      if (refreshRequestRef.current === request) {
        setError("截图列表暂时无法更新，请稍后重试。");
        if (preferredId && selectedIdRef.current === preferredId) {
          selectedRef.current = previousSelected;
          setSelected(previousSelected);
          selectedIdRef.current = previousSelectedId;
          setSelectedId(previousSelectedId);
        }
      }
    } finally {
      if (refreshRequestRef.current === request) {
        setLoading(false);
      }
    }
  }, [api, select]);

  useEffect(() => {
    void refresh();
    let unsubscribe: (() => void) | undefined;
    void api.subscribe((event) => void refresh(event.action === "created" ? event.id : undefined)).then((cleanup) => {
      unsubscribe = cleanup;
    });
    return () => {
      ++selectionRequestRef.current;
      ++refreshRequestRef.current;
      unsubscribe?.();
    };
  }, [api, refresh]);

  const create = useCallback(async (input: CreateCaptureInput) => {
    const created = await api.create(input);
    const hydrated = await hydrate({ ...created, imageDataUrl: input.dataUrl });
    ++selectionRequestRef.current;
    selectedIdRef.current = hydrated.id;
    setSelectedId(hydrated.id);
    cacheDetail(detailCacheRef.current, hydrated);
    setRecords((current) => newestFirst([hydrated, ...current.filter((item) => item.id !== hydrated.id)]));
    selectedRef.current = hydrated;
    setSelected(hydrated);
    return hydrated;
  }, [api, hydrate]);

  const update = useCallback(async (id: string, patch: CaptureRecordPatch) => {
    const saved = await api.update(id, patch);
    if (!saved) {
      return;
    }
    detailRevisionRef.current.set(id, (detailRevisionRef.current.get(id) ?? 0) + 1);
    setRecords((current) => newestFirst(current.map((item) => item.id === id ? { ...item, ...saved } : item)));
    if (selectedRef.current?.id === id) {
      selectedRef.current = { ...selectedRef.current, ...saved };
      setSelected(selectedRef.current);
    }
    const cached = detailCacheRef.current.get(id);
    if (cached) cacheDetail(detailCacheRef.current, { ...cached, ...saved });
  }, [api]);

  const remove = useCallback(async (id: string) => {
    await api.remove(id);
    detailCacheRef.current.delete(id);
    detailRevisionRef.current.delete(id);
    if (selectedIdRef.current === id) {
      ++selectionRequestRef.current;
      selectedIdRef.current = null;
      setSelectedId(null);
      selectedRef.current = null;
      setSelected(null);
    }
    await refresh();
  }, [api, refresh]);

  const visibleRecords = useMemo(
    () => records.filter((record) => matchesQuery(record, query)),
    [query, records],
  );

  return {
    records,
    visibleRecords,
    selected,
    selectedId,
    query,
    setQuery,
    loading,
    error,
    select,
    create,
    update,
    remove,
    refresh,
  };
}

export type CaptureLibraryState = ReturnType<typeof useCaptureLibrary>;
