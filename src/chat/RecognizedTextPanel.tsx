type RecognizedTextPanelProps = {
  text: string;
  loading?: boolean;
  compact?: boolean;
};

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
      <summary>识别文字（{text.length} 字）</summary>
      <pre>{text}</pre>
    </details>
  );
}
