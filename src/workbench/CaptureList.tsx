import { Pin, Search, X } from "lucide-react";
import type { CaptureRecord } from "../captures/types";

type CaptureListProps = {
  records: CaptureRecord[];
  selectedId: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
};

function recordLabel(record: CaptureRecord) {
  return record.title?.trim() || record.ocrText.trim().split("\n")[0] || "新截图";
}

function relativeTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

export function CaptureList({
  records,
  selectedId,
  query,
  onQueryChange,
  onSelect,
}: CaptureListProps) {
  return (
    <section className="capture-list-pane" aria-label="截图列表">
      <header className="capture-list-pane__header">
        <div>
          <h1>截图</h1>
          <span>{records.length}</span>
        </div>
        <label className="capture-search">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索文字或标题"
            aria-label="搜索截图"
          />
          {query ? (
            <button type="button" aria-label="清除搜索" onClick={() => onQueryChange("")}>
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </label>
      </header>

      <div className="capture-list" role="list">
        {records.map((record) => {
          const label = recordLabel(record);
          return (
            <button
              type="button"
              role="listitem"
              key={record.id}
              className={`capture-list-item${selectedId === record.id ? " is-active" : ""}`}
              aria-label={`${label}，${relativeTime(record.createdAtMs)}`}
              onClick={() => onSelect(record.id)}
            >
              <span className="capture-list-item__thumb">
                {record.thumbnailDataUrl || record.imageDataUrl ? (
                  <img src={record.thumbnailDataUrl || record.imageDataUrl} alt="" />
                ) : (
                  <span aria-hidden="true" />
                )}
              </span>
              <span className="capture-list-item__copy">
                <strong>{label}</strong>
                <small>{record.ocrState === "pending" ? "正在识别文字" : relativeTime(record.createdAtMs)}</small>
              </span>
              {record.pinned ? <Pin className="capture-list-item__pin" size={13} aria-label="已固定" /> : null}
            </button>
          );
        })}
        {!records.length ? (
          <div className="capture-list__empty">没有符合条件的截图</div>
        ) : null}
      </div>
    </section>
  );
}
