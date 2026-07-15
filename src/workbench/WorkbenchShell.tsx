import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Clock3, Pin, Settings, Trash2 } from "lucide-react";
import appIconUrl from "../../app-icon.png";
import { modelClient } from "../model/modelClient";
import type { CaptureMessage, CaptureRecord } from "../captures/types";
import { useCaptureLibrary, type CaptureLibraryState } from "../captures/useCaptureLibrary";
import { CaptureCanvas } from "./CaptureCanvas";
import { CaptureInspector } from "./CaptureInspector";
import { CaptureList } from "./CaptureList";

type WorkbenchViewProps = {
  library: CaptureLibraryState;
  onOpenSettings: () => void;
  onCapture: () => void;
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
  onOpenSettings,
  onCapture,
  onAsk = askModel,
  onCancel = (requestId) => modelClient.cancelGeneration(requestId),
}: WorkbenchViewProps) {
  const [scope, setScope] = useState<"recent" | "pinned">("recent");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [activeRequestIds, setActiveRequestIds] = useState<Record<string, string>>({});
  const activeRequestIdsRef = useRef<Record<string, string>>({});
  const fallbackSelectionRef = useRef<string | null>(null);

  const filtered = useMemo(() => {
    const visibleIds = new Set(library.visibleRecords.map((record) => record.id));
    return library.records.filter((record) => visibleIds.has(record.id) && (scope === "recent" || record.pinned));
  }, [library.records, library.visibleRecords, scope]);

  const selected = library.selected && filtered.some((record) => record.id === library.selected?.id)
    ? library.selected
    : null;

  const fallbackId = selected ? null : filtered[0]?.id ?? null;
  useEffect(() => {
    if (!fallbackId) {
      fallbackSelectionRef.current = null;
      return;
    }
    if (fallbackSelectionRef.current === fallbackId) {
      return;
    }
    fallbackSelectionRef.current = fallbackId;
    void library.select(fallbackId);
  }, [fallbackId, library.select]);

  async function ask(record: CaptureRecord, prompt: string) {
    if (activeRequestIdsRef.current[record.id] || !record.imageDataUrl) return;
    const requestId = crypto.randomUUID();
    const userMessage: CaptureMessage = { role: "user", content: prompt.trim() };
    const nextMessages = [...record.messages, userMessage];
    activeRequestIdsRef.current = { ...activeRequestIdsRef.current, [record.id]: requestId };
    setDrafts((current) => ({ ...current, [record.id]: "" }));
    setActiveRequestIds((current) => ({ ...current, [record.id]: requestId }));
    setStreaming((current) => ({ ...current, [record.id]: "" }));
    try {
      await library.update(record.id, { messages: nextMessages });
      const answer = await onAsk(record, prompt, requestId, (text) => {
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
      <nav className="workbench-rail" aria-label="工作台导航">
        <img src={appIconUrl} alt="MiniVu" className="workbench-rail__logo" />
        <button
          type="button"
          className={scope === "recent" ? "is-active" : ""}
          aria-label="最近"
          title="最近"
          onClick={() => setScope("recent")}
        >
          <Clock3 size={20} />
        </button>
        <button
          type="button"
          className={scope === "pinned" ? "is-active" : ""}
          aria-label="固定"
          title="固定"
          onClick={() => setScope("pinned")}
        >
          <Pin size={19} />
        </button>
        <button type="button" className="workbench-rail__settings" aria-label="设置" title="设置" onClick={onOpenSettings}>
          <Settings size={20} />
        </button>
      </nav>

      <CaptureList
        records={filtered}
        selectedId={selected?.id ?? null}
        query={library.query}
        onQueryChange={library.setQuery}
        onSelect={(id) => void library.select(id)}
      />

      <main className="workbench-detail">
        {selected ? (
          <>
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
                onDraftChange={(value) => setDrafts((current) => ({ ...current, [selected.id]: value }))}
                onAsk={(prompt) => void ask(selected, prompt)}
                onStop={() => {
                  const requestId = activeRequestIdsRef.current[selected.id];
                  if (requestId) void onCancel(requestId);
                }}
              />
            </div>
          </>
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

export function WorkbenchShell({ onOpenSettings, onCapture }: Omit<WorkbenchViewProps, "library" | "onAsk">) {
  const library = useCaptureLibrary();
  return <WorkbenchView library={library} onOpenSettings={onOpenSettings} onCapture={onCapture} />;
}
