import { useEffect, useRef, useState } from "react";
import { applyTheme } from "../theme/applyTheme";
import { settingsThemeToMode } from "../theme/useAppTheme";
import {
  createDefaultSettings,
  loadSettings,
  updateSettings,
  type AppSettings,
} from "./settingsStore";
import { ShortcutRecorder } from "./shortcutRecorder";

type SettingsPanelProps = {
  view: "general" | "shortcut";
  onSaved?: () => void;
};

export function SettingsPanel({ view, onSaved }: SettingsPanelProps) {
  const draftRevisionRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const [settings, setSettings] = useState<AppSettings>(createDefaultSettings());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsLoadError, setSettingsLoadError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadPersistedSettings() {
    const generation = ++loadGenerationRef.current;
    setSettingsLoading(true);
    setSettingsLoaded(false);
    setSettingsLoadError("");
    try {
      const loaded = await loadSettings();
      if (!mountedRef.current || generation !== loadGenerationRef.current) {
        return;
      }
      draftRevisionRef.current = 0;
      setSettings(loaded);
      setSettingsLoaded(true);
    } catch {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setSettingsLoadError("无法读取设置，请重试。");
      }
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setSettingsLoading(false);
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void loadPersistedSettings();

    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  function updateDraft(update: (current: AppSettings) => AppSettings) {
    if (!settingsLoaded || settingsLoading) {
      return;
    }
    draftRevisionRef.current += 1;
    setSettings(update);
    setSavedMessage("");
    setSaveError("");
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!settingsLoaded || settingsLoading || saving) {
      return;
    }
    setSaving(true);
    setSavedMessage("");
    setSaveError("");
    const submittedRevision = draftRevisionRef.current;
    const submittedView = view;
    try {
      const next = await updateSettings(
        submittedView === "general"
          ? {
              theme: settings.theme,
              captureRetention: settings.captureRetention,
              backgroundWarmup: settings.backgroundWarmup,
            }
          : { shortcut: settings.shortcut },
      );
      if (!mountedRef.current) {
        return;
      }
      if (draftRevisionRef.current === submittedRevision) {
        setSettings((current) =>
          submittedView === "general"
            ? {
                ...current,
                theme: next.theme,
                captureRetention: next.captureRetention,
                backgroundWarmup: next.backgroundWarmup,
              }
            : { ...current, shortcut: next.shortcut },
        );
        setSavedMessage("设置已保存");
      }
      onSaved?.();
    } catch {
      if (mountedRef.current) {
        setSaveError("无法保存设置，请重试。");
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }

  const controlsDisabled = !settingsLoaded || settingsLoading;

  return (
    <form
      className="settings-form settings-form--stack settings-preferences-panel"
      aria-label={view === "general" ? "通用设置" : "快捷键设置"}
      aria-busy={saving || settingsLoading}
      onSubmit={(event) => void handleSave(event)}
    >
      {settingsLoadError ? (
        <div className="callout callout--attention" role="alert">
          <p>{settingsLoadError}</p>
          <button
            type="button"
            className="callout__action"
            disabled={settingsLoading}
            onClick={() => void loadPersistedSettings()}
          >
            重试
          </button>
        </div>
      ) : null}

      {view === "general" ? (
        <section className="settings-section">
          <h2 className="settings-section__title">通用</h2>
          <label className="settings-field">
            <span>外观主题</span>
            <select
              value={settings.theme ?? "system"}
              disabled={controlsDisabled}
              onChange={(event) => {
                const theme = event.target.value as AppSettings["theme"];
                updateDraft((current) => ({ ...current, theme }));
                applyTheme(settingsThemeToMode(theme));
              }}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>

          <label className="settings-field">
            <span>自动保留</span>
            <select
              value={settings.captureRetention ?? "24h"}
              disabled={controlsDisabled}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  captureRetention: event.target.value as AppSettings["captureRetention"],
                }))
              }
            >
              <option value="none">不保留</option>
              <option value="24h">24 小时</option>
              <option value="7d">7 天</option>
              <option value="forever">一直保留</option>
            </select>
            <span className="field-hint">固定的截图不会自动删除。</span>
          </label>

          <label className="settings-field settings-field--checkbox">
            <input
              type="checkbox"
              checked={settings.backgroundWarmup ?? false}
              disabled={controlsDisabled}
              onChange={(event) =>
                updateDraft((current) => ({
                  ...current,
                  backgroundWarmup: event.target.checked,
                }))
              }
            />
            <span>截图后提前准备问图</span>
            <span className="field-hint">打开后，第一次提问会更快。</span>
          </label>
        </section>
      ) : (
        <section className="settings-section">
          <h2 className="settings-section__title">快捷键</h2>
          <div className="settings-field">
            <span>全局快捷键</span>
            <ShortcutRecorder
              value={settings.shortcut}
              disabled={controlsDisabled}
              onChange={(shortcut) => updateDraft((current) => ({ ...current, shortcut }))}
            />
          </div>
        </section>
      )}

      <div className="settings-form__footer">
        <button
          type="submit"
          className="settings-btn settings-btn--primary"
          disabled={controlsDisabled || saving}
        >
          {saving ? "保存中…" : "保存设置"}
        </button>
        {savedMessage ? <p className="saved-message">{savedMessage}</p> : null}
        {saveError ? <p className="onboarding-error">{saveError}</p> : null}
      </div>
    </form>
  );
}
