import { useState } from "react";

type RecognizedTextPanelProps = {
  text: string;
  loading?: boolean;
  compact?: boolean;
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
  loading = false,
  compact = false,
}: RecognizedTextPanelProps) {
  if (loading) {
    return <div className="ocr-status">正在识别文字…</div>;
  }

  if (!text) {
    if (compact) {
      return null;
    }
    return <div className="ocr-status">暂无识别文字</div>;
  }

  return (
    <details className={`recognized-text${compact ? " recognized-text--compact" : ""}`}>
      <summary>
        <span>识别文字（{text.length} 字）</span>
        <OcrCopyButton text={text} />
      </summary>
      <pre>{text}</pre>
    </details>
  );
}
