import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { modelClient } from "../model/modelClient";
import type { ModelStatusResponse } from "../model/types";
import { resolveGgufPercent, resolveMlxPercent } from "../shared/downloadProgress";
import type { GgufModelVariant } from "../settings/settingsStore";
import { loadSettings, saveSettings } from "../settings/settingsStore";
import {
  PHASE_ORDER,
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

const PHASE_LABELS: Record<string, string> = {
  device: "设备检测",
  runtime: "内置 Metal",
  model: "主模型",
  mmproj: "视觉投影",
  shortcut: "快捷键",
  done: "完成",
};

export function EnvironmentSetupPanel({ showWelcome = false, onComplete, onSetupSucceeded }: EnvironmentSetupPanelProps) {
  const [phase, setPhase] = useState<"idle" | "running" | "success" | "error">("idle");
  const [installError, setInstallError] = useState("");
  const [progress, setProgress] = useState<Record<string, SetupProgress>>(createInitialProgress);
  const [downloadBytes, setDownloadBytes] = useState<DownloadBytes>(createInitialDownloadBytes);
  const [result, setResult] = useState<SetupResult | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [activeSpeedMbps, setActiveSpeedMbps] = useState<number | null>(null);

  const overallPercent = useMemo(
    () => computeOverallPercent(progress, downloadBytes),
    [progress, downloadBytes],
  );

  async function refreshStatus(markReady = false) {
    const next = await modelClient.getModelStatus();
    setStatus(next);
    if (markReady && next.modelReady) {
      const settings = await loadSettings();
      setPhase("success");
      setResult({
        runtimeReady:
          next.inferenceBackend === "mlx" ? !!next.mlxRuntimeAvailable : next.llamaServerAvailable,
        modelReady: next.modelReady,
        shortcut: settings.shortcut,
      });
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshStatus(true);
    }, 100);
    return () => window.clearTimeout(timer);
  }, []);

  // 配置成功即解锁侧栏并持久化 onboardingComplete，无需用户先点「进入首页」。
  const successHandledRef = useRef(false);
  useEffect(() => {
    if (phase !== "success") {
      successHandledRef.current = false;
      return;
    }
    if (successHandledRef.current) {
      return;
    }
    successHandledRef.current = true;
    void (async () => {
      try {
        const latest = await loadSettings();
        if (!latest.onboardingComplete) {
          await saveSettings({ ...latest, onboardingComplete: true });
        }
      } catch {
        /* 持久化失败不阻塞解锁 */
      }
      onSetupSucceeded?.();
    })();
  }, [phase, onSetupSucceeded]);

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
          message: payload.message,
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
      const { file, status: downloadStatus, message, downloaded, total, source, speedMbps, variant } =
        event.payload;

      if (file === "mlx") {
        const sourceHint = source ? `（${source}）` : "";
        const speed = speedMbps && speedMbps > 0 ? speedMbps : null;
        if (speed) {
          setActiveSpeedMbps(speed);
        }
        if (downloadStatus === "done") {
          setProgress((current) =>
            mergeProgress(current, {
              phase: "model",
              status: "done",
              message: message ?? "下载完成",
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
            message: `正在下载 MLX 模型 ${resolvedPercent}%${sourceHint}`,
            percent: resolvedPercent,
            speedMbps: speed,
          });
        });
        return;
      }

      const phaseKey = file === "mmproj" ? "mmproj" : "model";
      const label = file === "mmproj" ? "视觉投影器" : "主模型";

      if (downloadStatus === "waiting") {
        setProgress((current) =>
          mergeProgress(current, {
            phase: phaseKey,
            status: "waiting",
            message: message ?? "等待中…",
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
            message: message ?? "正在切换下载源…",
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
            message: message ?? "下载完成",
            percent: 100,
            speedMbps: null,
          }),
        );
        setActiveSpeedMbps(null);
        return;
      }

      const sourceHint = source ? `（${source}）` : "";
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
          message: `正在下载${label} ${resolvedPercent}%${sourceHint}`,
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
          message: "环境配置完成",
          percent: 100,
        }),
      );
      setPhase("success");
      await refreshStatus(true);
      if (!showWelcome) {
        onComplete?.();
      }
    } catch (error) {
      setInstallError(String(error));
      setPhase("error");
    }
  }

  async function finishAndContinue(openPanel: boolean) {
    const env = await modelClient.getEnvironmentStatus();
    const next = await modelClient.getModelStatus();
    setStatus(next);
    if (!env.modelReady) {
      setInstallError("模型还在下载。");
      setPhase("error");
      return;
    }
    const latest = await loadSettings();
    await saveSettings({ ...latest, onboardingComplete: true });
    onComplete?.();
    if (openPanel) {
      await invoke("show_entry");
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
          {PHASE_ORDER.map((step) => {
            const item = progress[step];
            const label = PHASE_LABELS[step] ?? step;
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
                  <p>{item?.message ?? "等待中"}</p>
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

  const statusItems = [
    {
      label: status?.inferenceBackend === "mlx" ? "MLX 实验包" : "内置 Metal",
      value:
        status?.inferenceBackend === "mlx"
          ? status?.mlxRuntimeAvailable
            ? "已安装"
            : "未安装"
          : status?.llamaServerAvailable
            ? "可用"
            : "未完成",
      ok:
        status?.inferenceBackend === "mlx"
          ? status?.mlxRuntimeAvailable
          : status?.llamaServerAvailable,
    },
    ...(status?.inferenceBackend === "mlx"
      ? [
          {
            label: "MLX 模型",
            value: status?.mlxModelReady ? "已下载" : "未下载",
            ok: status?.mlxModelReady,
          },
        ]
      : [
          {
            label: "主模型",
            value: status?.modelDownloaded ? "已下载" : "未下载",
            ok: status?.modelDownloaded,
          },
          {
            label: "视觉投影",
            value: status?.mmprojDownloaded ? "已下载" : "未下载",
            ok: status?.mmprojDownloaded,
          },
        ]),
    { label: "整体状态", value: status?.modelReady ? "可用" : "未完成", ok: status?.modelReady },
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
              内置 Metal {result?.runtimeReady ? "已安装" : "未完成"}
            </li>
            <li className={result?.modelReady ? "is-done" : ""}>
              视觉模型 {result?.modelReady ? "已下载" : "未完成"}
            </li>
            <li className="is-done">快捷键：⌃⌥Space</li>
          </ul>
        </div>
      ) : null}

      {installError ? <p className="onboarding-error">{installError}</p> : null}

      <div className="setup-panel__actions">
        {phase === "idle" || phase === "error" ? (
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void runSetup()}>
            下载均衡模型并完成配置（约 1.6 GiB）
          </button>
        ) : null}

        {phase === "running" ? <p className="setup-panel__running-hint">下载中…</p> : null}

        {phase === "error" ? (
          <button type="button" className="settings-btn settings-btn--secondary" onClick={() => setPhase("idle")}>
            返回
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
