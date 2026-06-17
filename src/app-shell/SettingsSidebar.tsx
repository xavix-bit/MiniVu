import type { ReactNode } from "react";

export type SettingsSection = "home" | "setup" | "model" | "settings" | "privacy";

type SettingsSidebarProps = {
  active: SettingsSection;
  shortcut: string;
  modelReady: boolean;
  setupOnly?: boolean;
  onNavigate: (section: SettingsSection) => void;
  onOpenSetup: () => void;
};

type NavGroup = {
  label: string;
  items: { id: SettingsSection; label: string; icon: SettingsSection }[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "概览",
    items: [{ id: "home", label: "首页", icon: "home" }],
  },
  {
    label: "配置",
    items: [
      { id: "setup", label: "环境配置", icon: "setup" },
      { id: "model", label: "模型文件", icon: "model" },
    ],
  },
  {
    label: "应用",
    items: [
      { id: "settings", label: "偏好设置", icon: "settings" },
      { id: "privacy", label: "隐私说明", icon: "privacy" },
    ],
  },
];

function formatShortcut(shortcut: string) {
  return shortcut
    .replace("Control", "⌃")
    .replace("Option", "⌥")
    .replace("Command", "⌘")
    .replace("Shift", "⇧")
    .replace(/\+/g, " ");
}

function NavIcon({ name }: { name: SettingsSection }) {
  const paths: Record<SettingsSection, ReactNode> = {
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
          <span className="settings-sidebar__logo-mark" />
        </span>
        <div>
          <strong>MiniVu</strong>
          <span className="settings-sidebar__badge">
            <span className="settings-sidebar__badge-dot" aria-hidden="true" />
            仅本地
          </span>
        </div>
      </div>

      <nav className="settings-sidebar__nav" aria-label="设置导航">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="settings-nav-group">
            <p className="settings-sidebar__nav-label">{group.label}</p>
            {group.items.map((item) => {
              const locked = setupOnly && item.id !== "setup";
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`settings-nav-item${active === item.id ? " is-active" : ""}${locked ? " is-locked" : ""}`}
                  disabled={locked}
                  aria-disabled={locked}
                  aria-current={active === item.id ? "page" : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <span className="settings-nav-item__icon" aria-hidden="true">
                    <NavIcon name={item.icon} />
                  </span>
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="settings-sidebar__footer">
        <div className="settings-sidebar__hint">
          {modelReady ? (
            <>
              <p className="settings-sidebar__hint-label">快捷唤起</p>
              <p className="settings-sidebar__hint-kbd">
                <kbd>{formatShortcut(shortcut)}</kbd>
              </p>
            </>
          ) : (
            <>
              <p className="settings-sidebar__hint-label">当前不可用</p>
              <button type="button" className="settings-sidebar__hint-link" onClick={onOpenSetup}>
                先完成环境配置
              </button>
            </>
          )}
        </div>
        <p className="settings-sidebar__version">v0.1.0</p>
      </div>
    </aside>
  );
}
