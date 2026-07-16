import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  updateSettings,
} from "../src/settings/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("settingsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses privacy-safe defaults", () => {
    const settings = createDefaultSettings();

    expect(settings.shortcut).toBe("Control+Option+Space");
    expect(settings.modelWarmMinutes).toBe(10);
    expect(settings.theme).toBe("system");
    expect(settings.preloadModel).toBe(false);
    expect(settings.inferenceBackend).toBe("llama");
    expect(settings.ggufModelVariant).toBe("q4_k_m");
    expect(settings.mlxModelId).toBe("mlx-community/MiniCPM-V-4.6-4bit");
    expect(settings.autoCheckModelUpdates).toBe(false);
    expect(settings.saveHistoryByDefault).toBe(true);
    expect(settings.captureRetention).toBe("24h");
    expect(settings.backgroundWarmup).toBe(false);
    expect(settings.allowCloudFallback).toBe(false);
    expect(settings.onboardingComplete).toBe(false);
    expect(settings.downloadMirror).toBe("auto");
    expect(settings.preferredMirror).toBeNull();
    expect(settings.lastSpeedTestAt).toBeNull();
  });

  it("sends settings patches through one atomic backend command", async () => {
    const committed = {
      ...createDefaultSettings(),
      theme: "dark" as const,
    };
    vi.mocked(invoke).mockResolvedValueOnce(committed);

    await expect(updateSettings({ theme: "dark" })).resolves.toEqual(committed);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("update_app_settings", {
      patch: { theme: "dark" },
    });
  });

  it("forwards concurrent patches independently to the synchronized backend", async () => {
    const themeCommit = createDeferred<ReturnType<typeof createDefaultSettings>>();
    const backendCommit = createDeferred<ReturnType<typeof createDefaultSettings>>();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "update_app_settings") {
        throw new Error(`Unexpected command: ${command}`);
      }
      const patch = (args as { patch: Record<string, unknown> }).patch;
      return (patch.theme ? themeCommit.promise : backendCommit.promise) as ReturnType<typeof invoke>;
    });

    const themeUpdate = updateSettings({ theme: "dark" });
    const backendUpdate = updateSettings({ inferenceBackend: "mlx" });

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenNthCalledWith(1, "update_app_settings", {
      patch: { theme: "dark" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "update_app_settings", {
      patch: { inferenceBackend: "mlx" },
    });

    themeCommit.resolve({ ...createDefaultSettings(), theme: "dark" });
    backendCommit.resolve({
      ...createDefaultSettings(),
      theme: "dark",
      inferenceBackend: "mlx",
    });

    await expect(themeUpdate).resolves.toMatchObject({ theme: "dark" });
    await expect(backendUpdate).resolves.toMatchObject({
      theme: "dark",
      inferenceBackend: "mlx",
    });
  });

  it("continues updates after an atomic patch is rejected", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce({
        ...createDefaultSettings(),
        captureRetention: "7d",
      });

    const rejectedUpdate = updateSettings({ theme: "dark" });
    const recoveryUpdate = updateSettings({ captureRetention: "7d" });

    await expect(rejectedUpdate).rejects.toThrow("disk unavailable");
    await expect(recoveryUpdate).resolves.toMatchObject({
      theme: "system",
      captureRetention: "7d",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
