import { invoke } from "@tauri-apps/api/core";
import type { AcceptedImage } from "./imageInput";

type CapturedImagePayload = {
  name: string;
  dataUrl: string;
};

export type CaptureErrorCode = "cancelled" | "permission-denied" | "unknown";

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode) {
    const messages: Record<CaptureErrorCode, string> = {
      cancelled: "截图已取消",
      "permission-denied": "需要屏幕录制权限",
      unknown: "截图失败",
    };
    super(messages[code]);
    this.name = "CaptureError";
    this.code = code;
  }
}

function failureMessage(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return error.message.trim();
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message.trim();
  }
  try {
    return String(error).trim();
  } catch {
    return "";
  }
}

function captureErrorCode(error: unknown): CaptureErrorCode {
  const message = failureMessage(error);
  if (message === "已取消截图") return "cancelled";

  const normalized = message.toLocaleLowerCase();
  const mentionsScreenRecording = normalized.includes("屏幕录制")
    || /screen[ -]recording/.test(normalized);
  const mentionsPermission = /允许|权限|授权|allow|permission|permit|grant/.test(normalized);
  return mentionsScreenRecording && mentionsPermission ? "permission-denied" : "unknown";
}

export async function openScreenRecordingSettings(): Promise<void> {
  await invoke("open_screen_recording_settings");
}

export async function captureScreenRegion(): Promise<AcceptedImage> {
  try {
    const image = await invoke<CapturedImagePayload>("capture_screen_region");
    return { name: image.name, dataUrl: image.dataUrl };
  } catch (error) {
    throw new CaptureError(captureErrorCode(error));
  }
}
