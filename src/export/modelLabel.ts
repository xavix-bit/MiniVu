import type { ModelStatusResponse } from "../model/types";

export const DEFAULT_MODEL_LABEL = "MiniVu 本机处理";

const GGUF_VARIANT_LABELS = {
  q4_k_m: "标准",
  q5_k_m: "高精度",
  q6_k: "最高精度",
} as const;

export function publicProcessingLabel(value: string): string {
  if (/Q4|q4_k_m/i.test(value)) return `${DEFAULT_MODEL_LABEL} · 标准`;
  if (/Q5|q5_k_m/i.test(value)) return `${DEFAULT_MODEL_LABEL} · 高精度`;
  if (/Q6|q6_k/i.test(value)) return `${DEFAULT_MODEL_LABEL} · 最高精度`;
  if (/MLX/i.test(value)) return "兼容处理";
  if (/custom|自定义|[/\\]/i.test(value)) return "自定义处理";
  if (/GGUF|MiniCPM|local model/i.test(value)) return DEFAULT_MODEL_LABEL;
  return value.trim() || DEFAULT_MODEL_LABEL;
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function modelLabelForExport(status: ModelStatusResponse): string {
  if (status.inferenceBackend === "mlx") {
    const isLocal = status.mlxModelLocal
      || (status.mlxModelLocal === undefined && looksLikeLocalPath(status.mlxModelId));
    return isLocal ? "自定义处理" : "兼容处理";
  }
  if (status.modelManaged === false) {
    return "自定义处理";
  }
  const variant = GGUF_VARIANT_LABELS[status.ggufModelVariant];
  return variant ? `${DEFAULT_MODEL_LABEL} · ${variant}` : DEFAULT_MODEL_LABEL;
}
