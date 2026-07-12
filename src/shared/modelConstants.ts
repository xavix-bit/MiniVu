import type { GgufModelVariant } from "../settings/settingsStore";

/** GGUF 主模型与 mmproj 的预期字节数，与 Rust `model_cache` 保持一致。 */
export const GGUF_MODEL_VARIANTS: Record<
  GgufModelVariant,
  {
    label: string;
    badge: string;
    description: string;
    modelBytes: number;
  }
> = {
  q4_k_m: {
    label: "Q4 标准",
    badge: "推荐",
    description: "4-bit 量化。占用最小，默认推荐。",
    modelBytes: 529_101_504,
  },
  q5_k_m: {
    label: "Q5 高精度",
    badge: "+46 MiB",
    description: "5-bit 量化。保留更多权重精度。",
    modelBytes: 577_802_944,
  },
  q6_k: {
    label: "Q6 最高精度",
    badge: "+96 MiB",
    description: "6-bit 量化。三档中量化损失最少。",
    modelBytes: 629_548_224,
  },
};

export const DEFAULT_GGUF_MODEL_VARIANT: GgufModelVariant = "q4_k_m";
export const EXPECTED_MODEL_BYTES = GGUF_MODEL_VARIANTS[DEFAULT_GGUF_MODEL_VARIANT].modelBytes;
export const EXPECTED_MMPROJ_BYTES = 1_108_746_944;
export const EXPECTED_MLX_BYTES = 2_300_000_000;

export const EXPECTED_GGUF_BYTES: Record<"model" | "mmproj", number> = {
  model: EXPECTED_MODEL_BYTES,
  mmproj: EXPECTED_MMPROJ_BYTES,
};

export function expectedGgufBytesForVariant(variant: GgufModelVariant) {
  return {
    model: GGUF_MODEL_VARIANTS[variant].modelBytes,
    mmproj: EXPECTED_MMPROJ_BYTES,
  };
}
