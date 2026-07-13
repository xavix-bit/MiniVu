import { useState } from "react";
import type { OcrStatus } from "./useImageSession";

type RecognizedTextPanelProps = {
  text: string;
  status: OcrStatus;
  compact?: boolean;
  disabled?: boolean;
  onRetry: () => void;
};

function OcrCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(event: React.MouseEvent) {
    event.preventDefault();
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
    <button type="button" className="copy-btn recognized-text__copy" onClick={(e) => void copy(e)}>
      {copied ? "已复制" : "复制"}
    </button>
  );
}

export function RecognizedTextPanel({
  text,
  status,
  compact = false,
  disabled = false,
  onRetry,
}: RecognizedTextPanelProps) {
  if (status === "recognizing") {
    return <div className="ocr-status">正在识别文字…</div>;
  }

  if (status === "failed") {
    return (
      <div className="ocr-status ocr-status--failed" role="status">
        <span>文字没识别出来</span>
        <button type="button" onClick={onRetry} disabled={disabled}>
          重试
        </button>
      </div>
    );
  }

  if (status === "empty" || !text) {
    return <div className="ocr-status">未识别到文字</div>;
  }

  return (
    <details className={`recognized-text${compact ? " recognized-text--compact" : ""}`}>
      <summary>
        <span>识别到文字（{text.length} 字）</span>
        <OcrCopyButton text={text} />
      </summary>
      <pre>{text}</pre>
    </details>
  );
}
