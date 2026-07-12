import type { GgufModelVariant } from "../settings/settingsStore";
import type { DownloadTaskSnapshot, GgufVariantInventory } from "./types";

export type ModelPrimaryAction = {
  kind: "cancel" | "current" | "switch" | "resume" | "install";
  label: string;
  disabled: boolean;
};

type DownloadEventIdentity = Pick<DownloadTaskSnapshot, "taskId" | "variant">;

export function matchesActiveDownload(
  event: DownloadEventIdentity,
  activeTask: DownloadTaskSnapshot | null,
  pendingVariant: GgufModelVariant | null,
): boolean {
  if (activeTask) {
    return event.taskId === activeTask.taskId && event.variant === activeTask.variant;
  }
  return pendingVariant !== null && event.variant === pendingVariant;
}

export function formatModelStorage(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) {
    return `${Math.round(megabytes)} MB`;
  }
  const gigabytes = megabytes / 1024;
  return `${gigabytes.toFixed(1).replace(/\.0$/, "")} GB`;
}

export function resolveModelPrimaryAction(
  selectedVariant: GgufModelVariant,
  inventory: GgufVariantInventory[],
  activeTask: DownloadTaskSnapshot | null,
): ModelPrimaryAction {
  if (activeTask && !["done", "failed", "canceled"].includes(activeTask.status)) {
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
