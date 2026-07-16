import { Clock3, Pin, Settings } from "lucide-react";
import appIconUrl from "../../app-icon.png";

export type AppRailDestination = "recent" | "pinned" | "settings";

type AppRailProps = {
  active: AppRailDestination | null;
  disabled?: boolean;
  onNavigate: (destination: AppRailDestination) => void;
};

const ITEMS = [
  { key: "recent", label: "最近", Icon: Clock3 },
  { key: "pinned", label: "固定", Icon: Pin },
  { key: "settings", label: "设置", Icon: Settings },
] as const;

export function AppRail({ active, disabled = false, onNavigate }: AppRailProps) {
  return (
    <nav className="app-rail" aria-label="应用导航">
      <img src={appIconUrl} alt="MiniVu" className="app-rail__logo" />
      {ITEMS.map(({ key, label, Icon }) => {
        const isActive = active !== null && key === active;
        return (
          <button
            key={key}
            type="button"
            className={`${isActive ? "is-active" : ""}${key === "settings" ? " app-rail__settings" : ""}`}
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            title={label}
            disabled={disabled}
            onClick={() => onNavigate(key)}
          >
            <Icon size={key === "pinned" ? 19 : 20} aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}
