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
import { EXPECTED_MMPROJ_BYTES, GGUF_MODEL_VARIANTS } from "../shared/modelConstants";
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
  cancelAccepted: boolean;
};

type PendingInstall = PendingDownload & {
  operationId: number;
};

const FILE_LABELS: Record<FileKey, string> = {
  model: "问答组件",
  mmproj: "图片理解组件",
};

const VARIANT_COPY: Record<GgufModelVariant, { label: string; description: string; technicalLabel: string }> = {
  q4_k_m: { label: "标准", description: "下载更快，占用空间最少，推荐大多数设备。", technicalLabel: "Q4 · q4_k_m" },
  q5_k_m: { label: "高精度", description: "保留更多细节，空间占用适中。", technicalLabel: "Q5 · q5_k_m" },
  q6_k: { label: "最高精度", description: "三档中细节保留最多，占用空间也更大。", technicalLabel: "Q6 · q6_k" },
};

function safeModelError(error: unknown, fallback = "操作未完成，请重试。"): string {
  const detail = String(error).toLowerCase();
  if (detail.includes("取消") || detail.includes("cancel")) return "下载状态已变化，请刷新后重试。";
  if (detail.includes("space") || detail.includes("disk") || detail.includes("空间")) {
    return "可用空间不足，请清理空间后重试。";
  }
  if (detail.includes("health") || detail.includes("start") || detail.includes("sidecar")) {
    return "下载内容无法启用，请重新启动应用后重试。";
  }
  if (detail.includes("http") || detail.includes("network") || detail.includes("download") || detail.includes("网络")) {
    return "下载未完成，请检查网络后重试。";
  }
  return fallback;
}

function isCancellationError(error: unknown): boolean {
  const detail = String(error).toLowerCase();
  return detail.includes("取消") || detail.includes("cancel");
}

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
  if (item?.installed) return "已下载";
  if (item && item.partialBytes > 0) return "可续传";
  return "未安装";
}

export function ModelPanel({ onOpenSetup, onStatusChange }: ModelPanelProps) {
  const [status, setStatus] = useState<ModelStatusResponse | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<GgufModelVariant>("q4_k_m");
  const [activeTask, setActiveTaskState] = useState<DownloadTaskSnapshot | null>(null);
  const [pendingDownload, setPendingDownloadState] = useState<PendingInstall | null>(null);
  const [operation, setOperation] = useState<"idle" | "installing" | "switching" | "canceling" | "removing">("idle");
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
      if (!disposedRef.current) setOperation("idle");
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
        install.lastFile = task.file === "mmproj" ? "mmproj" : install.lastFile;
        if (task.status === "canceled" || task.status === "failed") {
          install.terminalHandled = true;
          releaseOperation(install.guard);
        } else if (task.status === "done" && task.file === "mmproj") {
          setOperation("switching");
        }
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

  async function refreshAfterCancelFailure() {
    const [nextStatus, task] = await Promise.all([
      modelClient.getModelStatus(),
      modelClient.getModelDownloadStatus(),
    ]);
    if (disposedRef.current) return;
    setStatus(nextStatus);
    if (task) {
      applyObservedSnapshot(task);
      return;
    }
    setActiveTask(null);
    setFileProgress(createIdleProgress());
  }

  useEffect(() => {
    let disposed = false;
    disposedRef.current = false;
    void refresh(true).catch((error) => {
      if (!disposed) setMessage(safeModelError(error, "暂时无法读取下载状态，请重试。"));
    });
    let unlisten: (() => void) | undefined;
    void listen<DownloadProgressEvent>("model-download-progress", (event) => {
      if (disposed) return;
      const payload = event.payload;
      if (payload.file === "mlx") {
        setMlxProgress((current) => ({
          status: payload.status === "done" ? "done" : "running",
          percent: payload.status === "done" ? 100 : resolveMlxPercent(current.percent, payload.downloaded),
          detail: payload.status === "done" ? "下载完成" : "正在下载所需内容…",
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
                payload.status === "waiting" ? "等待中…" : "正在尝试其他下载来源…",
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
        if (installOperation) {
          installOperation.terminalHandled = true;
          releaseOperation(installOperation.guard);
        }
        if (operationGuardRef.current?.kind === "canceling") {
          releaseOperation(operationGuardRef.current);
        }
        void refresh().catch((error) => {
          if (!disposed) setMessage(safeModelError(error, "暂时无法刷新下载状态，请重试。"));
        });
      } else if (payload.status === "done" && payload.file === "mmproj" && installOperation) {
        setOperation("switching");
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
    if (!status) return;
    const heldGuard = operationGuardRef.current;
    const isMlx = status.inferenceBackend === "mlx";
    if (isMlx) {
      if (heldGuard) return;
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
          setMessage(safeModelError(error, "下载未完成，请重试。"));
          setMlxProgress({ status: "idle", percent: 0, detail: "" });
        }
      } finally {
        releaseOperation(guard);
      }
      return;
    }

    const action = resolveModelPrimaryAction(selectedVariant, status.ggufVariants, activeTask);
    if (action.kind === "cancel" && activeTask) {
      const claimedInstall = installTasksRef.current.get(activeTask.taskId);
      const guard = claimedInstall && heldGuard && claimedInstall.guard.id === heldGuard.id
        ? heldGuard
        : beginOperation("canceling");
      if (!guard) return;
      const taskId = activeTask.taskId;
      setMessage("");
      if (!disposedRef.current) setOperation("canceling");
      try {
        await modelClient.cancelModelDownload(taskId);
        if (claimedInstall) claimedInstall.cancelAccepted = true;
        await refreshDownloadTask();
      } catch {
        try {
          await refreshAfterCancelFailure();
          if (!disposedRef.current) setMessage("无法取消，下载状态可能已变化，已为你刷新。");
        } catch {
          if (!disposedRef.current) setMessage("无法取消，也暂时无法刷新状态，请稍后重试。");
        }
        if (guard.kind === "installing") {
          if (!disposedRef.current) setOperation("idle");
        } else {
          releaseOperation(guard);
        }
      }
      return;
    }
    if (heldGuard) return;
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
      cancelAccepted: false,
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
        mmproj: { status: "waiting", percent: 0, downloaded: 0, speedMbps: null, detail: "等待问答组件完成…" },
      });
      const install = modelClient.installGgufModel(selectedVariant, false);
      void refreshDownloadTask().catch(() => undefined);
      const result = await install;
      if (disposedRef.current) return;
      if (!installOperation.terminalHandled) {
        setCleanupWarning(result.cleanupWarning ? "部分旧内容暂未清理，可稍后重试。" : "");
        setFileProgress(completedProgress);
        if (installOperation.taskId !== null) {
          markTerminalTask(installOperation.taskId, "mmproj");
        }
        setActiveTask(null);
      }
      await refresh(true);
      if (!disposedRef.current && !installOperation.terminalHandled) {
        setMessage("下载内容已就绪");
        onStatusChange?.();
      }
    } catch (error) {
      if (disposedRef.current || installOperation.terminalHandled) return;
      const canceled = installOperation.cancelAccepted && isCancellationError(error);
      setMessage(canceled ? "" : safeModelError(error, "下载内容无法启用，请重新启动应用后重试。"));
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
      setCleanupWarning(result.cleanupWarning ? "部分旧内容暂未清理，可稍后重试。" : "");
      setMessage("下载内容已移除");
      setRemoveConfirm(false);
      setFileProgress(createIdleProgress());
      await refresh(true);
      onStatusChange?.();
    } catch (error) {
      if (!disposedRef.current) setMessage(safeModelError(error, "暂时无法移除，请重试。"));
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
  const questionReady = isMlx ? status?.mlxModelReady : status?.modelDownloaded;
  const imageReady = isMlx ? status?.mlxModelReady : status?.mmprojDownloaded;
  const contentState = (ready: boolean | undefined) => status ? ready ? "已下载" : "未下载" : "读取中";
  const storageValue = !status
    ? "读取中"
    : isMlx
      ? status.mlxModelReady ? "由系统管理" : "未下载"
      : formatModelStorage(status.modelStorageBytes);
  const primaryLabel = operation === "canceling"
    ? "正在取消…"
    : operation === "switching"
      ? "正在切换…"
    : operation === "installing"
      ? isMlx ? "下载中…" : "处理中…"
      : needsRuntimeSetup
        ? "去首次设置"
        : isMlx ? "下载所需内容" : primaryAction?.label ?? "读取中…";

  return (
    <div className="model-panel">
      {!runtimeReady && status ? (
        <div className="callout callout--attention" role="status">
          <p>应用组件尚未准备好。</p>
        </div>
      ) : null}

      <section className="surface model-panel__files" aria-label="内容摘要">
        <ul className="model-file-list">
          <li className="model-file-list__item">
            <div className="model-file-list__head">
              <span className="model-file-list__label">问答组件</span>
              <strong className={`model-file-list__value${questionReady ? " is-positive" : ""}`}>{contentState(questionReady)}</strong>
            </div>
            <span className="model-file-list__path">用于理解问题并生成回答</span>
          </li>
          <li className="model-file-list__item">
            <div className="model-file-list__head">
              <span className="model-file-list__label">图片理解组件</span>
              <strong className={`model-file-list__value${imageReady ? " is-positive" : ""}`}>{contentState(imageReady)}</strong>
            </div>
            <span className="model-file-list__path">用于读取图片中的内容</span>
          </li>
          <li className="model-file-list__item">
            <div className="model-file-list__head">
              <span className="model-file-list__label">已用空间</span>
              <strong className="model-file-list__value">{storageValue}</strong>
            </div>
            <span className="model-file-list__path">{isMlx ? "系统按需管理" : "含未完成下载"}</span>
          </li>
        </ul>
        {isMlx ? (
          <details className="settings-advanced">
            <summary>技术详情</summary>
            <p>MLX 兼容模式</p>
          </details>
        ) : null}
      </section>

      {!isMlx ? (
        <section className="surface model-variant-picker" aria-label="精度选择">
          <p className="model-variant-picker__note">
            三档提供不同的细节与空间占用。首次安装包含一份共用的 1.03 GiB 图片理解组件。
          </p>
          {(Object.entries(GGUF_MODEL_VARIANTS) as Array<[GgufModelVariant, (typeof GGUF_MODEL_VARIANTS)[GgufModelVariant]]>).map(([variant, spec]) => {
            const selected = variant === selectedVariant;
            const stateLabel = status ? variantStateLabel(status, variant) : "读取中";
            const copy = VARIANT_COPY[variant];
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
                <span className="model-variant-option__head"><strong>{copy.label}</strong><span>{spec.badge}</span></span>
                <span className={`model-variant-option__state${stateLabel === "当前使用" ? " is-current" : ""}`}>{stateLabel}</span>
                <span className="model-variant-option__desc">{copy.description}</span>
                <span className="model-variant-option__meta">
                  <span>下载大小 {formatModelStorage(spec.modelBytes)}</span>
                  <span>首次安装 {formatModelStorage(spec.modelBytes + EXPECTED_MMPROJ_BYTES, 2)}</span>
                </span>
              </button>
            );
          })}
          <details className="settings-advanced">
            <summary>技术详情</summary>
            <ul>
              {(Object.keys(VARIANT_COPY) as GgufModelVariant[]).map((variant) => (
                <li key={variant}>{VARIANT_COPY[variant].label}：{VARIANT_COPY[variant].technicalLabel}</li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      <section className="surface model-panel__actions-card" aria-label="下载操作">
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
          {message ? <p className={message.includes("已就绪") || message.includes("已移除") ? "model-success" : "onboarding-error"}>{message}</p> : null}
          {cleanupWarning ? <p className="model-cleanup-warning">{cleanupWarning}</p> : null}
        </div>

        <div className="model-progress-region" aria-label="下载进度" aria-live="polite">
          {isMlx && mlxProgress.status !== "idle" ? (
            <div className="model-download-progress">
              <ProgressItem label="问答组件与图片理解组件" item={{ ...mlxProgress, downloaded: 0, speedMbps: null }} />
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

        {!isMlx && status && status.modelStorageBytes > 0 ? (
          <div className="model-storage-row">
            <div><span>存储管理</span><small>移除后可重新下载</small></div>
            {!removeConfirm ? (
              <button type="button" className="settings-btn settings-btn--danger-secondary" disabled={operation !== "idle" || activeTask !== null} onClick={() => setRemoveConfirm(true)}>移除下载内容</button>
            ) : (
              <div className="model-remove-confirm" role="group" aria-label="确认移除下载内容">
                <p>将移除全部已下载内容，未完成下载也会清理。</p>
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
