import { open } from "@tauri-apps/plugin-dialog";
import { renderSessionMarkdown } from "./exportMarkdown";
import type { ImageSessionState } from "../chat/useImageSession";
import { DEFAULT_MODEL_LABEL } from "./modelLabel";

export { modelLabelForExport } from "./modelLabel";

export async function exportCurrentSession(
  session: ImageSessionState,
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
    modelVersion: DEFAULT_MODEL_LABEL,
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
