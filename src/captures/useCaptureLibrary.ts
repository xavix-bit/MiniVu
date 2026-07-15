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
    const detail = await api.get(id);
    if (!detail) {
      return;
    }
    const hydrated = await hydrate(detail);
    if (selectionRequestRef.current === request) {
      setSelected(hydrated);
    }
  }, [api, hydrate]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = newestFirst(await api.list());
      setRecords(next);
      setError("");

      const selectedId = selectedIdRef.current;
      const nextId = selectedId && next.some((item) => item.id === selectedId)
        ? selectedId
        : next[0]?.id;
      if (nextId) {
        void select(nextId);
      } else {
        ++selectionRequestRef.current;
        setSelected(null);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [api, select]);

  useEffect(() => {
    void refresh();
    let unsubscribe: (() => void) | undefined;
    void api.subscribe(() => void refresh()).then((cleanup) => {
      unsubscribe = cleanup;
    });
    return () => {
      ++selectionRequestRef.current;
      unsubscribe?.();
    };
  }, [api, refresh]);

  const create = useCallback(async (input: CreateCaptureInput) => {
    const created = await api.create(input);
    const hydrated = await hydrate({ ...created, imageDataUrl: input.dataUrl });
    ++selectionRequestRef.current;
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
    setRecords((current) => {
      const next = current.filter((item) => item.id !== id);
      setSelected((active) => {
        if (active?.id !== id) {
          return active;
        }
        ++selectionRequestRef.current;
        const fallback = next[0] ?? null;
        if (fallback) {
          void select(fallback.id);
        }
        return fallback;
      });
      return next;
    });
  }, [api, select]);

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
