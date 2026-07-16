import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppRail, type AppRailDestination } from "./AppRail";
import { EnvironmentSetupPanel } from "./EnvironmentSetupPanel";
import {
  SettingsNavigationPane,
  type SettingsSection,
} from "./SettingsNavigationPane";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { modelClient } from "../model/modelClient";
import { ModelPanel } from "../settings/ModelPanel";
import { ModelPreferencesPanel } from "../settings/ModelPreferencesPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadSettings } from "../settings/settingsStore";
import { WorkbenchShell } from "../workbench/WorkbenchShell";
import { captureScreenRegion } from "../image/captureScreen";
import { captureClient } from "../captures/captureClient";
import { processCaptureInBackground } from "../captures/processCapture";

type AppMode = "workbench" | "settings";
type WorkbenchScope = "recent" | "pinned";

const PAGE_META: Record<SettingsSection, { title: string; subtitle: string }> = {
  setup: { title: "初始设置", subtitle: "" },
  general: { title: "通用", subtitle: "" },
  model: { title: "模型", subtitle: "" },
  shortcut: { title: "快捷键", subtitle: "" },
  privacy: { title: "隐私", subtitle: "" },
};

function SubpageLead({ section }: { section: SettingsSection }) {
  const meta = PAGE_META[section];
  return (
    <header className="page-header page-header--compact">
      <h1 className="page-header__title">{meta.title}</h1>
      {meta.subtitle ? <p className="page-header__subtitle">{meta.subtitle}</p> : null}
    </header>
  );
}

export function MainWindowShell() {
  const settingsMainRef = useRef<HTMLElement>(null);
  const workbenchSurfaceRef = useRef<HTMLElement>(null);
  const scrollPositionsRef = useRef<Partial<Record<SettingsSection, number>>>({});
  const modeRef = useRef<AppMode>("settings");
  const settingsSectionRef = useRef<SettingsSection>("setup");
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [mode, setMode] = useState<AppMode>("settings");
  const [workbenchScope, setWorkbenchScope] = useState<WorkbenchScope>("recent");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("setup");
  const [warmupNotice, setWarmupNotice] = useState("");
  const [runtimeRepairOpen, setRuntimeRepairOpen] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [modelRefreshToken, setModelRefreshToken] = useState(0);

  useEffect(() => {
    document.documentElement.classList.add("main-window");
    return () => document.documentElement.classList.remove("main-window");
  }, []);

  useEffect(() => {
    void loadSettings()
      .then((settings) => {
        setOnboardingDone(settings.onboardingComplete);
        if (settings.onboardingComplete) {
          setSettingsSection("general");
          setMode("workbench");
        } else {
          setSettingsSection("setup");
          setMode("settings");
        }
      })
      .catch(() => {
        setOnboardingDone(false);
        setSettingsSection("setup");
        setMode("settings");
      });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ message: string }>("warmup-failed", (event) => {
      setWarmupNotice(event.payload.message);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const activeSection = onboardingDone ? settingsSection : "setup";
  const workbenchActive = onboardingDone && mode === "workbench";
  modeRef.current = mode;
  settingsSectionRef.current = activeSection;

  useLayoutEffect(() => {
    const focusTarget = workbenchActive ? workbenchSurfaceRef.current : settingsMainRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, [workbenchActive]);

  useLayoutEffect(() => {
    if (!workbenchActive && settingsMainRef.current) {
      settingsMainRef.current.scrollTop = scrollPositionsRef.current[activeSection] ?? 0;
    }
  }, [activeSection, workbenchActive]);

  const handleSettingsNavigate = useCallback((next: SettingsSection) => {
    setSettingsSection((current) => {
      if (settingsMainRef.current) {
        scrollPositionsRef.current[current] = settingsMainRef.current.scrollTop;
      }
      return next;
    });
  }, []);

  const handleRailNavigate = useCallback((destination: AppRailDestination) => {
    if (modeRef.current === "settings" && settingsMainRef.current) {
      scrollPositionsRef.current[settingsSectionRef.current] = settingsMainRef.current.scrollTop;
    }
    if (destination === "settings") {
      setSettingsSection("general");
      setMode("settings");
      return;
    }
    setWorkbenchScope(destination);
    setMode("workbench");
  }, []);

  const handleSetupComplete = useCallback(() => {
    setOnboardingDone(true);
    setSettingsSection("general");
    setMode("workbench");
  }, []);

  const handleSetupSucceeded = useCallback(() => {
    setOnboardingDone(true);
  }, []);

  const refreshEnvironmentStatus = useCallback(async () => {
    try {
      const status = await modelClient.getEnvironmentStatus();
      if (typeof status.onboardingComplete === "boolean") {
        setOnboardingDone(status.onboardingComplete);
      }
    } catch {
      // The active settings view remains usable if a status refresh fails.
    }
  }, []);

  const handleModelPreferencesSaved = useCallback(() => {
    setModelRefreshToken((current) => current + 1);
  }, []);

  const handleRepairRuntime = useCallback(() => {
    setRuntimeRepairOpen(true);
  }, []);

  const handleRuntimeRepairSucceeded = useCallback(() => {
    setRepairBusy(false);
    setRuntimeRepairOpen(false);
    setModelRefreshToken((current) => current + 1);
    void refreshEnvironmentStatus();
  }, [refreshEnvironmentStatus]);

  const handleWorkbenchCapture = useCallback(async () => {
    const image = await captureScreenRegion();
    const settings = await loadSettings();
    const record = await captureClient.create({
      dataUrl: image.dataUrl,
      source: "capture",
      retention: settings.captureRetention ?? "24h",
    });
    processCaptureInBackground(record.id, image.dataUrl);
  }, []);

  const handleCapture = useCallback(() => {
    void handleWorkbenchCapture();
  }, [handleWorkbenchCapture]);

  const railActive: AppRailDestination = mode === "settings" ? "settings" : workbenchScope;
  const preferencesActive = activeSection === "general" || activeSection === "shortcut";

  return (
    <div className="unified-app-shell">
      <AppRail
        active={railActive}
        disabled={!onboardingDone}
        onNavigate={handleRailNavigate}
      />

      <div className="main-surface-stack">
        <section
          ref={workbenchSurfaceRef}
          className={`main-surface main-surface--workbench${workbenchActive ? " is-active" : ""}`}
          aria-hidden={!workbenchActive}
          inert={!workbenchActive}
          tabIndex={-1}
        >
          <WorkbenchShell scope={workbenchScope} onCapture={handleCapture} />
        </section>

        <section
          className={`main-surface main-surface--settings${workbenchActive ? "" : " is-active"}`}
          aria-hidden={workbenchActive}
          inert={workbenchActive}
        >
          <div className="settings-app">
            <SettingsNavigationPane
              active={activeSection}
              disabled={!onboardingDone}
              onNavigate={handleSettingsNavigate}
            />

            <main ref={settingsMainRef} className="settings-main" tabIndex={-1}>
              <div className={`settings-page-shell settings-page-shell--${activeSection}`}>
                {warmupNotice ? (
                  <div className="callout callout--attention settings-page-shell__notice" role="status">
                    <p>准备失败：{warmupNotice}</p>
                    <button type="button" className="callout__action" onClick={() => setWarmupNotice("")}>
                      知道了
                    </button>
                  </div>
                ) : null}

                <div className="settings-page-stack">
                  <div
                    className={`settings-page-view${activeSection === "setup" ? " is-active" : ""}`}
                    aria-hidden={activeSection !== "setup"}
                    inert={activeSection !== "setup"}
                  >
                    <SubpageLead section="setup" />
                    <div className="settings-page-body">
                      {activeSection === "setup" ? (
                        <EnvironmentSetupPanel
                          showWelcome={!onboardingDone}
                          onComplete={handleSetupComplete}
                          onSetupSucceeded={handleSetupSucceeded}
                        />
                      ) : null}
                    </div>
                  </div>

                  <div
                    className={`settings-page-view${activeSection === "model" ? " is-active" : ""}`}
                    aria-hidden={activeSection !== "model"}
                    inert={activeSection !== "model"}
                  >
                    <SubpageLead section="model" />
                    <div className="settings-page-body unified-settings-detail">
                      {activeSection !== "setup" ? (
                        <div className="unified-settings-surface">
                          <ModelPreferencesPanel
                            disabled={repairBusy}
                            onSaved={handleModelPreferencesSaved}
                          />
                          <ModelPanel
                            disabled={repairBusy}
                            onRepairRuntime={handleRepairRuntime}
                            onStatusChange={() => void refreshEnvironmentStatus()}
                            refreshToken={modelRefreshToken}
                          />
                          {runtimeRepairOpen ? (
                            <EnvironmentSetupPanel
                              showWelcome={false}
                              onBusyChange={setRepairBusy}
                              onSetupSucceeded={handleRuntimeRepairSucceeded}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div
                    className={`settings-page-view${preferencesActive ? " is-active" : ""}`}
                    aria-hidden={!preferencesActive}
                    inert={!preferencesActive}
                  >
                    <SubpageLead section={activeSection === "shortcut" ? "shortcut" : "general"} />
                    <div className="settings-page-body unified-settings-detail">
                      <div className="unified-settings-surface">
                        <SettingsPanel view={activeSection === "shortcut" ? "shortcut" : "general"} />
                      </div>
                    </div>
                  </div>

                  <div
                    className={`settings-page-view${activeSection === "privacy" ? " is-active" : ""}`}
                    aria-hidden={activeSection !== "privacy"}
                    inert={activeSection !== "privacy"}
                  >
                    <SubpageLead section="privacy" />
                    <div className="settings-page-body unified-settings-detail">
                      <div className="unified-settings-surface">
                        <PrivacyNotice />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </main>
          </div>
        </section>
      </div>
    </div>
  );
}
