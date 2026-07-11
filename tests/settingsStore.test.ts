import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSettings, saveSettings } from "../src/settings/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("settingsStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("uses privacy-safe defaults", () => {
    const settings = createDefaultSettings();

    expect(settings.shortcut).toBe("Control+Option+Space");
    expect(settings.modelWarmMinutes).toBe(-1);
    expect(settings.theme).toBe("system");
    expect(settings.preloadModel).toBe(false);
    expect(settings.inferenceBackend).toBe("llama");
    expect(settings.ggufModelVariant).toBe("q4_k_m");
    expect(settings.mlxModelId).toBe("mlx-community/MiniCPM-V-4.6-4bit");
    expect(settings.autoCheckModelUpdates).toBe(false);
    expect(settings.saveHistoryByDefault).toBe(false);
    expect(settings.allowCloudFallback).toBe(false);
    expect(settings.onboardingComplete).toBe(false);
    expect(settings.downloadMirror).toBe("auto");
    expect(settings.preferredMirror).toBeNull();
    expect(settings.lastSpeedTestAt).toBeNull();
  });

  it("uses general intent by default when saving settings", async () => {
    const settings = createDefaultSettings();
    invokeMock.mockResolvedValue(undefined);

    await saveSettings(settings);

    expect(invokeMock).toHaveBeenCalledWith("save_app_settings", {
      settings,
      intent: "general",
    });
  });

  it("passes explicit model variant save intent", async () => {
    const settings = createDefaultSettings();
    invokeMock.mockResolvedValue(undefined);

    await saveSettings(settings, "modelVariant");

    expect(invokeMock).toHaveBeenCalledWith("save_app_settings", {
      settings,
      intent: "modelVariant",
    });
  });
});
