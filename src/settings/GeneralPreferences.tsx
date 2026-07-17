import type { AppSettings } from "./settingsStore";

export type GeneralPreferenceKey =
  | "theme"
  | "captureRetention"
  | "floatingAssistantEnabled"
  | "backgroundWarmup";

export type GeneralPreferenceSettings = Pick<AppSettings, GeneralPreferenceKey>;

export const generalPreferenceLabels: Record<GeneralPreferenceKey, string> = {
  theme: "主题",
  captureRetention: "保留时长",
  floatingAssistantEnabled: "悬浮按钮",
  backgroundWarmup: "提前准备问图",
};

type GeneralPreferencesProps = {
  settings: GeneralPreferenceSettings;
  disabled: boolean;
  saving: Partial<Record<GeneralPreferenceKey, boolean>>;
  onPatch: (key: GeneralPreferenceKey, patch: Partial<GeneralPreferenceSettings>) => void;
};

const themeOptions: Array<{ value: AppSettings["theme"]; label: string }> = [
  { value: "system", label: "自动" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function GeneralPreferences({
  settings,
  disabled,
  saving,
  onPatch,
}: GeneralPreferencesProps) {
  return (
    <div className="general-preferences">
      <section className="preference-group" aria-labelledby="appearance-preferences-title">
        <h2 id="appearance-preferences-title" className="preference-group__title">
          外观
        </h2>
        <div className="preference-row">
          <div className="preference-row__copy">
            <span className="preference-row__label">{generalPreferenceLabels.theme}</span>
            <span className="preference-row__detail">跟随系统，或固定一种显示方式。</span>
          </div>
          <div
            className="preference-segmented"
            role="radiogroup"
            aria-label="外观主题"
            data-saving={saving.theme || undefined}
          >
            {themeOptions.map((option) => (
              <label key={option.value} className="preference-segmented__item">
                <input
                  type="radio"
                  name="theme"
                  value={option.value}
                  checked={settings.theme === option.value}
                  disabled={disabled}
                  onChange={() => onPatch("theme", { theme: option.value })}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="preference-group" aria-labelledby="usage-preferences-title">
        <h2 id="usage-preferences-title" className="preference-group__title">
          使用
        </h2>
        <label className="preference-row">
          <span className="preference-row__copy">
            <span className="preference-row__label">
              {generalPreferenceLabels.captureRetention}
            </span>
            <span className="preference-row__detail">固定的截图不会自动清理。</span>
          </span>
          <select
            className="preference-select"
            aria-label="保留时长"
            value={settings.captureRetention}
            disabled={disabled}
            data-saving={saving.captureRetention || undefined}
            onChange={(event) =>
              onPatch("captureRetention", {
                captureRetention: event.target.value as AppSettings["captureRetention"],
              })
            }
          >
            <option value="none">不保留</option>
            <option value="24h">24 小时</option>
            <option value="7d">7 天</option>
            <option value="forever">一直保留</option>
          </select>
        </label>

        <label className="preference-row">
          <span className="preference-row__copy">
            <span className="preference-row__label">
              {generalPreferenceLabels.floatingAssistantEnabled}
            </span>
            <span className="preference-row__detail">在其他应用上方快速打开 MiniVu。</span>
          </span>
          <input
            className="preference-switch"
            type="checkbox"
            aria-label="悬浮按钮"
            checked={settings.floatingAssistantEnabled}
            disabled={disabled}
            data-saving={saving.floatingAssistantEnabled || undefined}
            onChange={(event) =>
              onPatch("floatingAssistantEnabled", {
                floatingAssistantEnabled: event.target.checked,
              })
            }
          />
        </label>

        <label className="preference-row">
          <span className="preference-row__copy">
            <span className="preference-row__label">
              {generalPreferenceLabels.backgroundWarmup}
            </span>
            <span className="preference-row__detail">打开后，截图后的第一次提问更快。</span>
          </span>
          <input
            className="preference-switch"
            type="checkbox"
            aria-label="提前准备问图"
            checked={settings.backgroundWarmup}
            disabled={disabled}
            data-saving={saving.backgroundWarmup || undefined}
            onChange={(event) =>
              onPatch("backgroundWarmup", { backgroundWarmup: event.target.checked })
            }
          />
        </label>
      </section>
    </div>
  );
}
