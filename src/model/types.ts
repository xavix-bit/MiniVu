/** 与 Rust `ModelStatusResponse` 对齐；运维/调试详情（侧车、路径、后端细项）。 */
import type { GgufModelVariant } from "../settings/settingsStore";

export type GgufVariantInventory = {
  variant: GgufModelVariant;
  installed: boolean;
  installedBytes: number;
  partialBytes: number;
  expectedBytes: number;
  active: boolean;
};

/** 与 Rust `DownloadTaskSnapshot` 的 camelCase 序列化结果一致。 */
export type DownloadTaskSnapshot = {
  taskId: number;
  variant: GgufModelVariant;
  status: string;
  file: string | null;
  downloaded: number;
  total: number | null;
  source: string | null;
};

export type ModelStatusResponse = {
  modelReady: boolean;
  modelDownloaded: boolean;
  mmprojDownloaded: boolean;
  modelPath: string;
  mmprojPath: string;
  modelSize: string | null;
  sidecarRunning: boolean;
  llamaServerAvailable: boolean;
  inferenceBackend: "llama" | "mlx";
  ggufModelVariant: GgufModelVariant;
  ggufVariants: GgufVariantInventory[];
  modelStorageBytes: number;
  activeBackend: string;
  mlxRuntimeAvailable: boolean;
  mlxModelId: string;
  mlxModelReady: boolean;
  mlxRequiresNetwork: boolean;
};

/** 模型安装、切换或删除后的真实磁盘状态。 */
export type ModelMutationResult = {
  activeVariant: GgufModelVariant;
  modelStorageBytes: number;
  cleanupWarning: string | null;
  inventory: GgufVariantInventory[];
};

/** 与 Rust `EnvironmentStatus` 对齐；环境是否可正常使用的单一判定来源。 */
export type EnvironmentStatus = {
  onboardingComplete: boolean;
  inferenceBackend: "llama" | "mlx";
  runtimeReady: boolean;
  modelReady: boolean;
  environmentReady: boolean;
};

/** 根据 EnvironmentStatus 计算首页就绪度环（runtime + model，不含 onboarding）。 */
export function environmentReadinessPercent(status: EnvironmentStatus): number {
  if (status.environmentReady) {
    return 100;
  }
  const items = [status.runtimeReady, status.modelReady];
  const done = items.filter(Boolean).length;
  return Math.round((done / items.length) * 100);
}
