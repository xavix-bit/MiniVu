import type { ReactNode } from "react";

type QuickActionsProps = {
  onCopyText: () => void;
  onTranslate: () => void;
  onAsk: () => void;
  textReady: boolean;
  disabled?: boolean;
};

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const icons: Record<string, ReactNode> = {
  translate: (
    <svg {...ICON_PROPS}>
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  ),
  text: (
    <svg {...ICON_PROPS}>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" x2="15" y1="20" y2="20" />
      <line x1="12" x2="12" y1="4" y2="20" />
    </svg>
  ),
  ask: (
    <svg {...ICON_PROPS}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </svg>
  ),
};

export function QuickActions({
  onCopyText,
  onTranslate,
  onAsk,
  textReady,
  disabled = false,
}: QuickActionsProps) {
  return (
    <div className="quick-actions" aria-label="快捷操作">
      <button type="button" className="quick-actions__btn" disabled={!textReady || disabled} onClick={onCopyText}>
        <span className="quick-actions__icon">{icons.text}</span>
        <span>复制文字</span>
      </button>
      <button type="button" className="quick-actions__btn" disabled={disabled} onClick={onTranslate}>
        <span className="quick-actions__icon">{icons.translate}</span>
        <span>翻译</span>
      </button>
      <button type="button" className="quick-actions__btn" disabled={disabled} onClick={onAsk}>
        <span className="quick-actions__icon">{icons.ask}</span>
        <span>问图</span>
      </button>
    </div>
  );
}
