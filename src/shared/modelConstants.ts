import type { GgufModelVariant } from "../settings/settingsStore";

/** GGUF 主模型与 mmproj 的预期字节数，与 Rust `model_cache` 保持一致。 */
export const GGUF_MODEL_VARIANTS: Record<
  GgufModelVariant,
  {
    label: string;
    modelName: string;
    badge: string;
    description: string;
    modelBytes: number;
    memoryHint: string;
  }
> = {
  q4_k_m: {
    label: "均衡",
    modelName: "OpenBMB MiniCPM-V 4.6 · Q4_K_M",
    badge: "推荐",
    description: "下载最快，适合日常截图、翻译和问图。",
    modelBytes: 529_101_504,
    memoryHint: "约 2 GB 内存",
  },
  q5_k_m: {
    label: "清晰",
    modelName: "OpenBMB MiniCPM-V 4.6 · Q5_K_M",
    badge: "更稳",
    description: "文字和细节更稳，体积只多一点。",
    modelBytes: 577_802_944,
    memoryHint: "约 2.3 GB 内存",
  },
  q6_k: {
    label: "高质量",
    modelName: "OpenBMB MiniCPM-V 4.6 · Q6_K",
    badge: "更准",
    description: "适合复杂界面和更细的图像理解。",
    modelBytes: 629_548_224,
    memoryHint: "约 2.6 GB 内存",
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
