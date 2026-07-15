import { useState } from "react";
import { Copy, LoaderCircle, Send, Square } from "lucide-react";
import { TranscriptPanel } from "../chat/TranscriptPanel";
import type { CaptureRecord } from "../captures/types";

type CaptureInspectorProps = {
  record: CaptureRecord;
  draft: string;
  streamingText: string;
  answering: boolean;
  onDraftChange: (value: string) => void;
  onAsk: (prompt: string) => void;
  onStop: () => void;
};

export function CaptureInspector({
  record,
  draft,
  streamingText,
  answering,
  onDraftChange,
  onAsk,
  onStop,
}: CaptureInspectorProps) {
  const [tab, setTab] = useState<"ai" | "text">("ai");
  const [copied, setCopied] = useState(false);
  const hasConversation = record.messages.length > 0 || Boolean(streamingText);

  async function copyText() {
    if (!record.ocrText) return;
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(record.ocrText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  function submit() {
    const value = draft.trim();
    if (value && !answering) onAsk(value);
  }

  return (
    <aside className="capture-inspector" aria-label="截图信息">
      <div className="capture-inspector__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "ai"}
          className={tab === "ai" ? "is-active" : ""}
          onClick={() => setTab("ai")}
        >
          AI
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "text"}
          className={tab === "text" ? "is-active" : ""}
          onClick={() => setTab("text")}
        >
          文字
        </button>
      </div>

      {tab === "ai" ? (
        <div className="capture-inspector__ai" role="tabpanel">
          <div className="capture-inspector__conversation">
            {hasConversation ? (
              <TranscriptPanel messages={record.messages} streamingText={streamingText} />
            ) : (
              <div className="capture-inspector__empty">
                <strong>从这张截图开始</strong>
                <button
                  type="button"
                  onClick={() => onAsk("请简洁说明这张截图的重点，并指出值得关注的内容。")}
                >
                  帮我看懂
                </button>
              </div>
            )}
          </div>
          <div className="capture-inspector__composer">
            <textarea
              rows={3}
              value={draft}
              placeholder="问这张截图…"
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            {answering ? (
              <button type="button" className="capture-inspector__send" aria-label="停止" onClick={onStop}>
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="capture-inspector__send"
                aria-label="发送"
                disabled={!draft.trim()}
                onClick={submit}
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="capture-inspector__text" role="tabpanel">
          <header>
            <span>{record.ocrText ? `${record.ocrText.length} 字` : "识别文字"}</span>
            <button type="button" onClick={() => void copyText()} disabled={!record.ocrText}>
              {record.ocrState === "pending" ? <LoaderCircle className="is-spinning" size={15} /> : <Copy size={15} />}
              {copied ? "已复制" : "复制"}
            </button>
          </header>
          {record.ocrState === "pending" ? (
            <p className="capture-inspector__status">正在识别文字…</p>
          ) : record.ocrText ? (
            <pre>{record.ocrText}</pre>
          ) : (
            <p className="capture-inspector__status">这张截图里没有识别到文字</p>
          )}
        </div>
      )}
    </aside>
  );
}
