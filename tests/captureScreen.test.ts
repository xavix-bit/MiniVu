import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CaptureError,
  captureScreenRegion,
  openScreenRecordingSettings,
} from "../src/image/captureScreen";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("captureScreenRegion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes an exact trimmed cancellation without opening System Settings", async () => {
    vi.mocked(invoke).mockRejectedValue("  已取消截图  ");

    await expect(captureScreenRegion()).rejects.toMatchObject<CaptureError>({
      code: "cancelled",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("capture_screen_region");
  });

  it.each([
    "无法截图。请在系统设置里允许屏幕录制后重启 MiniVu。",
    new Error("Screen recording permission is required"),
    { message: "请允许 MiniVu 使用屏幕录制权限" },
  ])("normalizes screen-recording permission failures without opening settings", async (failure) => {
    vi.mocked(invoke).mockRejectedValue(failure);

    await expect(captureScreenRegion()).rejects.toMatchObject<CaptureError>({
      code: "permission-denied",
      message: "需要屏幕录制权限",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("opens Screen Recording settings only through the explicit command", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);

    await openScreenRecordingSettings();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("open_screen_recording_settings");
  });

  it("returns the accepted image payload on success", async () => {
    vi.mocked(invoke).mockResolvedValue({
      name: "screenshot.png",
      dataUrl: "data:image/png;base64,AAA",
    });

    await expect(captureScreenRegion()).resolves.toEqual({
      name: "screenshot.png",
      dataUrl: "data:image/png;base64,AAA",
    });
  });

  it.each([
    new Error("已取消截图。"),
    { message: "正在截图" },
    "框选截图目前仅支持 macOS",
    { message: "屏幕录制服务暂时不可用" },
    { message: "sidecar failed at /private/tmp/model.gguf" },
    Object.create(null),
  ])("normalizes every other failure as unknown without exposing its message", async (failure) => {
    vi.mocked(invoke).mockRejectedValue(failure);

    await expect(captureScreenRegion()).rejects.toMatchObject<CaptureError>({
      code: "unknown",
      message: "截图失败",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error("已取消截图"),
    { message: "  已取消截图  " },
  ])("normalizes exact cancellation messages from error-shaped failures", async (failure) => {
    vi.mocked(invoke).mockRejectedValue(failure);

    await expect(captureScreenRegion()).rejects.toMatchObject<CaptureError>({
      code: "cancelled",
    });
  });
});
