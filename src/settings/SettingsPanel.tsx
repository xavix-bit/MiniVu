import { useEffect, useRef, useState } from "react";
import { applyTheme } from "../theme/applyTheme";
import { settingsThemeToMode } from "../theme/useAppTheme";
import {
  GeneralPreferences,
  generalPreferenceLabels,
  type GeneralPreferenceKey,
  type GeneralPreferenceSettings,
} from "./GeneralPreferences";
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

type GeneralFailure = {
  patch: Partial<GeneralPreferenceSettings>;
};

const generalPreferenceKeys: GeneralPreferenceKey[] = [
  "theme",
  "captureRetention",
  "floatingAssistantEnabled",
  "backgroundWarmup",
];

function createGeneralRevisions(): Record<GeneralPreferenceKey, number> {
  return {
    theme: 0,
    captureRetention: 0,
    floatingAssistantEnabled: 0,
    backgroundWarmup: 0,
  };
}

export function SettingsPanel({ view, onSaved }: SettingsPanelProps) {
  const shortcutRevisionRef = useRef(0);
  const generalRevisionsRef = useRef(createGeneralRevisions());
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const [settings, setSettings] = useState<AppSettings>(createDefaultSettings());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsLoadError, setSettingsLoadError] = useState("");
  const [shortcutSavedMessage, setShortcutSavedMessage] = useState("");
  const [shortcutSaveError, setShortcutSaveError] = useState("");
  const [shortcutSaving, setShortcutSaving] = useState(false);
  const [generalSaving, setGeneralSaving] = useState<
    Partial<Record<GeneralPreferenceKey, boolean>>
  >({});
  const [generalFailures, setGeneralFailures] = useState<
    Partial<Record<GeneralPreferenceKey, GeneralFailure>>
  >({});

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
      shortcutRevisionRef.current = 0;
      generalRevisionsRef.current = createGeneralRevisions();
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

  function updateShortcutDraft(shortcut: string) {
    if (!settingsLoaded || settingsLoading) {
      return;
    }
    shortcutRevisionRef.current += 1;
    setSettings((current) => ({ ...current, shortcut }));
    setShortcutSavedMessage("");
    setShortcutSaveError("");
  }

  async function saveGeneralPatch(
    key: GeneralPreferenceKey,
    patch: Partial<GeneralPreferenceSettings>,
  ) {
    if (!settingsLoaded || settingsLoading) {
      return;
    }

    const revision = ++generalRevisionsRef.current[key];
    setSettings((current) => ({ ...current, ...patch }));
    setGeneralSaving((current) => ({ ...current, [key]: true }));
    setGeneralFailures((current) => {
      if (!current[key]) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });

    if (patch.theme) {
      applyTheme(settingsThemeToMode(patch.theme));
    }

    try {
      await updateSettings(patch);
      if (!mountedRef.current || generalRevisionsRef.current[key] !== revision) {
        return;
      }
      onSaved?.();
    } catch {
      if (mountedRef.current && generalRevisionsRef.current[key] === revision) {
        setGeneralFailures((current) => ({ ...current, [key]: { patch } }));
      }
    } finally {
      if (mountedRef.current && generalRevisionsRef.current[key] === revision) {
        setGeneralSaving((current) => ({ ...current, [key]: false }));
      }
    }
  }

  async function handleShortcutSave(event: React.FormEvent) {
    event.preventDefault();
    if (!settingsLoaded || settingsLoading || shortcutSaving) {
      return;
    }
    setShortcutSaving(true);
    setShortcutSavedMessage("");
    setShortcutSaveError("");
    const submittedRevision = shortcutRevisionRef.current;
    const submittedShortcut = settings.shortcut;
    try {
      const next = await updateSettings({ shortcut: submittedShortcut });
      if (!mountedRef.current) {
        return;
      }
      if (shortcutRevisionRef.current === submittedRevision) {
        setSettings((current) => ({ ...current, shortcut: next.shortcut }));
        setShortcutSavedMessage("设置已保存");
      }
      onSaved?.();
    } catch {
      if (mountedRef.current) {
        setShortcutSaveError("无法保存设置，请重试。");
      }
    } finally {
      if (mountedRef.current) {
        setShortcutSaving(false);
      }
    }
  }

  const controlsDisabled = !settingsLoaded || settingsLoading;
  const generalBusy = generalPreferenceKeys.some((key) => generalSaving[key]);
  const loadErrorCallout = settingsLoadError ? (
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
  ) : null;

  if (view === "general") {
    return (
      <div
        className="settings-preferences-panel settings-preferences-panel--general"
        aria-label="通用设置"
        aria-busy={generalBusy || settingsLoading}
      >
        {loadErrorCallout}
        <GeneralPreferences
          settings={settings}
          disabled={controlsDisabled}
          saving={generalSaving}
          onPatch={(key, patch) => void saveGeneralPatch(key, patch)}
        />
        {generalPreferenceKeys.map((key) => {
          const failure = generalFailures[key];
          const label = generalPreferenceLabels[key];
          return failure ? (
            <div className="preference-save-error" role="alert" key={key}>
              <span>{label}未保存，请重试。</span>
              <button
                type="button"
                className="callout__action"
                aria-label={`重试${label}`}
                onClick={() => void saveGeneralPatch(key, failure.patch)}
              >
                重试
              </button>
            </div>
          ) : null;
        })}
      </div>
    );
  }

  return (
    <form
      className="settings-form settings-form--stack settings-preferences-panel"
      aria-label="快捷键设置"
      aria-busy={shortcutSaving || settingsLoading}
      onSubmit={(event) => void handleShortcutSave(event)}
    >
      {loadErrorCallout}
      <section className="settings-section">
        <h2 className="settings-section__title">快捷键</h2>
        <div className="settings-field">
          <span>全局快捷键</span>
          <ShortcutRecorder
            value={settings.shortcut}
            disabled={controlsDisabled}
            onChange={updateShortcutDraft}
          />
        </div>
      </section>
      <div className="settings-form__footer">
        <button
          type="submit"
          className="settings-btn settings-btn--primary"
          disabled={controlsDisabled || shortcutSaving}
        >
          {shortcutSaving ? "保存中…" : "保存设置"}
        </button>
        {shortcutSavedMessage ? <p className="saved-message">{shortcutSavedMessage}</p> : null}
        {shortcutSaveError ? <p className="onboarding-error">{shortcutSaveError}</p> : null}
      </div>
    </form>
  );
}
