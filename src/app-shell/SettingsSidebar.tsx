import type { ReactNode } from "react";
import appIconUrl from "../../app-icon.png";

export type SettingsSection = "home" | "setup" | "model" | "settings" | "privacy";

type SettingsSidebarProps = {
  active: SettingsSection;
  shortcut: string;
  modelReady: boolean;
  setupOnly?: boolean;
  onNavigate: (section: SettingsSection) => void;
  onOpenSetup: () => void;
};

type NavIconName =
  | SettingsSection
  | "template";

type NavItem = {
  key: SettingsSection;
  label: string;
  icon: NavIconName;
};

const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "工作台", icon: "home" },
  { key: "setup", label: "初始设置", icon: "template" },
  { key: "model", label: "模型", icon: "model" },
  { key: "settings", label: "偏好设置", icon: "settings" },
  { key: "privacy", label: "隐私", icon: "privacy" },
];

function formatShortcut(shortcut: string) {
  return shortcut
    .replace("Control", "⌃")
    .replace("Option", "⌥")
    .replace("Command", "⌘")
    .replace("Shift", "⇧")
    .replace(/\+/g, " ");
}

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    home: (
      <path
        d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    ),
    setup: (
      <>
        <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      </>
    ),
    model: (
      <path d="M6 8h12v8H6V8Zm2 2v4h8v-4H8Zm10-4H6V6h12v0Z" fill="currentColor" />
    ),
    settings: (
      <path
        d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm8.4 3.8a7.2 7.2 0 0 0-.5-2.7l2-1.5-2-3.5-2.3 1a7.4 7.4 0 0 0-2.3-1.3L15 2h-4l-.3 2.5a7.4 7.4 0 0 0-2.3 1.3l-2.3-1-2 3.5 2 1.5a7.2 7.2 0 0 0 0 5.4l-2 1.5 2 3.5 2.3-1a7.4 7.4 0 0 0 2.3 1.3L11 22h4l.3-2.5a7.4 7.4 0 0 0 2.3-1.3l2.3 1 2-3.5-2-1.5c.3-.9.5-1.8.5-2.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    ),
    privacy: (
      <>
        <path
          d="M12 3 5 6.5V11c0 4.2 3 7.4 7 8.5 4-1.1 7-4.3 7-8.5V6.5L12 3Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M9.5 12 11 13.8 15 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
    template: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="4" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="4" y="14" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="14" y="14" width="6" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </>
    ),
  };

  return (
    <svg className="settings-nav-item__svg" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function SettingsSidebar({
  active,
  shortcut,
  modelReady,
  setupOnly = false,
  onNavigate,
  onOpenSetup,
}: SettingsSidebarProps) {
  return (
    <aside className="settings-sidebar" aria-label="主导航">
      <div className="settings-sidebar__brand">
        <span className="settings-sidebar__logo" aria-hidden="true">
          <img src={appIconUrl} alt="" className="settings-sidebar__logo-img" width={36} height={36} />
        </span>
        <div>
          <strong>MiniVu</strong>
        </div>
      </div>

      <nav className="settings-sidebar__nav" aria-label="设置导航">
        {NAV_ITEMS.map((item) => {
          const locked = setupOnly && item.key !== "home" && item.key !== "setup";
          const isActive = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              className={`settings-nav-item${isActive ? " is-active" : ""}${locked ? " is-locked" : ""}`}
              disabled={locked}
              aria-disabled={locked}
              aria-current={isActive ? "page" : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <span className="settings-nav-item__icon" aria-hidden="true">
                <NavIcon name={item.icon} />
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="settings-sidebar__footer">
        <div className="settings-sidebar__card">
          {modelReady ? (
            <>
              <p className="settings-sidebar__card-label">快捷键</p>
              <p className="settings-sidebar__card-kbd">
                <kbd>{formatShortcut(shortcut)}</kbd>
              </p>
              <p className="settings-sidebar__card-note">任意应用中按下即可</p>
            </>
          ) : (
            <>
              <p className="settings-sidebar__card-label">还没配置好</p>
              <p className="settings-sidebar__card-note">下载模型后即可使用</p>
              <button type="button" className="settings-sidebar__card-btn" onClick={onOpenSetup}>
                去配置
              </button>
            </>
          )}
        </div>
        <p className="settings-sidebar__version">版本 v0.1.0</p>
      </div>
    </aside>
  );
}
