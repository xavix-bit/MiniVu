import { useEffect, useRef, useState } from "react";
import { Copy, LoaderCircle, Send, Square, X } from "lucide-react";
import { TranscriptPanel } from "../chat/TranscriptPanel";
import type { CaptureRecord } from "../captures/types";

type CaptureInspectorProps = {
  record: CaptureRecord;
  draft: string;
  streamingText: string;
  answering: boolean;
  checkingModel: boolean;
  showTips: boolean;
  onDraftChange: (value: string) => void;
  onAsk: (prompt: string) => void;
  onTipsComplete: () => void;
  onStop: () => void;
};

export function CaptureInspector({
  record,
  draft,
  streamingText,
  answering,
  checkingModel,
  showTips,
  onDraftChange,
  onAsk,
  onTipsComplete,
  onStop,
}: CaptureInspectorProps) {
  const [tab, setTab] = useState<"ai" | "text">("ai");
  const [copied, setCopied] = useState(false);
  const [tipStep, setTipStep] = useState<"text" | "composer">("text");
  const tabRefs = useRef<Record<"ai" | "text", HTMLButtonElement | null>>({ ai: null, text: null });
  const hasConversation = record.messages.length > 0 || Boolean(streamingText);

  useEffect(() => {
    if (showTips) setTipStep("text");
  }, [record.id, showTips]);

  function moveToTab(next: "ai" | "text") {
    setTab(next);
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }

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
    if (value && !answering && !checkingModel) onAsk(value);
  }

  return (
    <aside className="capture-inspector" aria-label="截图信息">
      <div className="capture-inspector__tabs" role="tablist">
        <button
          ref={(node) => { tabRefs.current.ai = node; }}
          id="capture-tab-ai"
          type="button"
          role="tab"
          aria-selected={tab === "ai"}
          aria-controls="capture-panel-ai"
          tabIndex={tab === "ai" ? 0 : -1}
          className={tab === "ai" ? "is-active" : ""}
          onClick={() => setTab("ai")}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              moveToTab("text");
            }
          }}
        >
          AI
        </button>
        <button
          ref={(node) => { tabRefs.current.text = node; }}
          id="capture-tab-text"
          type="button"
          role="tab"
          aria-selected={tab === "text"}
          aria-controls="capture-panel-text"
          tabIndex={tab === "text" ? 0 : -1}
          className={tab === "text" ? "is-active" : ""}
          onClick={() => setTab("text")}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              moveToTab("ai");
            }
          }}
        >
          文字
        </button>
      </div>

      <div className="capture-inspector__panels">
        <div
          id="capture-panel-ai"
          className={`capture-inspector__panel capture-inspector__ai${tab === "ai" ? " is-active" : ""}`}
          role="tabpanel"
          aria-labelledby="capture-tab-ai"
          aria-hidden={tab !== "ai"}
          inert={tab !== "ai"}
        >
          <div className="capture-inspector__conversation">
            {hasConversation ? (
              <TranscriptPanel messages={record.messages} streamingText={streamingText} />
            ) : (
              <div className="capture-inspector__empty">
                <strong>从这张截图开始</strong>
                <button
                  type="button"
                  disabled={checkingModel}
                  onClick={() => onAsk("请简洁说明这张截图的重点，并指出值得关注的内容。")}
                >
                  帮我看懂
                </button>
              </div>
            )}
          </div>
          <div className="capture-inspector__composer" aria-busy={checkingModel}>
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
                disabled={!draft.trim() || checkingModel}
                onClick={submit}
              >
                {checkingModel ? (
                  <LoaderCircle className="is-spinning" size={16} aria-hidden="true" />
                ) : (
                  <Send size={16} />
                )}
              </button>
            )}
          </div>
        </div>
        <div
          id="capture-panel-text"
          className={`capture-inspector__panel capture-inspector__text${tab === "text" ? " is-active" : ""}`}
          role="tabpanel"
          aria-labelledby="capture-tab-text"
          aria-hidden={tab !== "text"}
          inert={tab !== "text"}
        >
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
      </div>

      {showTips ? (
        <div
          className={`capture-inspector__tip capture-inspector__tip--${tipStep}`}
          role="note"
          aria-label="新手提示"
        >
          <div className="capture-inspector__tip-head">
            <strong>
              {tipStep === "text" ? "识别出的文字在这里" : "也可以直接问这张截图"}
            </strong>
            <button type="button" aria-label="关闭新手提示" onClick={onTipsComplete}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p>
            {tipStep === "text"
              ? "查看、复制截图里的文字。"
              : "输入你的问题，原图和文字会一起作为参考。"}
          </p>
          <button
            type="button"
            className="capture-inspector__tip-action"
            onClick={() => {
              if (tipStep === "text") {
                setTab("ai");
                setTipStep("composer");
              } else {
                onTipsComplete();
              }
            }}
          >
            {tipStep === "text" ? "下一步" : "知道了"}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
