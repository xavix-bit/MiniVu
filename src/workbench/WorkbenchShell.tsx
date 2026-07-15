import { useMemo, useState } from "react";
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
  onAsk?: (record: CaptureRecord, prompt: string, onChunk: (text: string) => void) => Promise<string>;
};

async function askModel(record: CaptureRecord, prompt: string, onChunk: (text: string) => void) {
  let answer = "";
  await modelClient.askImage({
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

export function WorkbenchView({ library, onOpenSettings, onCapture, onAsk = askModel }: WorkbenchViewProps) {
  const [scope, setScope] = useState<"recent" | "pinned">("recent");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const visibleIds = new Set(library.visibleRecords.map((record) => record.id));
    return library.records.filter((record) => visibleIds.has(record.id) && (scope === "recent" || record.pinned));
  }, [library.records, library.visibleRecords, scope]);

  const selected = library.selected;

  async function ask(record: CaptureRecord, prompt: string) {
    if (answering[record.id] || !record.imageDataUrl) return;
    const userMessage: CaptureMessage = { role: "user", content: prompt.trim() };
    const nextMessages = [...record.messages, userMessage];
    setDrafts((current) => ({ ...current, [record.id]: "" }));
    setAnswering((current) => ({ ...current, [record.id]: true }));
    setStreaming((current) => ({ ...current, [record.id]: "" }));
    await library.update(record.id, { messages: nextMessages });
    try {
      const answer = await onAsk({ ...record, messages: nextMessages }, prompt, (text) => {
        setStreaming((current) => ({ ...current, [record.id]: text }));
      });
      if (answer) {
        await library.update(record.id, {
          messages: [...nextMessages, { role: "assistant", content: answer }],
        });
      }
    } finally {
      setStreaming((current) => ({ ...current, [record.id]: "" }));
      setAnswering((current) => ({ ...current, [record.id]: false }));
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
                answering={answering[selected.id] ?? false}
                onDraftChange={(value) => setDrafts((current) => ({ ...current, [selected.id]: value }))}
                onAsk={(prompt) => void ask(selected, prompt)}
                onStop={() => void modelClient.cancelGeneration()}
              />
            </div>
          </>
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
