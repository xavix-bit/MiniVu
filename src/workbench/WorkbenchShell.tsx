import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Camera, LoaderCircle, Pin, Trash2 } from "lucide-react";
import { modelClient } from "../model/modelClient";
import type { CaptureClient, CaptureMessage, CaptureRecord } from "../captures/types";
import { useCaptureLibrary, type CaptureLibraryState } from "../captures/useCaptureLibrary";
import { CaptureCanvas } from "./CaptureCanvas";
import { CaptureInspector } from "./CaptureInspector";
import { CaptureList } from "./CaptureList";

type WorkbenchViewProps = {
  library: CaptureLibraryState;
  scope: "recent" | "pinned";
  onCapture: () => void;
  modelReady: boolean;
  onRequireModel: (context: {
    recordId: string;
    prompt: string;
  }) => boolean | Promise<boolean>;
  showTips: boolean;
  onTipsComplete: () => void;
  onAsk?: (
    record: CaptureRecord,
    prompt: string,
    requestId: string,
    onChunk: (text: string) => void,
  ) => Promise<string>;
  onCancel?: (requestId: string) => Promise<void>;
};

async function askModel(
  record: CaptureRecord,
  prompt: string,
  requestId: string,
  onChunk: (text: string) => void,
) {
  let answer = "";
  await modelClient.askImage({
    recordId: record.id,
    requestId,
    imageDataUrl: record.imageDataUrl ?? "",
    ocrText: record.ocrText,
    prompt,
    history: record.messages,
  }, (chunk) => {
    if (chunk.text) {
      answer += chunk.text;
      onChunk(answer);
    }
  });
  return answer.trim();
}

export function WorkbenchView({
  library,
  scope,
  onCapture,
  modelReady,
  onRequireModel,
  showTips,
  onTipsComplete,
  onAsk = askModel,
  onCancel = (requestId) => modelClient.cancelGeneration(requestId),
}: WorkbenchViewProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [activeRequestIds, setActiveRequestIds] = useState<Record<string, string>>({});
  const [checkingModelIds, setCheckingModelIds] = useState<Record<string, boolean>>({});
  const activeRequestIdsRef = useRef<Record<string, string>>({});
  const modelChecksRef = useRef(new Set<string>());
  const fallbackSelectionRef = useRef<{ scope: WorkbenchViewProps["scope"]; id: string } | null>(null);
  const previousScopeRef = useRef(scope);

  const filtered = useMemo(() => {
    const visibleIds = new Set(library.visibleRecords.map((record) => record.id));
    return library.records.filter((record) => visibleIds.has(record.id) && (scope === "recent" || record.pinned));
  }, [library.records, library.visibleRecords, scope]);

  const selected = library.selected && filtered.some((record) => record.id === library.selected?.id)
    ? library.selected
    : null;
  const selectionPending = Boolean(library.selectedId && library.selected?.id !== library.selectedId);

  const fallbackId = selected ? null : filtered[0]?.id ?? null;
  useEffect(() => {
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    fallbackSelectionRef.current = null;
    if (selected) {
      void library.select(selected.id);
    }
  }, [library.select, scope, selected]);

  useEffect(() => {
    if (!fallbackId) {
      fallbackSelectionRef.current = null;
      return;
    }
    if (
      fallbackSelectionRef.current?.scope === scope
      && fallbackSelectionRef.current.id === fallbackId
    ) {
      return;
    }
    fallbackSelectionRef.current = { scope, id: fallbackId };
    void library.select(fallbackId);
  }, [fallbackId, library.select, scope]);

  async function ask(record: CaptureRecord, prompt: string) {
    if (
      activeRequestIdsRef.current[record.id]
      || modelChecksRef.current.has(record.id)
      || !record.imageDataUrl
    ) return;
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;

    if (!modelReady) {
      setDrafts((current) => ({ ...current, [record.id]: normalizedPrompt }));
      modelChecksRef.current.add(record.id);
      setCheckingModelIds((current) => ({ ...current, [record.id]: true }));
      try {
        const ready = await onRequireModel({
          recordId: record.id,
          prompt: normalizedPrompt,
        });
        if (!ready) return;
      } catch {
        return;
      } finally {
        modelChecksRef.current.delete(record.id);
        setCheckingModelIds((current) => {
          const remaining = { ...current };
          delete remaining[record.id];
          return remaining;
        });
      }
    }

    const requestId = crypto.randomUUID();
    const userMessage: CaptureMessage = { role: "user", content: normalizedPrompt };
    const nextMessages = [...record.messages, userMessage];
    activeRequestIdsRef.current = { ...activeRequestIdsRef.current, [record.id]: requestId };
    setDrafts((current) => ({ ...current, [record.id]: "" }));
    setActiveRequestIds((current) => ({ ...current, [record.id]: requestId }));
    setStreaming((current) => ({ ...current, [record.id]: "" }));
    try {
      await library.update(record.id, { messages: nextMessages });
      const answer = await onAsk(record, normalizedPrompt, requestId, (text) => {
        setStreaming((current) => ({ ...current, [record.id]: text }));
      });
      if (answer) {
        await library.update(record.id, {
          messages: [...nextMessages, { role: "assistant", content: answer }],
        });
      }
    } finally {
      if (activeRequestIdsRef.current[record.id] === requestId) {
        const remainingRequests = { ...activeRequestIdsRef.current };
        delete remainingRequests[record.id];
        activeRequestIdsRef.current = remainingRequests;
        setActiveRequestIds((current) => {
          if (current[record.id] !== requestId) return current;
          const remaining = { ...current };
          delete remaining[record.id];
          return remaining;
        });
        setStreaming((current) => ({ ...current, [record.id]: "" }));
      }
    }
  }

  return (
    <div className="workbench-shell">
      <CaptureList
        records={filtered}
        selectedId={library.selectedId}
        query={library.query}
        onQueryChange={library.setQuery}
        onSelect={(id) => void library.select(id)}
      />

      <main className={`workbench-detail${selectionPending ? " is-switching" : ""}`} aria-busy={selectionPending}>
        {library.error ? (
          <div className="workbench-detail__notice" role="status">{library.error}</div>
        ) : null}
        {selectionPending ? (
          <div className="workbench-detail__loading" role="status">
            <LoaderCircle className="is-spinning" size={18} />
            <span>正在载入</span>
          </div>
        ) : null}
        {selected ? (
          <div className="workbench-detail__selection" inert={selectionPending}>
            <header className="workbench-detail__header">
              <div>
                <strong>{selected.title || selected.ocrText.split("\n")[0] || "新截图"}</strong>
                <span>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(selected.createdAtMs)}</span>
              </div>
              <div className="workbench-detail__actions">
                <button
                  type="button"
                  aria-label={selected.pinned ? "取消固定" : "固定截图"}
                  title={selected.pinned ? "取消固定" : "固定截图"}
                  className={selected.pinned ? "is-active" : ""}
                  onClick={() => void library.update(selected.id, { pinned: !selected.pinned })}
                >
                  <Pin size={16} />
                </button>
                <button
                  type="button"
                  aria-label="删除截图"
                  title="删除截图"
                  onClick={() => void library.remove(selected.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </header>
            <div className="workbench-detail__body">
              <CaptureCanvas record={selected} />
              <CaptureInspector
                record={selected}
                draft={drafts[selected.id] ?? ""}
                streamingText={streaming[selected.id] ?? ""}
                answering={Boolean(activeRequestIds[selected.id])}
                checkingModel={Boolean(checkingModelIds[selected.id])}
                onDraftChange={(value) => setDrafts((current) => ({ ...current, [selected.id]: value }))}
                onAsk={(prompt) => void ask(selected, prompt)}
                showTips={showTips && selected.ocrState === "ready"}
                onTipsComplete={onTipsComplete}
                onStop={() => {
                  const requestId = activeRequestIdsRef.current[selected.id];
                  if (requestId) void onCancel(requestId);
                }}
              />
            </div>
          </div>
        ) : filtered.length > 0 ? (
          <div className="workbench-empty">
            <p>正在载入截图</p>
          </div>
        ) : (
          <div className="workbench-empty">
            <span><Camera size={25} /></span>
            <h2>还没有截图</h2>
            <p>截一张图，它会出现在这里。</p>
            <button type="button" onClick={onCapture}>截图</button>
          </div>
        )}
      </main>
    </div>
  );
}

type WorkbenchShellProps = Pick<
  WorkbenchViewProps,
  | "scope"
  | "onCapture"
  | "modelReady"
  | "onRequireModel"
  | "showTips"
  | "onTipsComplete"
> & {
  requestedRecordId?: string | null;
  captureApi?: CaptureClient;
};

export const WorkbenchShell = memo(function WorkbenchShell({
  scope,
  onCapture,
  modelReady,
  onRequireModel,
  showTips,
  onTipsComplete,
  requestedRecordId = null,
  captureApi,
}: WorkbenchShellProps) {
  const library = useCaptureLibrary(captureApi);
  const handledRequestedRecordIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!requestedRecordId) {
      handledRequestedRecordIdRef.current = null;
      return;
    }
    if (handledRequestedRecordIdRef.current === requestedRecordId) return;
    handledRequestedRecordIdRef.current = requestedRecordId;
    void library.refresh(requestedRecordId);
  }, [library.refresh, requestedRecordId]);

  return (
    <WorkbenchView
      library={library}
      scope={scope}
      onCapture={onCapture}
      modelReady={modelReady}
      onRequireModel={onRequireModel}
      showTips={showTips && requestedRecordId === library.selected?.id}
      onTipsComplete={onTipsComplete}
    />
  );
});
