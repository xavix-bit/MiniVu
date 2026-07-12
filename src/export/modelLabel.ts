import type { ModelStatusResponse } from "../model/types";

export const DEFAULT_MODEL_LABEL = "MiniVu local model";

const GGUF_VARIANT_LABELS = {
  q4_k_m: "Q4_K_M",
  q5_k_m: "Q5_K_M",
  q6_k: "Q6_K",
} as const;

export function modelLabelForExport(status: ModelStatusResponse): string {
  if (status.inferenceBackend === "mlx") {
    return status.mlxModelId.trim() || DEFAULT_MODEL_LABEL;
  }
  const variant = GGUF_VARIANT_LABELS[status.ggufModelVariant];
  return variant ? `MiniCPM-V 4.6 ${variant} (GGUF)` : DEFAULT_MODEL_LABEL;
}
