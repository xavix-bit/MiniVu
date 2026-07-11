import appIconUrl from "../../app-icon.png";
import { startWindowDrag } from "../window/panelChrome";

type PanelHeaderProps = {
  onExport: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
};

export function PanelHeader({ onExport, onOpenSettings, onClose }: PanelHeaderProps) {
  return (
    <header className="panel-header" data-tauri-drag-region onPointerDown={startWindowDrag}>
      <div className="panel-header__title" data-tauri-drag-region>
        <img src={appIconUrl} alt="" className="panel-header__logo" width={32} height={32} />
        <h1 data-tauri-drag-region>MiniVu</h1>
      </div>
      <div className="panel-header__actions">
        <button type="button" className="panel-header__btn" onClick={onExport}>
          导出
        </button>
        <button type="button" className="panel-header__btn" onClick={onOpenSettings}>
          设置
        </button>
        <button type="button" className="panel-header__btn panel-header__btn--close" onClick={onClose} title="收起到桌边">
          收起
        </button>
      </div>
    </header>
  );
}
