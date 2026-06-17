import { invoke } from "@tauri-apps/api/core";
import { readClipboardImage } from "./imageIntake";

export async function captureScreenRegion() {
  await invoke("capture_screen_region");
  const image = await readClipboardImage();
  if (!image) {
    throw new Error("未获取到截图。请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 MiniVu。");
  }
  return { ...image, name: "screenshot.png" };
}
