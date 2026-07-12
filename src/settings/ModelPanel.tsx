import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  claimPendingDownload,
  formatModelStorage,
  isActiveDownload,
  matchesActiveDownload,
  resolveModelPrimaryAction,
  type PendingDownload,
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
  status: "idle" | "waiting" | "running" | "switching" | "done" | "canceling" | "canceled" | "failed";
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

type OperationKind = "installing" | "canceling" | "removing";

type OperationGuard = {
  id: number;
  kind: OperationKind;
};

type InstallOperation = {
  guard: OperationGuard;
  variant: GgufModelVariant;
  taskId: number | null;
  lastFile: FileKey;
  terminalHandled: boolean;
};

type PendingInstall = PendingDownload & {
  operationId: number;
};

const FILE_LABELS: Record<FileKey, string> = {
  model: "主模型",
  mmproj: "视觉投影器",
};

function createIdleProgress(): Record<FileKey, FileProgressState> {
  return {
    model: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
    mmproj: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
  };
}

function friendlySource(source: string | undefined): string {
  const normalized = source?.toLowerCase() ?? "";
  if (normalized.includes("modelscope")) return "ModelScope";
  if (normalized.includes("huggingface") || normalized.includes("hugging face")) return "Hugging Face";
  return "";
}

function appendSource(detail: string, source: string | undefined): string {
  const label = friendlySource(source);
  return label ? `${detail} · ${label}` : detail;
}

function terminalProgress(
  current: Record<FileKey, FileProgressState>,
  status: "canceled" | "failed",
  file: string | null | undefined,
  downloaded?: number,
): Record<FileKey, FileProgressState> {
  const fileKey: FileKey = file === "mmproj" ? "mmproj" : "model";
  const next = createIdleProgress();
  for (const key of Object.keys(current) as FileKey[]) {
    if (current[key].status === "done") next[key] = current[key];
  }
  next[fileKey] = {
    ...current[fileKey],
    status,
    downloaded: Math.max(current[fileKey].downloaded, downloaded ?? 0),
    speedMbps: null,
    detail: status === "canceled" ? "已暂停，可继续下载" : "下载失败",
  };
  return next;
}

function completedProgress(current: Record<FileKey, FileProgressState>): Record<FileKey, FileProgressState> {
  return {
    model: { ...current.model, status: "done", percent: 100, speedMbps: null, detail: "下载完成" },
    mmproj: { ...current.mmproj, status: "done", percent: 100, speedMbps: null, detail: "下载完成" },
  };
}

function snapshotStatusRank(status: string): number {
  if (["done", "failed", "canceled"].includes(status)) return 3;
  if (status === "cancelRequested") return 2;
  return 1;
}

function progressFromSnapshot(
  current: Record<FileKey, FileProgressState>,
  snapshot: DownloadTaskSnapshot,
): Record<FileKey, FileProgressState> {
  if (snapshot.status === "canceled" || snapshot.status === "failed") {
    return terminalProgress(current, snapshot.status, snapshot.file, snapshot.downloaded);
  }
  const fileKey: FileKey = snapshot.file === "mmproj" ? "mmproj" : "model";
  const percent = resolveGgufPercent(
    current[fileKey].percent,
    snapshot.downloaded,
    snapshot.total,
    fileKey,
    snapshot.variant,
  );
  const status: FileProgressState["status"] = snapshot.status === "cancelRequested"
    ? "canceling"
    : snapshot.status === "waiting"
      ? "waiting"
      : snapshot.status === "switching"
        ? "switching"
        : snapshot.status === "done"
          ? "done"
          : "running";
  const detail = status === "canceling"
    ? "正在取消…"
    : status === "waiting"
      ? "等待中…"
      : status === "switching"
        ? "正在切换下载源…"
        : status === "done"
          ? "下载完成"
          : appendSource(`正在下载${FILE_LABELS[fileKey]} ${percent}%`, snapshot.source ?? undefined);
  return {
    ...current,
    [fileKey]: {
      status,
      percent: status === "done" ? 100 : percent,
      downloaded: snapshot.downloaded,
      speedMbps: null,
      detail,
    },
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
  const [pendingDownload, setPendingDownloadState] = useState<PendingInstall | null>(null);
  const [operation, setOperation] = useState<"idle" | "installing" | "canceling" | "removing">("idle");
  const [message, setMessage] = useState("");
  const [cleanupWarning, setCleanupWarning] = useState("");
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<FileKey, FileProgressState>>(createIdleProgress);
  const [mlxProgress, setMlxProgress] = useState<MlxProgressState>({ status: "idle", percent: 0, detail: "" });
  const activeTaskRef = useRef<DownloadTaskSnapshot | null>(null);
  const pendingDownloadRef = useRef<PendingInstall | null>(null);
  const lastSeenTaskIdRef = useRef(0);
  const snapshotClockRef = useRef({ taskId: 0, fileRank: 0, statusRank: 0 });
  const operationGuardRef = useRef<OperationGuard | null>(null);
  const operationCounterRef = useRef(0);
  const installOperationsRef = useRef(new Map<number, InstallOperation>());
  const installTasksRef = useRef(new Map<number, InstallOperation>());
  const disposedRef = useRef(false);
  const initializedRef = useRef(false);

  function setActiveTask(task: DownloadTaskSnapshot | null) {
    const active = task && isActiveDownload(task) ? task : null;
    activeTaskRef.current = active;
    if (!disposedRef.current) setActiveTaskState(active);
  }

  function setPendingDownload(pending: PendingInstall | null) {
    pendingDownloadRef.current = pending;
    if (!disposedRef.current) setPendingDownloadState(pending);
  }

  function noteSnapshot(task: DownloadTaskSnapshot | null) {
    if (task) {
      lastSeenTaskIdRef.current = Math.max(lastSeenTaskIdRef.current, task.taskId);
    }
  }

  function beginOperation(kind: OperationKind): OperationGuard | null {
    if (operationGuardRef.current) return null;
    const guard = { id: operationCounterRef.current + 1, kind };
    operationCounterRef.current = guard.id;
    operationGuardRef.current = guard;
    if (!disposedRef.current) setOperation(kind);
    return guard;
  }

  function releaseOperation(guard: OperationGuard) {
    if (operationGuardRef.current?.id !== guard.id) return;
    operationGuardRef.current = null;
    if (!disposedRef.current) setOperation("idle");
  }

  function acceptSnapshot(task: DownloadTaskSnapshot | null): boolean {
    if (!task) {
      return snapshotClockRef.current.taskId === 0 && activeTaskRef.current === null;
    }
    const statusRank = snapshotStatusRank(task.status);
    const fileRank = task.file === "mmproj" ? 2 : task.file === "model" ? 1 : 0;
    const clock = snapshotClockRef.current;
    if (task.taskId < clock.taskId) return false;
    if (task.taskId === clock.taskId && fileRank < clock.fileRank) return false;
    if (task.taskId === clock.taskId && fileRank === clock.fileRank && statusRank < clock.statusRank) return false;
    snapshotClockRef.current = {
      taskId: task.taskId,
      fileRank,
      statusRank: task.taskId === clock.taskId && fileRank === clock.fileRank
        ? Math.max(statusRank, clock.statusRank)
        : statusRank,
    };
    noteSnapshot(task);
    return true;
  }

  function markTerminalTask(taskId: number, file: string | null | undefined) {
    const clock = snapshotClockRef.current;
    if (taskId >= clock.taskId) {
      snapshotClockRef.current = {
        taskId,
        fileRank: file === "mmproj" ? 2 : file === "model" ? 1 : clock.fileRank,
        statusRank: 3,
      };
      lastSeenTaskIdRef.current = Math.max(lastSeenTaskIdRef.current, taskId);
    }
  }

  function registerClaimedTask(task: DownloadTaskSnapshot, pending: PendingInstall) {
    const install = installOperationsRef.current.get(pending.operationId);
    if (install) {
      install.taskId = task.taskId;
      install.lastFile = task.file === "mmproj" ? "mmproj" : "model";
      installTasksRef.current.set(task.taskId, install);
      releaseOperation(install.guard);
    }
  }

  function applyObservedSnapshot(task: DownloadTaskSnapshot | null): boolean {
    if (!acceptSnapshot(task) || disposedRef.current) return false;
    const pending = pendingDownloadRef.current;
    if (pending) {
      const claimed = claimPendingDownload(task, pending);
      if (!claimed) return true;
      setActiveTask(claimed);
      setPendingDownload(null);
      setSelectedVariant(claimed.variant);
      initializedRef.current = true;
      setFileProgress((current) => progressFromSnapshot(current, claimed));
      registerClaimedTask(claimed, pending);
      return true;
    }

    setActiveTask(task);
    if (task && isActiveDownload(task)) {
      setSelectedVariant(task.variant);
      initializedRef.current = true;
      setFileProgress((current) => progressFromSnapshot(current, task));
      if (task.status === "cancelRequested" && operationGuardRef.current?.kind === "canceling") {
        releaseOperation(operationGuardRef.current);
      }
      return true;
    }
    if (task) {
      const install = installTasksRef.current.get(task.taskId);
      if (install) {
        install.terminalHandled = true;
        install.lastFile = task.file === "mmproj" ? "mmproj" : install.lastFile;
      }
      if (task.status === "canceled" || task.status === "failed") {
        setFileProgress((current) => progressFromSnapshot(current, task));
      }
      if (operationGuardRef.current?.kind === "canceling") {
        releaseOperation(operationGuardRef.current);
      }
    }
    return true;
  }

  async function refreshInventory() {
    const nextStatus = await modelClient.getModelStatus();
    if (!disposedRef.current) setStatus(nextStatus);
    return nextStatus;
  }

  async function refresh(syncSelection = false) {
    const [nextStatus, task] = await Promise.all([
      modelClient.getModelStatus(),
      modelClient.getModelDownloadStatus(),
    ]);
    if (disposedRef.current) return { nextStatus, task };
    setStatus(nextStatus);
    applyObservedSnapshot(task);
    if (!activeTaskRef.current && !pendingDownloadRef.current && (syncSelection || !initializedRef.current)) {
      setSelectedVariant(nextStatus.ggufModelVariant);
      initializedRef.current = true;
    }
    return { nextStatus, task };
  }

  async function refreshDownloadTask() {
    const task = await modelClient.getModelDownloadStatus();
    if (disposedRef.current) return task;
    const accepted = applyObservedSnapshot(task);
    if (accepted && task && !isActiveDownload(task)) {
      await refreshInventory();
    }
    return task;
  }

  useEffect(() => {
    let disposed = false;
    disposedRef.current = false;
    void refresh(true).catch((error) => {
      if (!disposed) setMessage(String(error));
    });
    let unlisten: (() => void) | undefined;
    void listen<DownloadProgressEvent>("model-download-progress", (event) => {
      if (disposed) return;
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
      )) return;

      const eventSnapshot: DownloadTaskSnapshot = {
        taskId: payload.taskId,
        variant: payload.variant,
        status: payload.status ?? "running",
        file: payload.file,
        downloaded: payload.downloaded,
        total: payload.total,
        source: payload.source ?? null,
      };
      if (!acceptSnapshot(eventSnapshot)) return;
      if (payload.status === "failed" || payload.status === "canceled") {
        setActiveTask(null);
      } else if (payload.status !== "done") {
        setActiveTask(eventSnapshot);
      }

      const fileKey: FileKey = payload.file === "mmproj" ? "mmproj" : "model";
      const installOperation = installTasksRef.current.get(payload.taskId);
      if (installOperation) installOperation.lastFile = fileKey;
      setFileProgress((current) => {
        const previous = current[fileKey];
        if (payload.status === "canceled" || payload.status === "failed") {
          return terminalProgress(current, payload.status, payload.file, payload.downloaded);
        }
        if (payload.status === "waiting" || payload.status === "switching") {
          return {
            ...current,
            [fileKey]: {
              ...previous,
              status: payload.status,
              detail: appendSource(
                payload.message ?? (payload.status === "waiting" ? "等待中…" : "正在切换下载源…"),
                payload.source,
              ),
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
            detail: appendSource(`正在下载${FILE_LABELS[fileKey]} ${percent}%`, payload.source),
          },
        };
      });
      if (payload.status === "failed" || payload.status === "canceled") {
        markTerminalTask(payload.taskId, payload.file);
        if (installOperation) installOperation.terminalHandled = true;
        if (operationGuardRef.current?.kind === "canceling") {
          releaseOperation(operationGuardRef.current);
        }
        void refresh().catch((error) => {
          if (!disposed) setMessage(String(error));
        });
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!pendingDownload && !activeTask) return;
    const timer = window.setInterval(() => {
      void refreshDownloadTask().catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer);
  }, [pendingDownload, activeTask?.taskId]);

  async function runPrimaryAction() {
    if (!status || operationGuardRef.current) return;
    const isMlx = status.inferenceBackend === "mlx";
    if (isMlx) {
      if (!status.mlxRuntimeAvailable) {
        onOpenSetup?.();
        return;
      }
      const guard = beginOperation("installing");
      if (!guard) return;
      setMessage("");
      setMlxProgress({ status: "running", percent: 0, detail: "准备下载…" });
      try {
        await invoke<string>("download_mlx_model", { force: true });
        if (disposedRef.current) return;
        setMlxProgress({ status: "done", percent: 100, detail: "下载完成" });
        await refresh();
        onStatusChange?.();
      } catch (error) {
        if (!disposedRef.current) {
          setMessage(String(error));
          setMlxProgress({ status: "idle", percent: 0, detail: "" });
        }
      } finally {
        releaseOperation(guard);
      }
      return;
    }

    const action = resolveModelPrimaryAction(selectedVariant, status.ggufVariants, activeTask);
    if (action.kind === "cancel" && activeTask) {
      const guard = beginOperation("canceling");
      if (!guard) return;
      const taskId = activeTask.taskId;
      setMessage("");
      try {
        await modelClient.cancelModelDownload(taskId);
        await refreshDownloadTask();
      } catch (error) {
        if (!disposedRef.current) setMessage(String(error));
        releaseOperation(guard);
      }
      return;
    }
    if (!status.llamaServerAvailable) {
      onOpenSetup?.();
      return;
    }
    if (action.disabled) return;

    const guard = beginOperation("installing");
    if (!guard) return;
    const installOperation: InstallOperation = {
      guard,
      variant: selectedVariant,
      taskId: null,
      lastFile: "model",
      terminalHandled: false,
    };
    installOperationsRef.current.set(guard.id, installOperation);
    setMessage("");
    setCleanupWarning("");
    try {
      const baselineSnapshot = await modelClient.getModelDownloadStatus();
      if (disposedRef.current) return;
      if (baselineSnapshot && isActiveDownload(baselineSnapshot)) {
        const accepted = applyObservedSnapshot(baselineSnapshot);
        if (accepted && activeTaskRef.current?.taskId === baselineSnapshot.taskId) return;
      } else {
        acceptSnapshot(baselineSnapshot);
      }
      const pending: PendingInstall = {
        variant: selectedVariant,
        baselineTaskId: Math.max(lastSeenTaskIdRef.current, baselineSnapshot?.taskId ?? 0),
        operationId: guard.id,
      };
      setPendingDownload(pending);
      setFileProgress({
        model: { status: "running", percent: 0, downloaded: 0, speedMbps: null, detail: "等待开始…" },
        mmproj: { status: "waiting", percent: 0, downloaded: 0, speedMbps: null, detail: "等待主模型完成…" },
      });
      const install = modelClient.installGgufModel(selectedVariant, false);
      void refreshDownloadTask().catch(() => undefined);
      const result = await install;
      if (disposedRef.current) return;
      if (!installOperation.terminalHandled) {
        setCleanupWarning(result.cleanupWarning ?? "");
        setFileProgress(completedProgress);
        if (installOperation.taskId !== null) {
          markTerminalTask(installOperation.taskId, "mmproj");
        }
        setActiveTask(null);
      }
      await refresh(true);
      if (!disposedRef.current && !installOperation.terminalHandled) {
        setMessage("模型已就绪");
        onStatusChange?.();
      }
    } catch (error) {
      if (disposedRef.current || installOperation.terminalHandled) return;
      const errorMessage = String(error);
      const canceled = errorMessage.includes("取消");
      setMessage(canceled ? "" : errorMessage);
      setFileProgress((current) => terminalProgress(
        current,
        canceled ? "canceled" : "failed",
        installOperation.lastFile,
      ));
      if (installOperation.taskId !== null) {
        markTerminalTask(installOperation.taskId, installOperation.lastFile);
      }
      installOperation.terminalHandled = true;
      setActiveTask(null);
      await refresh().catch(() => undefined);
    } finally {
      if (pendingDownloadRef.current?.operationId === guard.id) setPendingDownload(null);
      if (installOperation.taskId !== null) installTasksRef.current.delete(installOperation.taskId);
      installOperationsRef.current.delete(guard.id);
      releaseOperation(guard);
    }
  }

  async function removeModels() {
    const guard = beginOperation("removing");
    if (!guard) return;
    setMessage("");
    setCleanupWarning("");
    try {
      const result = await modelClient.removeInstalledModels();
      if (disposedRef.current) return;
      setCleanupWarning(result.cleanupWarning ?? "");
      setMessage("本地模型已移除");
      setRemoveConfirm(false);
      setFileProgress(createIdleProgress());
      await refresh(true);
      onStatusChange?.();
    } catch (error) {
      if (!disposedRef.current) setMessage(String(error));
    } finally {
      releaseOperation(guard);
    }
  }

  const isMlx = status?.inferenceBackend === "mlx";
  const runtimeReady = isMlx ? status?.mlxRuntimeAvailable : status?.llamaServerAvailable;
  const primaryAction = status && !isMlx
    ? resolveModelPrimaryAction(selectedVariant, status.ggufVariants, activeTask)
    : null;
  const hasDownloadAction = primaryAction?.kind === "cancel" || primaryAction?.kind === "canceling";
  const needsRuntimeSetup = Boolean(status && !runtimeReady && !hasDownloadAction);
  const primaryLabel = operation === "canceling"
    ? "正在取消…"
    : operation === "installing"
      ? isMlx ? "下载中…" : "处理中…"
      : needsRuntimeSetup
        ? "去环境配置"
        : isMlx ? "下载 MLX 权重" : primaryAction?.label ?? "读取中…";

  return (
    <div className="model-panel">
      {!runtimeReady && status ? (
        <div className="callout callout--attention" role="status">
          <p>{isMlx ? "MLX 未安装。" : "内置 Metal 未就绪。"}</p>
          {onOpenSetup && hasDownloadAction
            ? <button type="button" className="callout__action" onClick={onOpenSetup}>去环境配置</button>
            : null}
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
            disabled={!status
              || operation !== "idle"
              || (needsRuntimeSetup ? !onOpenSetup : Boolean(primaryAction?.disabled))}
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

        <div className="model-progress-region" aria-label={isMlx ? "MLX 下载进度" : "下载进度"} aria-live="polite">
          {isMlx && mlxProgress.status !== "idle" ? (
            <div className="model-download-progress">
              <ProgressItem label="MLX 权重" item={{ ...mlxProgress, downloaded: 0, speedMbps: null }} />
            </div>
          ) : null}
          {!isMlx && (Object.keys(fileProgress) as FileKey[]).some((key) => fileProgress[key].status !== "idle") ? (
            <div className="model-download-progress">
              {(Object.keys(fileProgress) as FileKey[])
                .filter((key) => fileProgress[key].status !== "idle")
                .map((key) => <ProgressItem key={key} label={FILE_LABELS[key]} item={fileProgress[key]} />)}
            </div>
          ) : null}
        </div>

        {!isMlx && status ? (
          <div className="model-storage-row">
            <div><span>GGUF 模型占用</span><strong>{formatModelStorage(status.modelStorageBytes)}</strong><small>含未完成下载</small></div>
            {status.modelStorageBytes > 0 && !removeConfirm ? (
              <button type="button" className="settings-btn settings-btn--danger-secondary" disabled={operation !== "idle" || activeTask !== null} onClick={() => setRemoveConfirm(true)}>移除本地模型</button>
            ) : status.modelStorageBytes > 0 ? (
              <div className="model-remove-confirm" role="group" aria-label="确认移除本地模型">
                <p>将移除全部已安装 GGUF 模型，未完成下载也会清理。</p>
                <button type="button" className="settings-btn settings-btn--danger" disabled={operation !== "idle"} onClick={() => void removeModels()}>{operation === "removing" ? "正在移除…" : "确认移除"}</button>
                <button type="button" className="settings-btn settings-btn--secondary" disabled={operation !== "idle"} onClick={() => setRemoveConfirm(false)}>取消</button>
              </div>
            ) : null}
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
          <span className="model-download-progress__percent">{
            item.status === "done"
              ? "完成"
              : item.status === "waiting"
                ? "等待"
                : item.status === "canceling"
                  ? "取消中"
                  : item.status === "canceled"
                    ? "已暂停"
                    : item.status === "failed"
                      ? "失败"
                      : `${item.percent}%`
          }</span>
        </div>
      </div>
      <div className="onboarding-overall-progress__bar" aria-hidden="true"><span style={{ width: `${item.percent}%` }} /></div>
      {item.detail ? <p className="model-download-progress__detail">{item.detail}</p> : null}
    </div>
  );
}
