import { open } from "@tauri-apps/plugin-dialog";
import { renderSessionMarkdown } from "./exportMarkdown";
import type { ImageSessionState } from "../chat/useImageSession";
import type { ModelStatusResponse } from "../model/types";

const DEFAULT_MODEL_LABEL = "MiniVu local model";

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

export async function exportCurrentSession(
  session: ImageSessionState,
  modelVersion = DEFAULT_MODEL_LABEL,
): Promise<string | null> {
  if (!session.image) {
    throw new Error("先添加图片。");
  }

  const directory = await open({
    title: "选择导出目录",
    directory: true,
    multiple: false,
  });

  if (!directory || Array.isArray(directory)) {
    return null;
  }

  const markdown = renderSessionMarkdown({
    title: "MiniVu 会话",
    imageFilename: session.image.name,
    ocrText: session.ocrText,
    modelVersion,
    messages: session.messages,
  });

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("export_session", {
    request: {
      directory,
      markdown,
      imageDataUrl: session.image.dataUrl,
      imageFilename: session.image.name,
    },
  });
}
