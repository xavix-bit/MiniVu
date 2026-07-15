import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { modelClient } from "../model/modelClient";
import type { ModelStatusResponse } from "../model/types";
import { resolveGgufPercent, resolveMlxPercent } from "../shared/downloadProgress";
import { expectedGgufBytesForVariant, GGUF_MODEL_VARIANTS } from "../shared/modelConstants";
import { loadSettings, saveSettings, type GgufModelVariant } from "./settingsStore";

type ModelStatus = ModelStatusResponse;

type ModelPanelProps = {
  onOpenSetup?: () => void;
  onStatusChange?: () => void;
};

type FileKey = "model" | "mmproj";

type MlxProgressState = {
  status: "idle" | "running" | "done";
  percent: number;
  detail: string;
};

type FileProgressState = {
  status: "idle" | "waiting" | "running" | "switching" | "done";
  percent: number;
  downloaded: number;
  speedMbps: number | null;
  detail: string;
};

const FILE_LABELS: Record<"model" | "mmproj", string> = {
  model: "主模型",
  mmproj: "视觉投影器",
};

function createIdleProgress(): Record<"model" | "mmproj", FileProgressState> {
  return {
    model: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
    mmproj: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
  };
}

function shortenPath(path: string) {
  if (path.length <= 56) {
    return path;
  }
  return `…${path.slice(-52)}`;
}

export function ModelPanel({ onOpenSetup, onStatusChange }: ModelPanelProps) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [selectedVariant, setSelectedVariant] = useState<GgufModelVariant>("q4_k_m");
  const [savingVariant, setSavingVariant] = useState<GgufModelVariant | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [fileProgress, setFileProgress] = useState<Record<FileKey, FileProgressState>>(createIdleProgress);
  const [mlxProgress, setMlxProgress] = useState<MlxProgressState>({
    status: "idle",
    percent: 0,
    detail: "",
  });

  async function refresh() {
    const next = await modelClient.getModelStatus();
    setStatus(next);
    setSelectedVariant(next.ggufModelVariant);
  }

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    void listen<{
      file: string;
      status?: string;
      message?: string;
      downloaded: number;
      total: number | null;
      percent?: number;
      source?: string;
      speedMbps?: number;
    }>("model-download-progress", (event) => {
      const { file, status: downloadStatus, message, downloaded, total, source, speedMbps } =
        event.payload;
      const fileKey: FileKey = file === "mmproj" ? "mmproj" : "model";
      if (file === "mlx") {
        setMlxProgress((current) => {
          const percent =
            downloadStatus === "done"
              ? 100
              : resolveMlxPercent(current.percent, downloaded);
          return {
            status: downloadStatus === "done" ? "done" : "running",
            percent,
            detail: message ?? "正在下载实验模型…",
          };
        });
        return;
      }
      const label = FILE_LABELS[fileKey];

      setFileProgress((current) => {
        const prev = current[fileKey];

        if (downloadStatus === "waiting") {
          return {
            ...current,
            [fileKey]: {
              ...prev,
              status: "waiting",
              detail: message ?? "等待中…",
            },
          };
        }

        if (downloadStatus === "switching") {
          return {
            ...current,
            [fileKey]: {
              ...prev,
              status: "switching",
              detail: message ?? "正在切换下载源…",
            },
          };
        }

        if (downloadStatus === "done") {
          return {
            ...current,
            [fileKey]: {
              status: "done",
              percent: 100,
              downloaded: Math.max(prev.downloaded, downloaded),
              speedMbps: null,
              detail: message ?? "下载完成",
            },
          };
        }

        const resolvedPercent = resolveGgufPercent(prev.percent, downloaded, total, fileKey);
        const speed =
          speedMbps && speedMbps > 0 ? speedMbps : prev.speedMbps;
        const sourceHint = source ? ` · ${source}` : "";

        return {
          ...current,
          [fileKey]: {
            status: "running",
            percent: resolvedPercent,
            downloaded: Math.max(prev.downloaded, downloaded),
            speedMbps: speed ?? null,
            detail: `正在下载${label} ${resolvedPercent}%${sourceHint}`,
          },
        };
      });
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  async function downloadModel() {
    const runtimeReady =
      status?.inferenceBackend === "mlx"
        ? status?.mlxRuntimeAvailable
        : status?.llamaServerAvailable;
    if (!runtimeReady) {
      onOpenSetup?.();
      return;
    }
    if (status?.inferenceBackend === "mlx") {
      setDownloading(true);
      setDownloadError("");
      setMlxProgress({ status: "running", percent: 0, detail: "准备下载…" });
      try {
        await invoke<string>("download_mlx_model", { force: true });
        setMlxProgress({ status: "done", percent: 100, detail: "下载完成" });
        await refresh();
        onStatusChange?.();
      } catch (error) {
        setDownloadError(String(error));
        setMlxProgress({ status: "idle", percent: 0, detail: "" });
      } finally {
        setDownloading(false);
      }
      return;
    }

    setDownloading(true);
    setDownloadError("");
    setFileProgress({
      model: { status: "running", percent: 0, downloaded: 0, speedMbps: null, detail: "等待开始…" },
      mmproj: { status: "waiting", percent: 0, downloaded: 0, speedMbps: null, detail: "等待主模型完成…" },
    });
    try {
      const settings = await loadSettings();
      await saveSettings({ ...settings, ggufModelVariant: selectedVariant });
      await invoke<string>("download_model", { force: true });
      const expectedBytes = expectedGgufBytesForVariant(selectedVariant);
      setFileProgress({
        model: { status: "done", percent: 100, downloaded: expectedBytes.model, speedMbps: null, detail: "下载完成" },
        mmproj: { status: "done", percent: 100, downloaded: expectedBytes.mmproj, speedMbps: null, detail: "下载完成" },
      });
      await refresh();
      onStatusChange?.();
    } catch (error) {
      setDownloadError(String(error));
      setFileProgress(createIdleProgress());
    } finally {
      setDownloading(false);
    }
  }

  async function selectVariant(variant: GgufModelVariant) {
    if (variant === selectedVariant || downloading) {
      return;
    }
    setSelectedVariant(variant);
    setSavingVariant(variant);
    setDownloadError("");
    try {
      const settings = await loadSettings();
      await saveSettings({ ...settings, ggufModelVariant: variant });
      setFileProgress(createIdleProgress());
      await refresh();
      onStatusChange?.();
    } catch (error) {
      setDownloadError(String(error));
    } finally {
      setSavingVariant(null);
    }
  }

  const isMlx = status?.inferenceBackend === "mlx";
  const runtimeReady = isMlx ? status?.mlxRuntimeAvailable : status?.llamaServerAvailable;
  const selectedVariantSpec = GGUF_MODEL_VARIANTS[selectedVariant];

  const fileItems = status
    ? isMlx
      ? [
          {
            label: "实验加速包",
            value: status.mlxRuntimeAvailable ? "已安装" : "未安装",
            ok: status.mlxRuntimeAvailable,
            meta: "实验加速",
          },
          {
            label: "实验模型",
            value: status.mlxModelReady ? "已下载" : "未下载",
            ok: status.mlxModelReady,
            meta: shortenPath(status.mlxModelId),
          },
          {
            label: "问图准备",
            value: status.sidecarRunning ? "使用中" : "需要时启动",
            ok: status.sidecarRunning,
            meta: status.mlxModelReady ? "权重已缓存" : "需先下载权重",
          },
        ]
      : [
          {
            label: `主模型 · ${selectedVariantSpec.label}`,
            value: status.modelDownloaded ? "已下载" : "未下载",
            ok: status.modelDownloaded,
            meta: status.modelPath ? shortenPath(status.modelPath) : "—",
          },
          {
            label: "配套文件",
            value: status.mmprojDownloaded ? "已下载" : "未下载",
            ok: status.mmprojDownloaded,
            meta: status.mmprojPath ? shortenPath(status.mmprojPath) : "—",
          },
          {
            label: "问图准备",
            value: status.sidecarRunning ? "使用中" : "需要时启动",
            ok: status.sidecarRunning,
            meta: status.modelSize ? `合计 ${status.modelSize}` : "—",
          },
        ]
    : [];

  return (
    <div className="model-panel">
      {!runtimeReady ? (
        <div className="callout callout--attention" role="status">
          <p>{isMlx ? "加速组件未安装。" : "基础组件还没准备好。"}</p>
          {onOpenSetup ? (
            <button type="button" className="callout__action" onClick={onOpenSetup}>
              去初始设置
            </button>
          ) : null}
        </div>
      ) : null}

      {!isMlx ? (
        <section className="surface model-variant-picker" aria-label="模型档位">
          {(Object.entries(GGUF_MODEL_VARIANTS) as Array<
            [GgufModelVariant, (typeof GGUF_MODEL_VARIANTS)[GgufModelVariant]]
          >).map(([variant, spec]) => {
            const selected = variant === selectedVariant;
            return (
              <button
                key={variant}
                type="button"
                className={`model-variant-option${selected ? " is-selected" : ""}`}
                title={`${spec.modelName}\n${spec.description}\n模型 ${formatBytes(spec.modelBytes)}，共享配套文件 ${formatBytes(1_108_746_944)}，${spec.memoryHint}`}
                disabled={downloading || savingVariant !== null}
                onClick={() => void selectVariant(variant)}
              >
                <span className="model-variant-option__head">
                  <strong>{spec.label}</strong>
                  <span>{spec.badge}</span>
                </span>
                <span className="model-variant-option__name">{spec.modelName}</span>
                <span className="model-variant-option__desc">{spec.description}</span>
                <span className="model-variant-option__meta">
                  模型 {formatBytes(spec.modelBytes)} · 共享文件 1.0 GB · {spec.memoryHint}
                </span>
              </button>
            );
          })}
        </section>
      ) : null}

      <section className="surface model-panel__files" aria-label="模型文件">
        {status ? (
          <ul className="model-file-list">
            {fileItems.map((item) => (
              <li key={item.label} className="model-file-list__item">
                <div className="model-file-list__head">
                  <span className="model-file-list__label">{item.label}</span>
                  <strong className={`model-file-list__value${item.ok ? " is-positive" : ""}`}>{item.value}</strong>
                </div>
                <span className="model-file-list__path">{item.meta}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="placeholder-copy">正在读取模型状态…</p>
        )}
      </section>

      <section className="surface model-panel__actions-card">
        <p className="setup-panel__lead">
          {isMlx
            ? "下载实验模型。"
            : "下载或更新本地视觉模型。"}
        </p>
        <div className="model-actions">
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={downloading || !runtimeReady}
            onClick={() => void downloadModel()}
          >
            {downloading ? "下载中…" : isMlx ? "下载实验模型" : "下载 / 更新模型"}
          </button>
          <button type="button" className="settings-btn settings-btn--secondary" onClick={() => void refresh()}>
            刷新状态
          </button>
        </div>
        {downloadError ? <p className="onboarding-error">{downloadError}</p> : null}
        {isMlx && mlxProgress.status !== "idle" ? (
          <div className="model-download-progress" aria-label="实验模型下载进度">
            <div className={`model-download-progress__item is-${mlxProgress.status}`}>
              <div className="model-download-progress__head">
                <span className="model-download-progress__label">实验模型</span>
                <span className="model-download-progress__percent">
                  {mlxProgress.status === "done" ? "完成" : `${mlxProgress.percent}%`}
                </span>
              </div>
              <div className="onboarding-overall-progress__bar" aria-hidden="true">
                <span style={{ width: `${mlxProgress.percent}%` }} />
              </div>
              {mlxProgress.detail ? (
                <p className="model-download-progress__detail">{mlxProgress.detail}</p>
              ) : null}
            </div>
          </div>
        ) : null}
        {!isMlx && (["model", "mmproj"] as const).some((key) => fileProgress[key].status !== "idle") ? (
          <div className="model-download-progress" aria-label="下载进度">
            {(["model", "mmproj"] as const).map((key) => {
              const item = fileProgress[key];
              return (
                <div key={key} className={`model-download-progress__item is-${item.status}`}>
                  <div className="model-download-progress__head">
                    <span className="model-download-progress__label">{FILE_LABELS[key]}</span>
                    <div className="model-download-progress__meta">
                      {item.status === "running" && item.speedMbps ? (
                        <span className="model-download-progress__speed">{item.speedMbps.toFixed(1)} MB/s</span>
                      ) : null}
                      <span className="model-download-progress__percent">
                        {item.status === "done"
                          ? "完成"
                          : item.status === "waiting"
                            ? "等待"
                            : `${item.percent}%`}
                      </span>
                    </div>
                  </div>
                  <div className="onboarding-overall-progress__bar" aria-hidden="true">
                    <span style={{ width: `${item.percent}%` }} />
                  </div>
                  {item.detail ? <p className="model-download-progress__detail">{item.detail}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <p className="field-hint">
          {isMlx ? "模型来源在「偏好设置 → 问图方式」。" : "配套文件会自动准备。"}
        </p>
      </section>
    </div>
  );
}

function formatBytes(bytes: number) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
