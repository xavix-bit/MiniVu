import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "./useImageSession";

type TranscriptPanelProps = {
  messages: ChatMessage[];
  streamingText?: string;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 忽略复制失败
    }
  }

  return (
    <button type="button" className="copy-btn" onClick={() => void copy()}>
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function AssistantBody({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function TranscriptPanel({ messages, streamingText }: TranscriptPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end", behavior: "auto" });
  }, [messages.length, Boolean(streamingText)]);

  return (
    <div className="transcript-panel" aria-label="对话">
      {messages.map((message, index) => (
        <article
          key={`${message.role}-${index}`}
          className={`transcript-entry transcript-entry--${message.role}`}
        >
          <div className="transcript-entry__head">
            <span className="transcript-entry__label">
              {message.role === "user" ? "你" : "MiniVu"}
            </span>
            {message.role === "assistant" ? <CopyButton text={message.content} /> : null}
          </div>
          {message.role === "assistant" ? (
            <div className="transcript-entry__body">
              <AssistantBody content={message.content} />
            </div>
          ) : (
            <div className="transcript-entry__body">{message.content}</div>
          )}
        </article>
      ))}
      {streamingText ? (
        <article className="transcript-entry transcript-entry--assistant">
          <div className="transcript-entry__head">
            <span className="transcript-entry__label">MiniVu</span>
          </div>
          <div className="transcript-entry__body">
            <AssistantBody content={streamingText} />
            <span className="transcript-entry__cursor" aria-hidden="true" />
          </div>
        </article>
      ) : null}
      <div ref={endRef} className="transcript-panel__anchor" aria-hidden="true" />
    </div>
  );
}
