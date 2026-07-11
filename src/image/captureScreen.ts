import { invoke } from "@tauri-apps/api/core";
import type { AcceptedImage } from "./imageInput";

type CapturedImagePayload = {
  name: string;
  dataUrl: string;
};

export async function captureScreenRegion(): Promise<AcceptedImage> {
  try {
    const image = await invoke<CapturedImagePayload>("capture_screen_region");
    return { name: image.name, dataUrl: image.dataUrl };
  } catch (error) {
    const message = String(error);
    if (message.includes("屏幕录制")) {
      try {
        await invoke("open_screen_recording_settings");
      } catch {
        /* 打开系统设置失败时不阻塞原错误 */
      }
    }
    throw error;
  }
}
