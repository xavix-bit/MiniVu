import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/settings/settingsStore";

describe("settingsStore", () => {
  it("uses privacy-safe defaults", () => {
    const settings = createDefaultSettings();

    expect(settings.shortcut).toBe("Control+Option+Space");
    expect(settings.modelWarmMinutes).toBe(-1);
    expect(settings.theme).toBe("system");
    expect(settings.preloadModel).toBe(true);
    expect(settings.inferenceBackend).toBe("mlx");
    expect(settings.mlxModelId).toBe("mlx-community/MiniCPM-V-4.6-4bit");
    expect(settings.autoCheckModelUpdates).toBe(false);
    expect(settings.saveHistoryByDefault).toBe(false);
    expect(settings.allowCloudFallback).toBe(false);
    expect(settings.onboardingComplete).toBe(false);
    expect(settings.modelPath).toBeNull();
    expect(settings.downloadMirror).toBe("auto");
    expect(settings.preferredMirror).toBeNull();
    expect(settings.lastSpeedTestAt).toBeNull();
  });
});
