import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HomeOverview } from "./HomeOverview";
import { EnvironmentSetupPanel } from "./EnvironmentSetupPanel";
import { SettingsSidebar, type SettingsSection } from "./SettingsSidebar";
import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { ModelPanel } from "../settings/ModelPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { loadSettings } from "../settings/settingsStore";

const PAGE_META: Record<SettingsSection, { title: string; subtitle: string }> = {
  home: { title: "", subtitle: "" },
  setup: {
    title: "环境配置",
    subtitle: "首次使用或环境异常时，一键安装推理引擎、下载模型并配置快捷键",
  },
  model: {
    title: "模型文件",
    subtitle: "下载并查看当前推理后端所需的模型权重（MLX 约 2 GB，或 GGUF 约 6 GB）",
  },
  settings: {
    title: "偏好设置",
    subtitle: "推理引擎、模型下载、快捷键与性能选项",
  },
  privacy: {
    title: "隐私说明",
    subtitle: "了解 MiniVu 如何处理你的数据",
  },
};

export function MainWindowShell() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [section, setSection] = useState<SettingsSection>("home");
  const [shortcut, setShortcut] = useState("Control+Option+Space");
  const [modelReady, setModelReady] = useState(false);

  async function refreshModelStatus() {
    const status = await invoke<{ modelReady: boolean }>("get_model_status");
    setModelReady(status.modelReady);
  }

  useEffect(() => {
    document.documentElement.classList.add("main-window");
    return () => document.documentElement.classList.remove("main-window");
  }, []);

  useEffect(() => {
    void loadSettings().then((settings) => {
      setOnboardingDone(settings.onboardingComplete);
      setShortcut(settings.shortcut);

      if (!settings.onboardingComplete) {
        setSection("setup");
        return;
      }

      void refreshModelStatus();
    });
  }, []);

  function handleSetupComplete() {
    setOnboardingDone(true);
    setSection("home");
    void loadSettings().then((settings) => setShortcut(settings.shortcut));
    void refreshModelStatus();
  }

  if (onboardingDone === null) {
    return (
      <div className="settings-app settings-app--loading">
        <div className="ambient-glow" aria-hidden="true" />
        <p className="placeholder-copy reveal">正在加载…</p>
      </div>
    );
  }

  const activeSection = onboardingDone ? section : "setup";

  function handleNavigate(next: SettingsSection) {
    if (!onboardingDone && next !== "setup") {
      return;
    }
    setSection(next);
  }

  const pageMeta = PAGE_META[activeSection];

  return (
    <div className="settings-app">
      <div className="ambient-glow" aria-hidden="true" />
      <div className="ambient-glow ambient-glow--secondary" aria-hidden="true" />
      <SettingsSidebar
        active={activeSection}
        shortcut={shortcut}
        modelReady={modelReady}
        setupOnly={!onboardingDone}
        onNavigate={handleNavigate}
        onOpenSetup={() => handleNavigate("setup")}
      />

      <main className="settings-main">
        {activeSection === "home" ? (
          <HomeOverview modelReady={modelReady} onOpenSetup={() => handleNavigate("setup")} />
        ) : (
          <div className="settings-page">
            <header className="settings-page-header reveal reveal--1">
              {activeSection === "setup" ? (
                <div className="section-label">
                  <span className="section-label__dot" aria-hidden="true" />
                  <span className="section-label__text">环境配置</span>
                </div>
              ) : null}
              <h1>{pageMeta.title}</h1>
              <p>{pageMeta.subtitle}</p>
            </header>
            <div className="settings-page-body reveal reveal--2">
              {activeSection === "setup" ? (
                <EnvironmentSetupPanel showWelcome={!onboardingDone} onComplete={handleSetupComplete} />
              ) : null}
              {activeSection === "model" ? (
                <ModelPanel onOpenSetup={() => handleNavigate("setup")} />
              ) : null}
              {activeSection === "settings" ? (
                <SettingsPanel
                  onSaved={() => {
                    void loadSettings().then((settings) => setShortcut(settings.shortcut));
                  }}
                />
              ) : null}
              {activeSection === "privacy" ? <PrivacyNotice /> : null}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
