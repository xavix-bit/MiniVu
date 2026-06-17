/** GGUF 主模型与 mmproj 的预期字节数，与 Rust `model_cache` 保持一致。 */
export const EXPECTED_MODEL_BYTES = 5_026_714_304;
export const EXPECTED_MMPROJ_BYTES = 1_095_113_184;
export const EXPECTED_MLX_BYTES = 2_000_000_000;

export const EXPECTED_GGUF_BYTES: Record<"model" | "mmproj", number> = {
  model: EXPECTED_MODEL_BYTES,
  mmproj: EXPECTED_MMPROJ_BYTES,
};
