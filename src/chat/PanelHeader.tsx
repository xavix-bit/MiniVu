import { startWindowDrag } from "../window/panelChrome";

type PanelHeaderProps = {
  onExport: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
};

export function PanelHeader({ onExport, onOpenSettings, onClose }: PanelHeaderProps) {
  return (
    <header className="panel-header" onPointerDown={startWindowDrag}>
      <div className="panel-header__title">
        <span className="panel-header__grip" aria-hidden="true" />
        <span className="panel-header__mark" aria-hidden="true" />
        <h1>MiniVu</h1>
        <span className="privacy-badge">
          <span className="privacy-badge__dot" aria-hidden="true" />
          仅本地
        </span>
      </div>
      <div className="panel-header__actions">
        <button type="button" className="panel-header__btn" onClick={onExport}>
          导出
        </button>
        <button type="button" className="panel-header__btn" onClick={onOpenSettings}>
          设置
        </button>
        <button type="button" className="panel-header__btn panel-header__btn--close" onClick={onClose}>
          关闭
        </button>
      </div>
    </header>
  );
}
