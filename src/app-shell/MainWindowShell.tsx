import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { AppRail, type AppRailDestination } from "./AppRail";
import { EnvironmentSetupPanel } from "./EnvironmentSetupPanel";
import { FirstRunWelcome, type FirstRunWelcomeState } from "./FirstRunWelcome";
import {
  SettingsNavigationPane,
  type SettingsSection,
} from "./SettingsNavigationPane";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { modelClient } from "../model/modelClient";
import type { ModelStatusResponse } from "../model/types";
import { ModelPanel } from "../settings/ModelPanel";
import { ModelPreferencesPanel } from "../settings/ModelPreferencesPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadSettings, updateSettings } from "../settings/settingsStore";
import { WorkbenchShell } from "../workbench/WorkbenchShell";
import {
  CaptureError,
  captureScreenRegion,
  openScreenRecordingSettings,
} from "../image/captureScreen";
import { captureClient } from "../captures/captureClient";
import { processCaptureInBackground } from "../captures/processCapture";

type AppMode = "workbench" | "settings";
type WorkbenchScope = "recent" | "pinned";
type ModelReturnContext = { recordId: string; prompt: string };
type StartupState =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "welcome"; shortcut: string }
  | { kind: "ready" };

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
  const welcomeSurfaceRef = useRef<HTMLElement>(null);
  const scrollPositionsRef = useRef<Partial<Record<SettingsSection, number>>>({});
  const modeRef = useRef<AppMode>("settings");
  const settingsSectionRef = useRef<SettingsSection>("setup");
  const mountedRef = useRef(false);
  const startupGenerationRef = useRef(0);
  const welcomeGenerationRef = useRef(0);
  const welcomePendingRef = useRef(false);
  const settingsOpenPendingRef = useRef(false);
  const workbenchTipsCompleteRef = useRef(true);
  const tipsSavePendingRef = useRef(false);
  const [startupState, setStartupState] = useState<StartupState>({ kind: "loading" });
  const [surfaceMotionReady, setSurfaceMotionReady] = useState(false);
  const [welcomeState, setWelcomeState] = useState<FirstRunWelcomeState>({ kind: "idle" });
  const [mode, setMode] = useState<AppMode>("settings");
  const [workbenchScope, setWorkbenchScope] = useState<WorkbenchScope>("recent");
  const [requestedRecordId, setRequestedRecordId] = useState<string | null>(null);
  const [requestedDraft, setRequestedDraft] = useState<ModelReturnContext | null>(null);
  const [tipsRecordId, setTipsRecordId] = useState<string | null>(null);
  const [workbenchNotice, setWorkbenchNotice] = useState("");
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [modelReturnContext, setModelReturnContext] = useState<ModelReturnContext | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("setup");
  const [warmupNotice, setWarmupNotice] = useState("");
  const [runtimeRepairOpen, setRuntimeRepairOpen] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [modelPreferencesBusy, setModelPreferencesBusy] = useState(false);
  const [modelPanelBusy, setModelPanelBusy] = useState(false);
  const [modelRefreshToken, setModelRefreshToken] = useState(0);
  const modelOperationBusy = modelPreferencesBusy || modelPanelBusy;
  const modelControlsDisabled = runtimeRepairOpen || repairBusy || modelOperationBusy;

  useEffect(() => {
    document.documentElement.classList.add("main-window");
    return () => document.documentElement.classList.remove("main-window");
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<ModelReturnContext>("model-required", (event) => {
      if (!active) return;
      setModelReturnContext(event.payload);
      setRequestedRecordId(event.payload.recordId);
      setRequestedDraft(event.payload);
      setSettingsSection("model");
      setMode("settings");
    }).then((cleanup) => {
      if (active) {
        unlisten = cleanup;
      } else {
        cleanup();
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const loadStartupSettings = useCallback(() => {
    const generation = ++startupGenerationRef.current;
    setStartupState({ kind: "loading" });
    void loadSettings()
      .then((settings) => {
        if (!mountedRef.current || startupGenerationRef.current !== generation) return;
        workbenchTipsCompleteRef.current = settings.workbenchTipsComplete ?? false;
        setTipsRecordId(null);
        if (settings.onboardingComplete) {
          setSettingsSection("general");
          setMode("workbench");
          setStartupState({ kind: "ready" });
        } else {
          setStartupState({ kind: "welcome", shortcut: settings.shortcut });
        }
      })
      .catch(() => {
        if (!mountedRef.current || startupGenerationRef.current !== generation) return;
        setStartupState({ kind: "load-error" });
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadStartupSettings();
    return () => {
      mountedRef.current = false;
      startupGenerationRef.current += 1;
      welcomeGenerationRef.current += 1;
      welcomePendingRef.current = false;
      settingsOpenPendingRef.current = false;
      tipsSavePendingRef.current = false;
    };
  }, [loadStartupSettings]);

  useEffect(() => {
    if (startupState.kind === "loading" || surfaceMotionReady) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setSurfaceMotionReady(true));
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [startupState.kind, surfaceMotionReady]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ message: string }>("warmup-failed", (event) => {
      if (active) {
        setWarmupNotice(event.payload.message);
      }
    }).then((cleanup) => {
      if (active) {
        unlisten = cleanup;
      } else {
        cleanup();
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const onboardingDone = startupState.kind === "ready";
  const activeSection = onboardingDone ? settingsSection : "setup";
  const workbenchActive = onboardingDone && mode === "workbench";
  const settingsActive = onboardingDone && mode === "settings";
  const welcomeActive = !onboardingDone;
  modeRef.current = mode;
  settingsSectionRef.current = activeSection;

  useLayoutEffect(() => {
    const focusTarget = workbenchActive
      ? workbenchSurfaceRef.current
      : settingsActive
        ? settingsMainRef.current
        : welcomeSurfaceRef.current;
    focusTarget?.focus({ preventScroll: true });
  }, [settingsActive, startupState.kind, workbenchActive]);

  useLayoutEffect(() => {
    if (settingsActive && settingsMainRef.current) {
      settingsMainRef.current.scrollTop = scrollPositionsRef.current[activeSection] ?? 0;
    }
  }, [activeSection, settingsActive]);

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

  const refreshEnvironmentStatus = useCallback(async () => {
    try {
      const status = await modelClient.getEnvironmentStatus();
      if (mountedRef.current) setModelReady(status.modelReady);
      return status;
    } catch {
      // The active settings view remains usable if a status refresh fails.
      return null;
    }
  }, []);

  useEffect(() => {
    if (onboardingDone) void refreshEnvironmentStatus();
  }, [onboardingDone, refreshEnvironmentStatus]);

  const handleModelStatusChange = useCallback((status: Pick<ModelStatusResponse, "modelReady">) => {
    setModelReady(status.modelReady);
    if (!status.modelReady || !modelReturnContext) return;

    setWorkbenchScope("recent");
    setModelReturnContext(null);
    setMode("workbench");
  }, [modelReturnContext]);

  const handleModelPreferencesSaved = useCallback(() => {
    setModelRefreshToken((current) => current + 1);
    void refreshEnvironmentStatus().then((status) => {
      if (status) handleModelStatusChange(status);
    });
  }, [handleModelStatusChange, refreshEnvironmentStatus]);

  const handleRepairRuntime = useCallback(() => {
    if (modelOperationBusy || repairBusy) {
      return;
    }
    setRuntimeRepairOpen(true);
  }, [modelOperationBusy, repairBusy]);

  const handleRuntimeRepairSucceeded = useCallback(() => {
    setRepairBusy(false);
    setRuntimeRepairOpen(false);
    setModelRefreshToken((current) => current + 1);
    void refreshEnvironmentStatus().then((status) => {
      if (status) handleModelStatusChange(status);
    });
  }, [handleModelStatusChange, refreshEnvironmentStatus]);

  const handleRuntimeRepairCancelled = useCallback(() => {
    setRepairBusy(false);
    setRuntimeRepairOpen(false);
  }, []);

  const handleRequireModel = useCallback(async (context: ModelReturnContext) => {
    const status = await refreshEnvironmentStatus();
    if (status?.modelReady) return true;
    if (!mountedRef.current) return false;

    setModelReturnContext(context);
    setRequestedRecordId(context.recordId);
    setSettingsSection("model");
    setMode("settings");
    return false;
  }, [refreshEnvironmentStatus]);

  const handleTipsComplete = useCallback(() => {
    setTipsRecordId(null);
    if (workbenchTipsCompleteRef.current || tipsSavePendingRef.current) return;

    workbenchTipsCompleteRef.current = true;
    tipsSavePendingRef.current = true;
    void updateSettings({ workbenchTipsComplete: true })
      .catch(() => {
        if (mountedRef.current) {
          setWorkbenchNotice("提示已关闭，但暂时无法记住这个选择。");
        }
      })
      .finally(() => {
        tipsSavePendingRef.current = false;
      });
  }, []);

  const handleWorkbenchCapture = useCallback(async () => {
    try {
      const image = await captureScreenRegion();
      const settings = await loadSettings();
      const record = await captureClient.create({
        dataUrl: image.dataUrl,
        source: "capture",
        retention: settings.captureRetention ?? "24h",
      });
      setRequestedRecordId(record.id);
      setWorkbenchNotice("");
      if (!workbenchTipsCompleteRef.current && !(settings.workbenchTipsComplete ?? false)) {
        setTipsRecordId(record.id);
      }
      processCaptureInBackground(record.id, image.dataUrl, {
        warmup: settings.backgroundWarmup ?? false,
      });
    } catch (error) {
      if (error instanceof CaptureError && error.code === "cancelled") return;
      setWorkbenchNotice(
        error instanceof CaptureError && error.code === "permission-denied"
          ? "需要屏幕录制权限，请在系统设置中允许后重试。"
          : "截图没有保存，请重试。",
      );
    }
  }, []);

  const handleCapture = useCallback(() => {
    void handleWorkbenchCapture();
  }, [handleWorkbenchCapture]);

  const enterWorkbench = useCallback((notice = "") => {
    setWorkbenchNotice(notice);
    setSettingsSection("general");
    setMode("workbench");
    setStartupState({ kind: "ready" });
  }, []);

  const handleWelcomeCapture = useCallback(async () => {
    if (welcomePendingRef.current) return;
    welcomePendingRef.current = true;
    settingsOpenPendingRef.current = false;
    const generation = ++welcomeGenerationRef.current;
    const isCurrent = () => mountedRef.current && welcomeGenerationRef.current === generation;
    setWelcomeState({ kind: "capturing" });

    try {
      const image = await captureScreenRegion();
      if (!isCurrent()) return;
      const settings = await loadSettings();
      if (!isCurrent()) return;
      const record = await captureClient.create({
        dataUrl: image.dataUrl,
        source: "capture",
        retention: settings.captureRetention ?? "24h",
      });
      if (!isCurrent()) return;

      setRequestedRecordId(record.id);
      if (!workbenchTipsCompleteRef.current && !(settings.workbenchTipsComplete ?? false)) {
        setTipsRecordId(record.id);
      }
      processCaptureInBackground(record.id, image.dataUrl);

      let saveFailed = false;
      try {
        await updateSettings({ onboardingComplete: true });
      } catch {
        saveFailed = true;
      }
      if (!isCurrent()) return;
      enterWorkbench(saveFailed ? "截图已保存，但首次设置未能保存。" : "");
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof CaptureError && error.code === "cancelled") {
        setWelcomeState({ kind: "idle" });
      } else if (error instanceof CaptureError && error.code === "permission-denied") {
        setWelcomeState({ kind: "permission-denied" });
      } else {
        setWelcomeState({ kind: "idle", notice: "capture-failed" });
      }
    } finally {
      if (welcomeGenerationRef.current === generation) {
        welcomePendingRef.current = false;
      }
    }
  }, [enterWorkbench]);

  const handleOpenScreenRecordingSettings = useCallback(async () => {
    if (settingsOpenPendingRef.current) return;
    settingsOpenPendingRef.current = true;
    const generation = ++welcomeGenerationRef.current;
    try {
      await openScreenRecordingSettings();
    } catch {
      if (mountedRef.current && welcomeGenerationRef.current === generation) {
        setWelcomeState({ kind: "permission-denied", settingsOpenFailed: true });
      }
    } finally {
      if (welcomeGenerationRef.current === generation) {
        settingsOpenPendingRef.current = false;
      }
    }
  }, []);

  const handleWelcomeSkip = useCallback(async () => {
    if (welcomePendingRef.current) return;
    welcomePendingRef.current = true;
    settingsOpenPendingRef.current = false;
    const generation = ++welcomeGenerationRef.current;
    const isCurrent = () => mountedRef.current && welcomeGenerationRef.current === generation;
    setWelcomeState({ kind: "skipping" });

    try {
      await loadSettings();
      if (!isCurrent()) return;
      await updateSettings({ onboardingComplete: true });
      if (!isCurrent()) return;
      setRequestedRecordId(null);
      enterWorkbench();
    } catch {
      if (isCurrent()) {
        setWelcomeState({ kind: "idle", notice: "save-failed" });
      }
    } finally {
      if (welcomeGenerationRef.current === generation) {
        welcomePendingRef.current = false;
      }
    }
  }, [enterWorkbench]);

  const railActive: AppRailDestination | null = onboardingDone
    ? mode === "settings" ? "settings" : workbenchScope
    : null;
  const preferencesActive = activeSection === "general" || activeSection === "shortcut";

  return (
    <div className="unified-app-shell">
      <AppRail
        active={railActive}
        disabled={!onboardingDone}
        onNavigate={handleRailNavigate}
      />

      <div className={`main-surface-stack${surfaceMotionReady ? " is-motion-ready" : ""}`}>
        <section
          ref={workbenchSurfaceRef}
          className={`main-surface main-surface--workbench${workbenchActive ? " is-active" : ""}`}
          aria-hidden={!workbenchActive}
          inert={!workbenchActive}
          tabIndex={-1}
        >
          <WorkbenchShell
            scope={workbenchScope}
            onCapture={handleCapture}
            requestedRecordId={requestedRecordId}
            requestedDraft={requestedDraft}
            modelReady={modelReady === true}
            onRequireModel={handleRequireModel}
            showTips={tipsRecordId !== null}
            onTipsComplete={handleTipsComplete}
          />
          {workbenchNotice ? (
            <div className="workbench-onboarding-notice" role="status">
              <span>{workbenchNotice}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setWorkbenchNotice("")}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </section>

        <section
          className={`main-surface main-surface--settings${settingsActive ? " is-active" : ""}`}
          aria-hidden={!settingsActive}
          inert={!settingsActive}
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
                    <p>准备暂时失败，请稍后重试。</p>
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
                      {onboardingDone && activeSection === "setup" ? (
                        <EnvironmentSetupPanel
                          showWelcome={false}
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
                          {modelReturnContext ? (
                            <div className="callout callout--attention" role="status">
                              <p>安装一个模型后，会回到刚才的问题。</p>
                            </div>
                          ) : null}
                          <ModelPreferencesPanel
                            disabled={modelControlsDisabled}
                            onBusyChange={setModelPreferencesBusy}
                            onSaved={handleModelPreferencesSaved}
                          />
                          <ModelPanel
                            disabled={modelControlsDisabled}
                            onBusyChange={setModelPanelBusy}
                            onRepairRuntime={handleRepairRuntime}
                            onStatusChange={handleModelStatusChange}
                            refreshToken={modelRefreshToken}
                          />
                          {runtimeRepairOpen ? (
                            <EnvironmentSetupPanel
                              showWelcome={false}
                              onBusyChange={setRepairBusy}
                              onCancel={handleRuntimeRepairCancelled}
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

        <section
          ref={welcomeSurfaceRef}
          className={`main-surface main-surface--welcome${welcomeActive ? " is-active" : ""}`}
          aria-hidden={!welcomeActive}
          inert={!welcomeActive}
          tabIndex={-1}
        >
          {startupState.kind === "loading" ? (
            <div className="startup-state" role="status">正在载入 MiniVu</div>
          ) : startupState.kind === "load-error" ? (
            <div className="startup-state startup-state--error" role="alert">
              <p>暂时无法载入设置。</p>
              <button type="button" onClick={loadStartupSettings}>重试</button>
            </div>
          ) : startupState.kind === "welcome" ? (
            <FirstRunWelcome
              shortcut={startupState.shortcut}
              state={welcomeState}
              onCapture={() => void handleWelcomeCapture()}
              onSkip={() => void handleWelcomeSkip()}
              onOpenScreenRecordingSettings={() => void handleOpenScreenRecordingSettings()}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
