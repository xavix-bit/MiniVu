import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  updateSettings,
  type AppSettings,
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

  it("serializes concurrent patches so both changes are committed", async () => {
    let persisted = createDefaultSettings();
    let saveCount = 0;
    const firstSave = createDeferred<void>();

    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "load_app_settings") {
        return { ...persisted };
      }
      if (command === "save_app_settings") {
        saveCount += 1;
        if (saveCount === 1) {
          await firstSave.promise;
        }
        persisted = { ...(args as { settings: AppSettings }).settings };
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const themeUpdate = updateSettings({ theme: "dark" });
    const backendUpdate = updateSettings({ inferenceBackend: "mlx" });

    await vi.waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_app_settings"),
      ).toHaveLength(1),
    );
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === "load_app_settings"),
    ).toHaveLength(1);

    firstSave.resolve();
    const [themeCommit, backendCommit] = await Promise.all([themeUpdate, backendUpdate]);

    expect(themeCommit.theme).toBe("dark");
    expect(backendCommit).toMatchObject({ theme: "dark", inferenceBackend: "mlx" });
    expect(persisted).toMatchObject({ theme: "dark", inferenceBackend: "mlx" });
  });

  it("continues queued updates after a rejected save", async () => {
    let persisted = createDefaultSettings();
    let rejectNextSave = true;

    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "load_app_settings") {
        return { ...persisted };
      }
      if (command === "save_app_settings") {
        if (rejectNextSave) {
          rejectNextSave = false;
          throw new Error("disk unavailable");
        }
        persisted = { ...(args as { settings: AppSettings }).settings };
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const rejectedUpdate = updateSettings({ theme: "dark" });
    const recoveryUpdate = updateSettings({ captureRetention: "7d" });

    await expect(rejectedUpdate).rejects.toThrow("disk unavailable");
    await expect(recoveryUpdate).resolves.toMatchObject({
      theme: "system",
      captureRetention: "7d",
    });
    expect(persisted).toMatchObject({ theme: "system", captureRetention: "7d" });
  });
});
