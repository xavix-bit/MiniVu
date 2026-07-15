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

export function useCaptureLibrary(api: CaptureClient = captureClient) {
  const [records, setRecords] = useState<CaptureRecord[]>([]);
  const [selected, setSelected] = useState<CaptureRecord | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const selectionRequestRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
  }, [selected?.id]);

  const hydrate = useCallback(async (record: CaptureRecord) => {
    const [imageDataUrl, thumbnailDataUrl] = await Promise.all([
      record.imageDataUrl ? Promise.resolve(record.imageDataUrl) : api.readImage(record.id, false),
      record.thumbnailDataUrl ? Promise.resolve(record.thumbnailDataUrl) : api.readImage(record.id, true),
    ]);
    return { ...record, imageDataUrl, thumbnailDataUrl };
  }, [api]);

  const select = useCallback(async (id: string) => {
    const request = ++selectionRequestRef.current;
    selectedIdRef.current = id;
    const detail = await api.get(id);
    if (!detail) {
      return;
    }
    const hydrated = await hydrate(detail);
    if (selectionRequestRef.current === request && selectedIdRef.current === id) {
      setSelected(hydrated);
    }
  }, [api, hydrate]);

  const refresh = useCallback(async (preferredId?: string) => {
    const request = ++refreshRequestRef.current;
    ++selectionRequestRef.current;
    if (preferredId) {
      selectedIdRef.current = preferredId;
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
        setSelected(null);
      }
    } catch (reason) {
      if (refreshRequestRef.current === request) {
        setError(String(reason));
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
    setRecords((current) => newestFirst([hydrated, ...current.filter((item) => item.id !== hydrated.id)]));
    setSelected(hydrated);
    return hydrated;
  }, [api, hydrate]);

  const update = useCallback(async (id: string, patch: CaptureRecordPatch) => {
    const saved = await api.update(id, patch);
    if (!saved) {
      return;
    }
    setRecords((current) => newestFirst(current.map((item) => item.id === id ? { ...item, ...saved } : item)));
    setSelected((current) => current?.id === id ? { ...current, ...saved } : current);
  }, [api]);

  const remove = useCallback(async (id: string) => {
    await api.remove(id);
    if (selectedIdRef.current === id) {
      ++selectionRequestRef.current;
      selectedIdRef.current = null;
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
