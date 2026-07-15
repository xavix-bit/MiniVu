import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EnvironmentSetupPanel } from "./EnvironmentSetupPanel";
import { SettingsSidebar, type SettingsSection } from "./SettingsSidebar";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { modelClient } from "../model/modelClient";
import type { EnvironmentStatus } from "../model/types";
import { ModelPanel } from "../settings/ModelPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadSettings } from "../settings/settingsStore";
import { WorkbenchShell } from "../workbench/WorkbenchShell";
import { captureScreenRegion } from "../image/captureScreen";
import { captureClient } from "../captures/captureClient";
import { processCaptureInBackground } from "../captures/processCapture";

const PAGE_META: Record<SettingsSection, { title: string; subtitle: string }> = {
  home: { title: "", subtitle: "" },
  setup: {
    title: "初始设置",
    subtitle: "",
  },
  model: {
    title: "模型",
    subtitle: "",
  },
  settings: {
    title: "偏好设置",
    subtitle: "",
  },
  privacy: {
    title: "隐私说明",
    subtitle: "",
  },
};

function SubpageLead({ section }: { section: SettingsSection }) {
  const meta = PAGE_META[section];
  return (
    <header className="page-header">
      <h1 className="page-header__title">{meta.title}</h1>
      {meta.subtitle ? <p className="page-header__subtitle">{meta.subtitle}</p> : null}
    </header>
  );
}

export function MainWindowShell() {
  const mainRef = useRef<HTMLElement>(null);
  const workbenchSurfaceRef = useRef<HTMLElement>(null);
  const scrollPositionsRef = useRef<Partial<Record<SettingsSection, number>>>({});
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [section, setSection] = useState<SettingsSection>("setup");
  const [shortcut, setShortcut] = useState("Control+Option+Space");
  const [environmentStatus, setEnvironmentStatus] = useState<EnvironmentStatus | null>(null);
  const [warmupNotice, setWarmupNotice] = useState("");

  async function refreshEnvironmentStatus() {
    try {
      const status = await modelClient.getEnvironmentStatus();
      setEnvironmentStatus(status);
    } catch {
      setEnvironmentStatus(null);
    }
  }

  useEffect(() => {
    document.documentElement.classList.add("main-window");
    return () => document.documentElement.classList.remove("main-window");
  }, []);

  useEffect(() => {
    void loadSettings()
      .then((settings) => {
        setOnboardingDone(settings.onboardingComplete);
        setShortcut(settings.shortcut);

        if (!settings.onboardingComplete) {
          setSection("setup");
          return;
        }

        setSection("home");
        void refreshEnvironmentStatus();
      })
      .catch(() => {
        setOnboardingDone(false);
        setSection("setup");
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

  function handleSetupComplete() {
    setOnboardingDone(true);
    setSection("home");
    void loadSettings().then((settings) => setShortcut(settings.shortcut));
    void refreshEnvironmentStatus();
  }

  // 仅解锁侧栏 + 刷新状态，不强制离开当前（成功）页面。
  function handleSetupSucceeded() {
    setOnboardingDone(true);
    void refreshEnvironmentStatus();
  }

  const activeSection = onboardingDone ? section : "setup";

  useLayoutEffect(() => {
    if (activeSection !== "home" && mainRef.current) {
      mainRef.current.scrollTop = scrollPositionsRef.current[activeSection] ?? 0;
    }
    const focusTarget = activeSection === "home" ? workbenchSurfaceRef.current : mainRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, [activeSection]);

  const handleNavigate = useCallback((next: SettingsSection) => {
    if (!onboardingDone && next !== "setup") {
      return;
    }
    setSection((current) => {
      if (mainRef.current) {
        scrollPositionsRef.current[onboardingDone ? current : "setup"] = mainRef.current.scrollTop;
      }
      return next;
    });
  }, [onboardingDone]);

  function handleTopbarAction() {
    if (environmentStatus?.environmentReady) {
      void invoke("show_quick_panel");
      return;
    }
    handleNavigate("setup");
  }

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

  const handleOpenSettings = useCallback(() => {
    handleNavigate("settings");
  }, [handleNavigate]);

  const handleCapture = useCallback(() => {
    void handleWorkbenchCapture();
  }, [handleWorkbenchCapture]);

  const workbenchActive = onboardingDone && activeSection === "home";

  return (
    <div className="main-surface-stack">
      {onboardingDone ? (
        <section
          ref={workbenchSurfaceRef}
          className={`main-surface main-surface--workbench${workbenchActive ? " is-active" : ""}`}
          aria-hidden={!workbenchActive}
          inert={!workbenchActive}
          tabIndex={-1}
        >
          <WorkbenchShell
            onOpenSettings={handleOpenSettings}
            onCapture={handleCapture}
          />
        </section>
      ) : null}

      <section
        className={`main-surface main-surface--settings${workbenchActive ? "" : " is-active"}`}
        aria-hidden={workbenchActive}
        inert={workbenchActive}
      >
        <div className="settings-app">
          <SettingsSidebar
            active={activeSection}
            shortcut={shortcut}
            modelReady={environmentStatus?.environmentReady ?? false}
            setupOnly={!onboardingDone}
            onNavigate={handleNavigate}
            onOpenSetup={() => handleNavigate("setup")}
          />

          <main ref={mainRef} className="settings-main" tabIndex={-1}>
            <header className="product-topbar" aria-label="状态栏">
              <button type="button" className="product-topbar__primary" onClick={handleTopbarAction}>
                {environmentStatus?.environmentReady ? "打开面板" : "配置"}
              </button>
              <button type="button" className="product-topbar__settings" onClick={() => handleNavigate("settings")} aria-label="打开设置">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8 3.5c0-.8-.1-1.5-.4-2.2l1.6-1.2-1.6-2.8-1.9.8a8 8 0 0 0-1.9-1.1L15.5 3h-7l-.3 2a8 8 0 0 0-1.9 1.1l-1.9-.8-1.6 2.8 1.6 1.2A7.5 7.5 0 0 0 4 12c0 .8.1 1.5.4 2.2l-1.6 1.2 1.6 2.8 1.9-.8c.6.5 1.2.8 1.9 1.1l.3 2h7l.3-2c.7-.3 1.3-.6 1.9-1.1l1.9.8 1.6-2.8-1.6-1.2c.3-.7.4-1.4.4-2.2Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
              </button>
            </header>
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
                <div className={`settings-page-view${activeSection === "setup" ? " is-active" : ""}`}>
                  <SubpageLead section="setup" />
                  <div className="settings-page-body">
                    <EnvironmentSetupPanel
                      showWelcome={!onboardingDone}
                      onComplete={handleSetupComplete}
                      onSetupSucceeded={handleSetupSucceeded}
                    />
                  </div>
                </div>

                <div className={`settings-page-view${activeSection === "model" ? " is-active" : ""}`}>
                  <SubpageLead section="model" />
                  <div className="settings-page-body">
                    <ModelPanel
                      onOpenSetup={() => handleNavigate("setup")}
                      onStatusChange={() => void refreshEnvironmentStatus()}
                    />
                  </div>
                </div>

                <div className={`settings-page-view${activeSection === "settings" ? " is-active" : ""}`}>
                  <SubpageLead section="settings" />
                  <div className="settings-page-body">
                    <SettingsPanel
                      onSaved={() => {
                        void loadSettings().then((settings) => setShortcut(settings.shortcut));
                        void refreshEnvironmentStatus();
                      }}
                    />
                  </div>
                </div>

                <div className={`settings-page-view${activeSection === "privacy" ? " is-active" : ""}`}>
                  <SubpageLead section="privacy" />
                  <div className="settings-page-body">
                    <PrivacyNotice />
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      </section>
    </div>
  );
}
