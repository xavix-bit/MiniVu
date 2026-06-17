export type DownloadMirror = "auto" | "modelscope" | "huggingface";
export type MirrorId = "modelscope" | "huggingface";
export type AppTheme = "system" | "light" | "dark";
export type InferenceBackend = "llama" | "mlx";

export type AppSettings = {
  shortcut: string;
  modelWarmMinutes: 5 | 15 | 30 | -1;
  autoCheckModelUpdates: boolean;
  saveHistoryByDefault: boolean;
  allowCloudFallback: boolean;
  onboardingComplete: boolean;
  modelPath: string | null;
  downloadMirror: DownloadMirror;
  preferredMirror: MirrorId | null;
  lastSpeedTestAt: string | null;
  theme: AppTheme;
  preloadModel: boolean;
  inferenceBackend: InferenceBackend;
  mlxModelId: string;
  mlxModelPath: string | null;
};

export type MirrorProbeResult = {
  mirror: MirrorId;
  label: string;
  ok: boolean;
  latencyMs: number;
  speedMbps: number | null;
  error: string | null;
};

export type MirrorBenchmarkResponse = {
  results: MirrorProbeResult[];
  recommended: MirrorId | null;
  testedAtUnix: number;
};

export function createDefaultSettings(): AppSettings {
  return {
    shortcut: "Control+Option+Space",
    modelWarmMinutes: -1,
    autoCheckModelUpdates: false,
    saveHistoryByDefault: false,
    allowCloudFallback: false,
    onboardingComplete: false,
    modelPath: null,
    downloadMirror: "auto",
    preferredMirror: null,
    lastSpeedTestAt: null,
    theme: "system",
    preloadModel: false,
    inferenceBackend: "mlx",
    mlxModelId: "mlx-community/MiniCPM-V-4.6-4bit",
    mlxModelPath: null,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppSettings>("load_app_settings");
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_app_settings", { settings });
}
