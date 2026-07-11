import { useEffect, useRef } from "react";

type ReplaceImageConfirmProps = {
  onConfirm: () => void;
  onCancel: () => void;
};

export function ReplaceImageConfirm({ onConfirm, onCancel }: ReplaceImageConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel]);

  return (
    <div className="replace-image-modal" role="dialog" aria-modal="true" aria-label="确认替换图片">
      <button type="button" className="replace-image-modal__backdrop" aria-label="取消" onClick={onCancel} />
      <div className="replace-image-modal__card">
        <p className="replace-image-modal__title">换图会清空对话</p>
        <p className="replace-image-modal__desc">继续后将重新开始。</p>
        <div className="replace-image-modal__actions">
          <button ref={cancelRef} type="button" className="ghost-btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="settings-btn settings-btn--primary" onClick={onConfirm}>
            继续替换
          </button>
        </div>
      </div>
    </div>
  );
}
