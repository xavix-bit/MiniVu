import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  formatModelStorage,
  matchesActiveDownload,
  resolveModelPrimaryAction,
} from "../model/modelLifecycle";
import { modelClient } from "../model/modelClient";
import type { DownloadTaskSnapshot, ModelStatusResponse } from "../model/types";
import { resolveGgufPercent, resolveMlxPercent } from "../shared/downloadProgress";
import { GGUF_MODEL_VARIANTS } from "../shared/modelConstants";
import type { GgufModelVariant } from "./settingsStore";

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

type DownloadProgressEvent = {
  taskId?: number;
  variant?: GgufModelVariant;
  file: string;
  status?: string;
  message?: string;
  downloaded: number;
  total: number | null;
  source?: string;
  speedMbps?: number;
};

const FILE_LABELS: Record<FileKey, string> = {
  model: "主模型",
  mmproj: "视觉投影器",
};

const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "canceled"]);

function createIdleProgress(): Record<FileKey, FileProgressState> {
  return {
    model: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
    mmproj: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
  };
}

function variantStateLabel(status: ModelStatusResponse, variant: GgufModelVariant): string {
  const item = status.ggufVariants.find((candidate) => candidate.variant === variant);
  if (item?.installed && item.active) return "当前使用";
  if (item?.installed) return "已安装";
  if (item && item.partialBytes > 0) return "可续传";
  return "未安装";
}

export function ModelPanel({ onOpenSetup, onStatusChange }: ModelPanelProps) {
  const [status, setStatus] = useState<ModelStatusResponse | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<GgufModelVariant>("q4_k_m");
  const [activeTask, setActiveTaskState] = useState<DownloadTaskSnapshot | null>(null);
  const [pendingVariant, setPendingVariantState] = useState<GgufModelVariant | null>(null);
  const [operation, setOperation] = useState<"idle" | "installing" | "canceling" | "removing">("idle");
  const [message, setMessage] = useState("");
  const [cleanupWarning, setCleanupWarning] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<FileKey, FileProgressState>>(createIdleProgress);
  const [mlxProgress, setMlxProgress] = useState<MlxProgressState>({ status: "idle", percent: 0, detail: "" });
  const activeTaskRef = useRef<DownloadTaskSnapshot | null>(null);
  const pendingVariantRef = useRef<GgufModelVariant | null>(null);
  const initializedRef = useRef(false);

  function setActiveTask(task: DownloadTaskSnapshot | null) {
    const active = task && !TERMINAL_TASK_STATUSES.has(task.status) ? task : null;
    activeTaskRef.current = active;
    setActiveTaskState(active);
  }

  function setPendingVariant(variant: GgufModelVariant | null) {
    pendingVariantRef.current = variant;
    setPendingVariantState(variant);
  }

  async function refresh(syncSelection = false) {
    const [nextStatus, task] = await Promise.all([
      modelClient.getModelStatus(),
      modelClient.getModelDownloadStatus(),
    ]);
    setStatus(nextStatus);
    setActiveTask(task);
    if (syncSelection || !initializedRef.current) {
      setSelectedVariant(nextStatus.ggufModelVariant);
      initializedRef.current = true;
    }
    return { nextStatus, task };
  }

  async function refreshDownloadTask() {
    const task = await modelClient.getModelDownloadStatus();
    setActiveTask(task);
    if (task && !TERMINAL_TASK_STATUSES.has(task.status)) {
      setPendingVariant(null);
      setOperation((current) => current === "installing" ? "idle" : current);
    } else if (task && TERMINAL_TASK_STATUSES.has(task.status)) {
      setPendingVariant(null);
      setOperation((current) => current === "canceling" ? "idle" : current);
      await refresh();
    }
    return task;
  }

  useEffect(() => {
    void refresh(true).catch((error) => setMessage(String(error)));
    let unlisten: (() => void) | undefined;
    void listen<DownloadProgressEvent>("model-download-progress", (event) => {
      const payload = event.payload;
      if (payload.file === "mlx") {
        setMlxProgress((current) => ({
          status: payload.status === "done" ? "done" : "running",
          percent: payload.status === "done" ? 100 : resolveMlxPercent(current.percent, payload.downloaded),
          detail: payload.message ?? "正在下载 MLX 权重…",
        }));
        return;
      }
      if (payload.taskId === undefined || payload.variant === undefined) return;
      if (!matchesActiveDownload(
        { taskId: payload.taskId, variant: payload.variant },
        activeTaskRef.current,
        pendingVariantRef.current,
      )) return;

      if (!activeTaskRef.current) void refreshDownloadTask().catch(() => undefined);
      const fileKey: FileKey = payload.file === "mmproj" ? "mmproj" : "model";
      setFileProgress((current) => {
        const previous = current[fileKey];
        if (payload.status === "waiting" || payload.status === "switching") {
          return {
            ...current,
            [fileKey]: {
              ...previous,
              status: payload.status,
              detail: payload.message ?? (payload.status === "waiting" ? "等待中…" : "正在切换下载源…"),
            },
          };
        }
        if (payload.status === "done") {
          return {
            ...current,
            [fileKey]: { status: "done", percent: 100, downloaded: payload.downloaded, speedMbps: null, detail: "下载完成" },
          };
        }
        const percent = resolveGgufPercent(
          previous.percent,
          payload.downloaded,
          payload.total,
          fileKey,
          payload.variant,
        );
        return {
          ...current,
          [fileKey]: {
            status: "running",
            percent,
            downloaded: Math.max(previous.downloaded, payload.downloaded),
            speedMbps: payload.speedMbps && payload.speedMbps > 0 ? payload.speedMbps : previous.speedMbps,
            detail: payload.message ?? `正在下载${FILE_LABELS[fileKey]} ${percent}%`,
          },
        };
      });
      if (payload.status === "failed" || payload.status === "canceled") {
        setPendingVariant(null);
        setOperation((current) => current === "canceling" ? "idle" : current);
        void refresh().catch((error) => setMessage(String(error)));
      }
    }).then((cleanup) => { unlisten = cleanup; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!pendingVariant && !activeTask) return;
    const timer = window.setInterval(() => {
      void refreshDownloadTask().catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer);
  }, [pendingVariant, activeTask?.taskId]);

  async function runPrimaryAction() {
    if (!status) return;
    const isMlx = status.inferenceBackend === "mlx";
    if (isMlx) {
      if (!status.mlxRuntimeAvailable) {
        onOpenSetup?.();
        return;
      }
      setOperation("installing");
      setMessage("");
      setMlxProgress({ status: "running", percent: 0, detail: "准备下载…" });
      try {
        await invoke<string>("download_mlx_model", { force: true });
        setMlxProgress({ status: "done", percent: 100, detail: "下载完成" });
        await refresh();
        onStatusChange?.();
      } catch (error) {
        setMessage(String(error));
        setMlxProgress({ status: "idle", percent: 0, detail: "" });
      } finally {
        setOperation("idle");
      }
      return;
    }

    const action = resolveModelPrimaryAction(selectedVariant, status.ggufVariants, activeTask);
    if (action.kind === "cancel" && activeTask) {
      setOperation("canceling");
      setMessage("");
      try {
        await modelClient.cancelModelDownload(activeTask.taskId);
        await refreshDownloadTask();
      } catch (error) {
        setMessage(String(error));
        setOperation("idle");
      }
      return;
    }
    if (action.disabled) return;
    if (!status.llamaServerAvailable) {
      onOpenSetup?.();
      return;
    }

    setOperation("installing");
    setMessage("");
    setCleanupWarning("");
    setPendingVariant(selectedVariant);
    setFileProgress({
      model: { status: "running", percent: 0, downloaded: 0, speedMbps: null, detail: "等待开始…" },
      mmproj: { status: "waiting", percent: 0, downloaded: 0, speedMbps: null, detail: "等待主模型完成…" },
    });
    try {
      const install = modelClient.installGgufModel(selectedVariant, false);
      void refreshDownloadTask().catch(() => undefined);
      const result = await install;
      setCleanupWarning(result.cleanupWarning ?? "");
      setPendingVariant(null);
      await refresh(true);
      setMessage("模型已就绪");
      onStatusChange?.();
    } catch (error) {
      setMessage(String(error));
      setPendingVariant(null);
      await refresh().catch(() => undefined);
    } finally {
      setOperation("idle");
    }
  }

  async function removeModels() {
    setOperation("removing");
    setMessage("");
    setCleanupWarning("");
    try {
      const result = await modelClient.removeInstalledModels();
      setCleanupWarning(result.cleanupWarning ?? "");
      setMessage("本地模型已移除");
      setRemoveConfirm(false);
      setFileProgress(createIdleProgress());
      await refresh(true);
      onStatusChange?.();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setOperation("idle");
    }
  }

  const isMlx = status?.inferenceBackend === "mlx";
  const runtimeReady = isMlx ? status?.mlxRuntimeAvailable : status?.llamaServerAvailable;
  const primaryAction = status && !isMlx
    ? resolveModelPrimaryAction(selectedVariant, status.ggufVariants, activeTask)
    : null;
  const primaryLabel = operation === "canceling"
    ? "正在取消…"
    : operation === "installing"
      ? isMlx ? "下载中…" : "处理中…"
      : isMlx ? "下载 MLX 权重" : primaryAction?.label ?? "读取中…";

  return (
    <div className="model-panel">
      {!runtimeReady && status ? (
        <div className="callout callout--attention" role="status">
          <p>{isMlx ? "MLX 未安装。" : "内置 Metal 未就绪。"}</p>
          {onOpenSetup ? <button type="button" className="callout__action" onClick={onOpenSetup}>去环境配置</button> : null}
        </div>
      ) : null}

      {!isMlx ? (
        <section className="surface model-variant-picker" aria-label="模型档位">
          {(Object.entries(GGUF_MODEL_VARIANTS) as Array<[GgufModelVariant, (typeof GGUF_MODEL_VARIANTS)[GgufModelVariant]]>).map(([variant, spec]) => {
            const selected = variant === selectedVariant;
            const stateLabel = status ? variantStateLabel(status, variant) : "读取中";
            return (
              <button
                key={variant}
                type="button"
                className={`model-variant-option${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                disabled={operation !== "idle" || activeTask !== null}
                onClick={() => {
                  setSelectedVariant(variant);
                  setMessage("");
                  setFileProgress(createIdleProgress());
                }}
              >
                <span className="model-variant-option__head"><strong>{spec.label}</strong><span>{spec.badge}</span></span>
                <span className={`model-variant-option__state${stateLabel === "当前使用" ? " is-current" : ""}`}>{stateLabel}</span>
                <span className="model-variant-option__desc">{spec.description}</span>
                <span className="model-variant-option__meta">{formatModelStorage(spec.modelBytes)} · {spec.memoryHint}</span>
              </button>
            );
          })}
        </section>
      ) : null}

      {isMlx ? (
        <section className="surface model-panel__files" aria-label="MLX 模型状态">
          {status ? (
            <ul className="model-file-list">
              <li className="model-file-list__item"><div className="model-file-list__head"><span className="model-file-list__label">MLX 运行环境</span><strong className={`model-file-list__value${status.mlxRuntimeAvailable ? " is-positive" : ""}`}>{status.mlxRuntimeAvailable ? "已安装" : "未安装"}</strong></div></li>
              <li className="model-file-list__item"><div className="model-file-list__head"><span className="model-file-list__label">MLX 模型</span><strong className={`model-file-list__value${status.mlxModelReady ? " is-positive" : ""}`}>{status.mlxModelReady ? "已下载" : "未下载"}</strong></div></li>
            </ul>
          ) : <p className="placeholder-copy">正在读取模型状态…</p>}
        </section>
      ) : null}

      <section className="surface model-panel__actions-card" aria-label="模型操作">
        <div className="model-actions">
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={!status || operation !== "idle" || Boolean(primaryAction?.disabled) || (!runtimeReady && !primaryAction?.kind)}
            onClick={() => void runPrimaryAction()}
          >
            {primaryLabel}
          </button>
          <button type="button" className="settings-btn settings-btn--secondary" disabled={operation !== "idle"} onClick={() => void refresh()}>
            刷新状态
          </button>
        </div>

        <div className="model-feedback" aria-live="polite">
          {message ? <p className={message.includes("已") || message.includes("就绪") ? "model-success" : "onboarding-error"}>{message}</p> : null}
          {cleanupWarning ? <p className="model-cleanup-warning">{cleanupWarning}</p> : null}
        </div>

        {isMlx && mlxProgress.status !== "idle" ? (
          <div className="model-download-progress" aria-label="MLX 下载进度" aria-live="polite">
            <ProgressItem label="MLX 权重" item={{ ...mlxProgress, downloaded: 0, speedMbps: null }} />
          </div>
        ) : null}
        {!isMlx && (Object.keys(fileProgress) as FileKey[]).some((key) => fileProgress[key].status !== "idle") ? (
          <div className="model-download-progress" aria-label="下载进度" aria-live="polite">
            {(Object.keys(fileProgress) as FileKey[]).map((key) => <ProgressItem key={key} label={FILE_LABELS[key]} item={fileProgress[key]} />)}
          </div>
        ) : null}

        {!isMlx && status ? (
          <div className="model-storage-row">
            <div><span>GGUF 模型占用</span><strong>{formatModelStorage(status.modelStorageBytes)}</strong><small>含未完成下载</small></div>
            {!removeConfirm ? (
              <button type="button" className="settings-btn settings-btn--danger-secondary" disabled={operation !== "idle" || activeTask !== null || status.modelStorageBytes === 0} onClick={() => setRemoveConfirm(true)}>移除本地模型</button>
            ) : (
              <div className="model-remove-confirm" role="group" aria-label="确认移除本地模型">
                <p>将移除全部已安装 GGUF 模型，未完成下载也会清理。</p>
                <button type="button" className="settings-btn settings-btn--danger" disabled={operation !== "idle"} onClick={() => void removeModels()}>{operation === "removing" ? "正在移除…" : "确认移除"}</button>
                <button type="button" className="settings-btn settings-btn--secondary" disabled={operation !== "idle"} onClick={() => setRemoveConfirm(false)}>取消</button>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ProgressItem({ label, item }: { label: string; item: FileProgressState | (MlxProgressState & { downloaded: number; speedMbps: null }) }) {
  return (
    <div className={`model-download-progress__item is-${item.status}`}>
      <div className="model-download-progress__head">
        <span className="model-download-progress__label">{label}</span>
        <div className="model-download-progress__meta">
          {item.status === "running" && item.speedMbps ? <span className="model-download-progress__speed">{item.speedMbps.toFixed(1)} MB/s</span> : null}
          <span className="model-download-progress__percent">{item.status === "done" ? "完成" : item.status === "waiting" ? "等待" : `${item.percent}%`}</span>
        </div>
      </div>
      <div className="onboarding-overall-progress__bar" aria-hidden="true"><span style={{ width: `${item.percent}%` }} /></div>
      {item.detail ? <p className="model-download-progress__detail">{item.detail}</p> : null}
    </div>
  );
}
