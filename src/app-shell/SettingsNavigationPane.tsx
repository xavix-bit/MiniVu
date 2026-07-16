import { useRef, type KeyboardEvent } from "react";
import { Boxes, Keyboard, Settings2, ShieldCheck } from "lucide-react";

export type SettingsSection = "general" | "model" | "shortcut" | "privacy" | "setup";

type SettingsNavigationPaneProps = {
  active: SettingsSection;
  disabled?: boolean;
  onNavigate: (section: SettingsSection) => void;
};

const ITEMS = [
  { key: "general", label: "通用", Icon: Settings2 },
  { key: "model", label: "模型", Icon: Boxes },
  { key: "shortcut", label: "快捷键", Icon: Keyboard },
  { key: "privacy", label: "隐私", Icon: ShieldCheck },
] as const;

export function SettingsNavigationPane({
  active,
  disabled = false,
  onNavigate,
}: SettingsNavigationPaneProps) {
  const navRef = useRef<HTMLElement>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (!buttons.length) return;

    event.preventDefault();
    const currentIndex = buttons.indexOf(event.currentTarget);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  return (
    <aside className="settings-navigation-pane" aria-label="设置">
      <header className="settings-navigation-pane__header">
        <h1>设置</h1>
      </header>
      <nav ref={navRef} className="settings-navigation-pane__nav" aria-label="设置导航">
        {ITEMS.map(({ key, label, Icon }) => {
          const isActive = key === active;
          return (
            <button
              key={key}
              type="button"
              className={isActive ? "is-active" : ""}
              aria-current={isActive ? "page" : undefined}
              disabled={disabled}
              onClick={() => onNavigate(key)}
              onKeyDown={handleKeyDown}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
