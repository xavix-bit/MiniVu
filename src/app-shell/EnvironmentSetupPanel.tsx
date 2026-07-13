import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { modelClient } from "../model/modelClient";
import type { EnvironmentStatus, ModelStatusResponse } from "../model/types";
import { resolveGgufPercent, resolveMlxPercent } from "../shared/downloadProgress";
import type { GgufModelVariant } from "../settings/settingsStore";
import { loadSettings, saveSettings } from "../settings/settingsStore";
import {
  computeOverallPercent,
  createInitialDownloadBytes,
  createInitialProgress,
  mergeDownloadBytes,
  mergeProgress,
  type DownloadBytes,
  type SetupProgress,
} from "./onboardingProgress";

type SetupResult = {
  runtimeReady: boolean;
  modelReady: boolean;
  shortcut: string;
};

type ModelStatus = ModelStatusResponse;

type EnvironmentSetupPanelProps = {
  showWelcome?: boolean;
  onComplete?: () => void;
  onSetupSucceeded?: () => void;
};

const SETUP_STEPS = ["device", "runtime", "image", "shortcut"] as const;

const PHASE_LABELS: Record<(typeof SETUP_STEPS)[number], string> = {
  device: "设备检查",
  runtime: "应用组件",
  image: "图片理解",
  shortcut: "快捷键",
};

function progressMessage(status: SetupProgress["status"]): string {
  if (status === "done") return "已完成";
  if (status === "error") return "未完成，请重试";
  if (status === "switching") return "正在尝试其他下载来源…";
  if (status === "running") return "正在准备…";
  return "等待中";
}

export function EnvironmentSetupPanel({ showWelcome = false, onComplete, onSetupSucceeded }: EnvironmentSetupPanelProps) {
  const [phase, setPhase] = useState<"idle" | "running" | "success" | "error">("idle");
  const [installError, setInstallError] = useState("");
  const [progress, setProgress] = useState<Record<string, SetupProgress>>(createInitialProgress);
  const [downloadBytes, setDownloadBytes] = useState<DownloadBytes>(createInitialDownloadBytes);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [activeSpeedMbps, setActiveSpeedMbps] = useState<number | null>(null);
  const successHandledRef = useRef(false);

  const overallPercent = useMemo(
    () => computeOverallPercent(progress, downloadBytes),
    [progress, downloadBytes],
  );

  function markSuccess(environment: EnvironmentStatus, shortcut: string) {
    setPhase("success");
    setResult({
      runtimeReady: environment.runtimeReady,
      modelReady: environment.modelReady,
      shortcut,
    });
    if (!successHandledRef.current) {
      successHandledRef.current = true;
      onSetupSucceeded?.();
    }
  }

  async function persistOnboardingAndRefresh(environment: EnvironmentStatus) {
    if (!environment.runtimeReady || !environment.modelReady) {
      return null;
    }

    let settings = await loadSettings();
    if (!settings.onboardingComplete) {
      settings = { ...settings, onboardingComplete: true };
      await saveSettings(settings);
    }

    const finalEnvironment = await modelClient.getEnvironmentStatus();
    return { environment: finalEnvironment, settings };
  }

  async function refreshStatus(markReady = false) {
    const [next, environment] = await Promise.all([
      modelClient.getModelStatus(),
      modelClient.getEnvironmentStatus(),
    ]);
    setStatus(next);
    if (markReady && environment.environmentReady) {
      const settings = await loadSettings();
      markSuccess(environment, settings.shortcut);
    }
    return environment;
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshStatus(true);
    }, 100);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    void listen<SetupProgress>("setup-progress", (event) => {
      const payload = event.payload;
      const status =
        payload.status === "error"
          ? "error"
          : payload.status === "done"
            ? "done"
            : payload.status === "waiting"
              ? "waiting"
              : payload.status === "switching"
                ? "switching"
                : "running";
      setProgress((current) =>
        mergeProgress(current, {
          phase: payload.phase,
          status,
          message: progressMessage(status),
          percent: payload.percent,
          speedMbps: status === "running" ? undefined : null,
        }),
      );
    }).then((cleanup) => unlisteners.push(cleanup));

    void listen<{
      file: string;
      status?: string;
      message?: string;
      downloaded: number;
      total: number | null;
      percent?: number;
      source?: string;
      speedMbps?: number;
      variant?: GgufModelVariant;
    }>("model-download-progress", (event) => {
      const { file, status: downloadStatus, downloaded, total, speedMbps, variant } =
        event.payload;

      if (file === "mlx") {
        const speed = speedMbps && speedMbps > 0 ? speedMbps : null;
        if (speed) {
          setActiveSpeedMbps(speed);
        }
        if (downloadStatus === "done") {
          setProgress((current) =>
            mergeProgress(current, {
              phase: "model",
              status: "done",
              message: "已完成",
              percent: 100,
              speedMbps: null,
            }),
          );
          setActiveSpeedMbps(null);
          return;
        }
        setProgress((current) => {
          const resolvedPercent = resolveMlxPercent(current.model?.percent ?? 0, downloaded);
          return mergeProgress(current, {
            phase: "model",
            status: "running",
            message: "正在下载图片理解所需内容…",
            percent: resolvedPercent,
            speedMbps: speed,
          });
        });
        return;
      }

      const phaseKey = file === "mmproj" ? "mmproj" : "model";
      if (downloadStatus === "waiting") {
        setProgress((current) =>
          mergeProgress(current, {
            phase: phaseKey,
            status: "waiting",
            message: "等待中",
            speedMbps: null,
          }),
        );
        if (phaseKey === "mmproj") {
          setActiveSpeedMbps(null);
        }
        return;
      }

      if (downloadStatus === "switching") {
        setProgress((current) =>
          mergeProgress(current, {
            phase: phaseKey,
            status: "switching",
            message: "正在尝试其他下载来源…",
          }),
        );
        return;
      }

      if (downloadStatus === "done") {
        setDownloadBytes((current) => mergeDownloadBytes(current, phaseKey, downloaded, total));
        setProgress((current) =>
          mergeProgress(current, {
            phase: phaseKey,
            status: "done",
            message: "已完成",
            percent: 100,
            speedMbps: null,
          }),
        );
        setActiveSpeedMbps(null);
        return;
      }

      const speed = speedMbps && speedMbps > 0 ? speedMbps : null;

      if (speed) {
        setActiveSpeedMbps(speed);
      }

      setDownloadBytes((current) => mergeDownloadBytes(current, phaseKey, downloaded, total));
      setProgress((current) => {
        const resolvedPercent = resolveGgufPercent(
          current[phaseKey]?.percent ?? 0,
          downloaded,
          total,
          phaseKey,
          variant,
        );
        return mergeProgress(current, {
          phase: phaseKey,
          status: "running",
          message: "正在下载图片理解所需内容…",
          percent: resolvedPercent,
          speedMbps: speed,
        });
      });
    }).then((cleanup) => unlisteners.push(cleanup));

    return () => {
      for (const cleanup of unlisteners) {
        cleanup();
      }
    };
  }, []);

  async function runSetup() {
    successHandledRef.current = false;
    setPhase("running");
    setInstallError("");
    setProgress(createInitialProgress());
    setDownloadBytes(createInitialDownloadBytes());
    setActiveSpeedMbps(null);

    try {
      const setupResult = await invoke<SetupResult>("setup_environment");
      setResult(setupResult);
      setProgress((current) =>
        mergeProgress(current, {
          phase: "done",
          status: "done",
          message: "首次设置完成",
          percent: 100,
        }),
      );
      const environment = await refreshStatus();
      const completed = await persistOnboardingAndRefresh(environment);
      if (!completed?.environment.environmentReady) {
        setInstallError("准备未完成，请重试。仍有问题时，请重新启动应用。");
        setPhase("error");
        return;
      }
      markSuccess(completed.environment, completed.settings.shortcut);
      if (!showWelcome) {
        onComplete?.();
      }
    } catch {
      setInstallError("设置未完成，请检查网络和可用空间后重试。");
      setPhase("error");
    }
  }

  async function finishAndContinue(openPanel: boolean) {
    try {
      const env = await modelClient.getEnvironmentStatus();
      const next = await modelClient.getModelStatus();
      setStatus(next);
      const completed = await persistOnboardingAndRefresh(env);
      if (!completed?.environment.environmentReady) {
        setInstallError("准备未完成，请重试。仍有问题时，请重新启动应用。");
        setPhase("error");
        return;
      }
      onComplete?.();
      if (openPanel) {
        await invoke("show_entry");
      }
    } catch {
      setInstallError("暂时无法继续，请重新启动应用后重试。");
      setPhase("error");
    }
  }

  function renderProgressList() {
    return (
      <>
        <div className="onboarding-overall-progress" aria-label="总体进度">
          <div className="onboarding-overall-progress__bar">
            <span style={{ width: `${overallPercent}%` }} />
          </div>
          <span className="onboarding-overall-progress__label">
            总体进度 {overallPercent}%
            {activeSpeedMbps ? (
              <span className="onboarding-overall-progress__speed">{activeSpeedMbps.toFixed(1)} MB/s</span>
            ) : null}
          </span>
        </div>
        <ul className="onboarding-progress-list">
          {SETUP_STEPS.map((step) => {
            const imageItems = [progress.model, progress.mmproj].filter(Boolean) as SetupProgress[];
            const item = step === "image"
              ? {
                  phase: "image",
                  status: imageItems.every((entry) => entry.status === "done")
                    ? "done"
                    : imageItems.some((entry) => entry.status === "error")
                      ? "error"
                      : imageItems.some((entry) => entry.status === "running" || entry.status === "switching")
                        ? "running"
                        : "waiting",
                  message: "",
                  percent: Math.round(imageItems.reduce((sum, entry) => sum + entry.percent, 0) / Math.max(imageItems.length, 1)),
                  speedMbps: imageItems.find((entry) => entry.speedMbps)?.speedMbps ?? null,
                } satisfies SetupProgress
              : progress[step];
            const label = PHASE_LABELS[step];
            const itemStatus = item?.status ?? "waiting";
            return (
              <li key={step} className={`onboarding-progress-item is-${itemStatus}`}>
                <span className="onboarding-progress-item__icon" aria-hidden="true">
                  {itemStatus === "done" ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : itemStatus === "running" || itemStatus === "switching" ? (
                    <span className="onboarding-progress-item__spinner" />
                  ) : (
                    <span className="onboarding-progress-item__pending" />
                  )}
                </span>
                <div>
                  <strong>{label}</strong>
                  <p>{progressMessage(itemStatus)}</p>
                </div>
                {itemStatus === "running" && item?.speedMbps ? (
                  <span className="onboarding-progress-item__speed">{item.speedMbps.toFixed(1)} MB/s</span>
                ) : null}
                {item && item.percent > 0 && itemStatus !== "done" && itemStatus !== "waiting" ? (
                  <span className="onboarding-progress-item__percent">{item.percent}%</span>
                ) : null}
                {itemStatus === "waiting" ? (
                  <span className="onboarding-progress-item__percent">等待</span>
                ) : null}
                {itemStatus === "done" ? <span className="onboarding-progress-item__percent">完成</span> : null}
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  const applicationReady = status?.inferenceBackend === "mlx"
    ? status?.mlxRuntimeAvailable
    : status?.llamaServerAvailable;
  const statusItems = [
    {
      label: "应用组件",
      value: applicationReady ? "可用" : "未完成",
      ok: applicationReady,
    },
    {
      label: "图片理解",
      value: status?.modelReady ? "已下载" : "未下载",
      ok: status?.modelReady,
    },
    {
      label: "整体状态",
      value: applicationReady && status?.modelReady ? "可用" : "未完成",
      ok: applicationReady && status?.modelReady,
    },
  ];

  return (
    <section className="surface setup-panel">
      {phase === "idle" || phase === "error" ? (
        <>
          <ul className="setup-panel__metrics" aria-label="当前状态">
            {statusItems.map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <strong className={item.ok ? "is-positive" : undefined}>{item.value}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {phase === "running" ? <div className="setup-panel__progress">{renderProgressList()}</div> : null}

      {phase === "success" ? (
        <div className="setup-panel__success">
          <p className="setup-panel__success-lead">配置完成</p>
          <ul className="onboarding-checklist">
            <li className={result?.runtimeReady ? "is-done" : ""}>
              设备检查 已完成
            </li>
            <li className={result?.runtimeReady ? "is-done" : ""}>
              应用组件 {result?.runtimeReady ? "已准备" : "未完成"}
            </li>
            <li className={result?.modelReady ? "is-done" : ""}>
              图片理解 {result?.modelReady ? "已准备" : "未完成"}
            </li>
            <li className="is-done">快捷键：⌃⌥Space</li>
          </ul>
        </div>
      ) : null}

      {installError ? <p className="onboarding-error">{installError}</p> : null}

      <div className="setup-panel__actions">
        {phase === "idle" ? (
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void runSetup()}>
            开始设置（约需 1.6 GiB）
          </button>
        ) : null}

        {phase === "running" ? <p className="setup-panel__running-hint">下载中…</p> : null}

        {phase === "error" ? (
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void runSetup()}>
            重试
          </button>
        ) : null}

        {phase === "success" && showWelcome ? (
          <>
            <button type="button" className="settings-btn settings-btn--primary" onClick={() => void finishAndContinue(true)}>
              打开面板
            </button>
            <button type="button" className="settings-btn settings-btn--secondary" onClick={() => void finishAndContinue(false)}>
              进入首页
            </button>
          </>
        ) : null}

        {phase === "success" && !showWelcome ? (
          <button type="button" className="settings-btn settings-btn--secondary" onClick={() => void runSetup()}>
            重新配置
          </button>
        ) : null}
      </div>
    </section>
  );
}
