import { invoke } from "@tauri-apps/api/core";

export type DownloadMirror = "auto" | "modelscope" | "huggingface";
export type MirrorId = "modelscope" | "huggingface";
export type AppTheme = "system" | "light" | "dark";
export type InferenceBackend = "llama" | "mlx";
export type GgufModelVariant = "q4_k_m" | "q5_k_m" | "q6_k";
export type CaptureRetentionSetting = "none" | "24h" | "7d" | "forever";

export type AppSettings = {
  shortcut: string;
  modelWarmMinutes: 5 | 10 | 15 | 30 | -1;
  autoCheckModelUpdates: boolean;
  saveHistoryByDefault: boolean;
  allowCloudFallback: boolean;
  onboardingComplete: boolean;
  workbenchTipsComplete: boolean;
  ggufModelVariant: GgufModelVariant;
  downloadMirror: DownloadMirror;
  preferredMirror: MirrorId | null;
  lastSpeedTestAt: string | null;
  theme: AppTheme;
  preloadModel: boolean;
  captureRetention: CaptureRetentionSetting;
  backgroundWarmup: boolean;
  inferenceBackend: InferenceBackend;
  mlxModelId: string;
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
    modelWarmMinutes: 10,
    autoCheckModelUpdates: false,
    saveHistoryByDefault: true,
    allowCloudFallback: false,
    onboardingComplete: false,
    workbenchTipsComplete: false,
    ggufModelVariant: "q4_k_m",
    downloadMirror: "auto",
    preferredMirror: null,
    lastSpeedTestAt: null,
    theme: "system",
    preloadModel: false,
    captureRetention: "24h",
    backgroundWarmup: false,
    inferenceBackend: "llama",
    mlxModelId: "mlx-community/MiniCPM-V-4.6-4bit",
  };
}

export async function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_app_settings");
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_app_settings", { settings });
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return invoke<AppSettings>("update_app_settings", { patch });
}
