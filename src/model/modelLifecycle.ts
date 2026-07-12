import type { GgufModelVariant } from "../settings/settingsStore";
import type { DownloadTaskSnapshot, GgufVariantInventory } from "./types";

export type ModelPrimaryAction = {
  kind: "cancel" | "canceling" | "current" | "switch" | "resume" | "install";
  label: string;
  disabled: boolean;
};

type DownloadEventIdentity = Pick<DownloadTaskSnapshot, "taskId" | "variant">;

export type PendingDownload = {
  variant: GgufModelVariant;
  baselineTaskId: number;
};

export function isActiveDownload(snapshot: DownloadTaskSnapshot | null): boolean {
  return snapshot !== null && !["done", "failed", "canceled"].includes(snapshot.status);
}

export function claimPendingDownload(
  snapshot: DownloadTaskSnapshot | null,
  pending: PendingDownload,
): DownloadTaskSnapshot | null {
  if (!snapshot || !isActiveDownload(snapshot)) return null;
  if (snapshot.taskId <= pending.baselineTaskId) return null;
  return snapshot.variant === pending.variant ? snapshot : null;
}

export function matchesActiveDownload(
  event: DownloadEventIdentity,
  activeTask: DownloadTaskSnapshot | null,
): boolean {
  return isActiveDownload(activeTask)
    && activeTask !== null
    && event.taskId === activeTask.taskId
    && event.variant === activeTask.variant;
}

export function formatModelStorage(bytes: number, fractionDigits = 1): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) {
    return `${Math.round(megabytes)} MiB`;
  }
  const gigabytes = megabytes / 1024;
  return `${gigabytes.toFixed(fractionDigits).replace(/\.0+$/, "")} GiB`;
}

export function resolveModelPrimaryAction(
  selectedVariant: GgufModelVariant,
  inventory: GgufVariantInventory[],
  activeTask: DownloadTaskSnapshot | null,
): ModelPrimaryAction {
  if (activeTask?.status === "cancelRequested") {
    return { kind: "canceling", label: "正在取消…", disabled: true };
  }
  if (isActiveDownload(activeTask)) {
    return { kind: "cancel", label: "取消下载", disabled: false };
  }
  const selected = inventory.find((item) => item.variant === selectedVariant);
  if (selected?.installed && selected.active) {
    return { kind: "current", label: "当前使用", disabled: true };
  }
  if (selected?.installed) {
    return { kind: "switch", label: "切换到此模型", disabled: false };
  }
  if (selected && selected.partialBytes > 0) {
    return { kind: "resume", label: "继续下载并切换", disabled: false };
  }
  return { kind: "install", label: "下载并切换", disabled: false };
}
