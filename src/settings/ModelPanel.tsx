import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { modelClient } from "../model/modelClient";
import type { ModelStatusResponse } from "../model/types";
import { resolveGgufPercent, resolveMlxPercent } from "../shared/downloadProgress";
import { expectedGgufBytesForVariant, GGUF_MODEL_VARIANTS } from "../shared/modelConstants";
import { updateSettings, type GgufModelVariant } from "./settingsStore";

type ModelStatus = ModelStatusResponse;

type ModelPanelProps = {
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onRepairRuntime?: () => void;
  onStatusChange?: (status: ModelStatusResponse) => void;
  refreshToken?: number;
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
  mmproj: "图片理解支持",
};

function createIdleProgress(): Record<"model" | "mmproj", FileProgressState> {
  return {
    model: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
    mmproj: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
  };
}

export function ModelPanel({
  disabled = false,
  onBusyChange,
  onRepairRuntime,
  onStatusChange,
  refreshToken,
}: ModelPanelProps) {
  const mountedRef = useRef(false);
  const previousRefreshTokenRef = useRef(refreshToken);
  const refreshGenerationRef = useRef(0);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [selectedVariant, setSelectedVariant] = useState<GgufModelVariant>("q4_k_m");
  const [savingVariant, setSavingVariant] = useState<GgufModelVariant | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<FileKey, FileProgressState>>(createIdleProgress);
  const [mlxProgress, setMlxProgress] = useState<MlxProgressState>({
    status: "idle",
    percent: 0,
    detail: "",
  });
  const operationBusy = downloading || savingVariant !== null;

  async function refresh() {
    const generation = ++refreshGenerationRef.current;
    if (mountedRef.current) {
      setRefreshingStatus(true);
    }
    let next: ModelStatusResponse;
    try {
      next = await modelClient.getModelStatus();
    } catch {
      if (mountedRef.current && generation === refreshGenerationRef.current) {
        setStatusError("暂时无法读取模型状态，请重试。");
        setRefreshingStatus(false);
      }
      return null;
    }
    if (!mountedRef.current || generation !== refreshGenerationRef.current) {
      return null;
    }
    setStatusError("");
    setRefreshingStatus(false);
    setStatus(next);
    setSelectedVariant(next.ggufModelVariant);
    return next;
  }

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    let disposed = false;
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
      if (!mountedRef.current) {
        return;
      }
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
            detail: message ?? "正在下载 MiniCPM-V 加速版…",
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
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      mountedRef.current = false;
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    onBusyChange?.(operationBusy);
  }, [onBusyChange, operationBusy]);

  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [onBusyChange],
  );

  useEffect(() => {
    if (previousRefreshTokenRef.current === refreshToken) {
      return;
    }
    previousRefreshTokenRef.current = refreshToken;
    void refresh();
  }, [refreshToken]);

  async function downloadModel() {
    if (disabled) {
      return;
    }
    const runtimeReady =
      status?.inferenceBackend === "mlx"
        ? status?.mlxRuntimeAvailable
        : status?.llamaServerAvailable;
    if (!runtimeReady) {
      onRepairRuntime?.();
      return;
    }
    if (status?.inferenceBackend === "mlx") {
      setDownloading(true);
      setDownloadError("");
      setMlxProgress({ status: "running", percent: 0, detail: "准备下载…" });
      try {
        await invoke<string>("download_mlx_model", { force: true });
        if (!mountedRef.current) {
          return;
        }
        setMlxProgress({ status: "done", percent: 100, detail: "下载完成" });
        const nextStatus = await refresh();
        if (mountedRef.current && nextStatus) {
          onStatusChange?.(nextStatus);
        }
      } catch {
        if (mountedRef.current) {
          setDownloadError("加速模型下载失败，请重试。");
          setMlxProgress({ status: "idle", percent: 0, detail: "" });
        }
      } finally {
        if (mountedRef.current) {
          setDownloading(false);
        }
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
      await updateSettings({ ggufModelVariant: selectedVariant });
      if (!mountedRef.current) {
        return;
      }
      await invoke<string>("download_model", { force: true });
      if (!mountedRef.current) {
        return;
      }
      const expectedBytes = expectedGgufBytesForVariant(selectedVariant);
      setFileProgress({
        model: { status: "done", percent: 100, downloaded: expectedBytes.model, speedMbps: null, detail: "下载完成" },
        mmproj: { status: "done", percent: 100, downloaded: expectedBytes.mmproj, speedMbps: null, detail: "下载完成" },
      });
      const nextStatus = await refresh();
      if (mountedRef.current && nextStatus) {
        onStatusChange?.(nextStatus);
      }
    } catch {
      if (mountedRef.current) {
        setDownloadError("模型下载失败，请重试。");
        setFileProgress(createIdleProgress());
      }
    } finally {
      if (mountedRef.current) {
        setDownloading(false);
      }
    }
  }

  async function selectVariant(variant: GgufModelVariant) {
    if (disabled || variant === selectedVariant || downloading || refreshingStatus || statusError) {
      return;
    }
    setSelectedVariant(variant);
    setSavingVariant(variant);
    setDownloadError("");
    try {
      await updateSettings({ ggufModelVariant: variant });
      if (!mountedRef.current) {
        return;
      }
      setFileProgress(createIdleProgress());
      const nextStatus = await refresh();
      if (mountedRef.current && nextStatus) {
        onStatusChange?.(nextStatus);
      }
    } catch {
      if (mountedRef.current) {
        setDownloadError("无法保存模型档位，请重试。");
      }
    } finally {
      if (mountedRef.current) {
        setSavingVariant(null);
      }
    }
  }

  const isMlx = status?.inferenceBackend === "mlx";
  const runtimeReady = isMlx ? status?.mlxRuntimeAvailable : status?.llamaServerAvailable;
  const selectedVariantSpec = GGUF_MODEL_VARIANTS[selectedVariant];

  const fileItems = status
    ? isMlx
      ? [
          {
            label: "加速支持",
            value: status.mlxRuntimeAvailable ? "已安装" : "需要安装",
            ok: status.mlxRuntimeAvailable,
            meta: "用于 MiniCPM-V 加速版",
          },
          {
            label: "MiniCPM-V 加速版",
            value: status.mlxModelReady ? "模型已下载" : "需要下载模型",
            ok: status.mlxModelReady,
            meta: status.mlxModelId,
          },
        ]
      : [
          {
            label: `主模型 · ${selectedVariantSpec.label}`,
            value: status.modelDownloaded ? "模型已下载" : "需要下载模型",
            ok: status.modelDownloaded,
            meta: `${selectedVariantSpec.modelName} · 下载 ${formatBytes(selectedVariantSpec.modelBytes)}`,
          },
          {
            label: "图片理解支持",
            value: status.mmprojDownloaded ? "已下载" : "未下载",
            ok: status.mmprojDownloaded,
            meta: `下载 ${formatBytes(1_108_746_944)}${status.modelSize ? ` · 已安装合计 ${status.modelSize}` : ""}`,
          },
        ]
    : [];

  return (
    <div className="model-panel">
      {status && !runtimeReady ? (
        <div className="callout callout--attention" role="status">
          <p>模型下载暂时不可用。</p>
          {onRepairRuntime ? (
            <button
              type="button"
              className="callout__action"
              disabled={disabled}
              onClick={onRepairRuntime}
            >
              修复下载功能
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
                title={`${spec.modelName}\n${spec.description}\n模型 ${formatBytes(spec.modelBytes)}，另需下载 ${formatBytes(1_108_746_944)}，${spec.memoryHint}`}
                disabled={
                  disabled ||
                  downloading ||
                  savingVariant !== null ||
                  refreshingStatus ||
                  !!statusError
                }
                onClick={() => void selectVariant(variant)}
              >
                <span className="model-variant-option__head">
                  <strong>{spec.label}</strong>
                  <span>{spec.badge}</span>
                </span>
                <span className="model-variant-option__name">{spec.modelName}</span>
                <span className="model-variant-option__desc">{spec.description}</span>
                <span className="model-variant-option__meta">
                  模型 {formatBytes(spec.modelBytes)} · 另需下载 1.0 GB · {spec.memoryHint}
                </span>
              </button>
            );
          })}
        </section>
      ) : null}

      <section className="surface model-panel__files" aria-label="模型状态">
        {status ? (
          <ul className="model-file-list">
            {fileItems.map((item) => (
              <li key={item.label} className="model-file-list__item">
                <div className="model-file-list__head">
                  <span className="model-file-list__label">{item.label}</span>
                  <strong className={`model-file-list__value${item.ok ? " is-positive" : ""}`}>{item.value}</strong>
                </div>
                <span className="model-file-list__meta">{item.meta}</span>
              </li>
            ))}
          </ul>
        ) : !statusError ? (
          <p className="placeholder-copy">正在读取模型状态…</p>
        ) : null}
        {statusError ? <p className="onboarding-error">{statusError}</p> : null}
      </section>

      <section className="surface model-panel__actions-card">
        <p className="setup-panel__lead">
          {isMlx
            ? "下载后即可使用 MiniCPM-V 加速版。"
            : "下载或更新所选模型。"}
        </p>
        <div className="model-actions">
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={disabled || downloading || refreshingStatus || !!statusError || !runtimeReady}
            onClick={() => void downloadModel()}
          >
            {downloading ? "下载中…" : isMlx ? "下载加速模型" : "下载 / 更新模型"}
          </button>
          <button
            type="button"
            className="settings-btn settings-btn--secondary"
            disabled={disabled}
            onClick={() => void refresh()}
          >
            刷新状态
          </button>
        </div>
        {downloadError ? <p className="onboarding-error">{downloadError}</p> : null}
        {isMlx && mlxProgress.status !== "idle" ? (
          <div className="model-download-progress" aria-label="加速模型下载进度">
            <div className={`model-download-progress__item is-${mlxProgress.status}`}>
              <div className="model-download-progress__head">
                <span className="model-download-progress__label">MiniCPM-V 加速版</span>
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
        {!isMlx ? <p className="field-hint">所需文件会一起下载。</p> : null}
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
