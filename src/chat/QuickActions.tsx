import { CircleHelp, Copy, Languages, ListCollapse } from "lucide-react";

type QuickActionsProps = {
  onCopyText: () => void;
  onTranslate: () => void;
  onSummarize: () => void;
  onExplain: () => void;
  textReady: boolean;
  disabled?: boolean;
};

export function QuickActions({
  onCopyText,
  onTranslate,
  onSummarize,
  onExplain,
  textReady,
  disabled = false,
}: QuickActionsProps) {
  return (
    <div className="quick-actions" aria-label="快捷操作">
      <button type="button" className="quick-actions__btn" disabled={!textReady || disabled} onClick={onCopyText}>
        <span className="quick-actions__icon"><Copy aria-hidden="true" /></span>
        <span className="quick-actions__label">复制文字</span>
      </button>
      <button type="button" className="quick-actions__btn" disabled={disabled} onClick={onTranslate}>
        <span className="quick-actions__icon"><Languages aria-hidden="true" /></span>
        <span className="quick-actions__label">翻译</span>
      </button>
      <button type="button" className="quick-actions__btn" disabled={disabled} onClick={onSummarize}>
        <span className="quick-actions__icon"><ListCollapse aria-hidden="true" /></span>
        <span className="quick-actions__label">总结</span>
      </button>
      <button type="button" className="quick-actions__btn" disabled={disabled} onClick={onExplain}>
        <span className="quick-actions__icon"><CircleHelp aria-hidden="true" /></span>
        <span className="quick-actions__label">解释</span>
      </button>
    </div>
  );
}
