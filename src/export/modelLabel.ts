import type { ModelStatusResponse } from "../model/types";

export const DEFAULT_MODEL_LABEL = "MiniVu local model";

const GGUF_VARIANT_LABELS = {
  q4_k_m: "Q4",
  q5_k_m: "Q5",
  q6_k: "Q6",
} as const;

function basename(path: string, fallback: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? fallback;
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function modelLabelForExport(status: ModelStatusResponse): string {
  if (status.inferenceBackend === "mlx") {
    if (status.mlxModelLocal || (status.mlxModelLocal === undefined && looksLikeLocalPath(status.mlxModelId))) {
      return `Custom MLX · ${basename(status.mlxModelId, "local-model")}`;
    }
    return status.mlxModelId.trim() || DEFAULT_MODEL_LABEL;
  }
  if (status.modelManaged === false) {
    return `Custom GGUF · ${basename(status.modelPath, "local-model.gguf")}`;
  }
  const variant = GGUF_VARIANT_LABELS[status.ggufModelVariant];
  return variant ? `MiniCPM-V 4.6 GGUF · ${variant}` : DEFAULT_MODEL_LABEL;
}
