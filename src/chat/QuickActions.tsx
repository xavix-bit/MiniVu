import { Copy, Languages } from "lucide-react";

type QuickActionsProps = {
  onCopyText: () => void;
  onTranslate: () => void;
  textReady: boolean;
  disabled?: boolean;
};

export function QuickActions({
  onCopyText,
  onTranslate,
  textReady,
  disabled = false,
}: QuickActionsProps) {
  return (
    <div className="quick-actions" aria-label="快捷操作">
      <button type="button" className="quick-actions__btn" disabled={!textReady || disabled} onClick={onCopyText}>
        <span className="quick-actions__icon"><Copy aria-hidden="true" /></span>
        <span>复制文字</span>
      </button>
      <button type="button" className="quick-actions__btn" disabled={disabled} onClick={onTranslate}>
        <span className="quick-actions__icon"><Languages aria-hidden="true" /></span>
        <span>翻译</span>
      </button>
    </div>
  );
}
