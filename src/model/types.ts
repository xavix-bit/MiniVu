/** 与 Rust `ModelStatusResponse` 对齐。 */
export type ModelStatusResponse = {
  modelReady: boolean;
  modelDownloaded: boolean;
  mmprojDownloaded: boolean;
  modelPath: string;
  mmprojPath: string;
  modelSize: string | null;
  sidecarRunning: boolean;
  llamaServerAvailable: boolean;
  inferenceBackend: "llama" | "mlx";
  activeBackend: string;
  mlxRuntimeAvailable: boolean;
  mlxModelId: string;
  mlxModelReady: boolean;
  mlxRequiresNetwork: boolean;
};

/** 与 Rust `EnvironmentStatus` 对齐。 */
export type EnvironmentStatus = {
  onboardingComplete: boolean;
  inferenceBackend: "llama" | "mlx";
  runtimeReady: boolean;
  modelReady: boolean;
  environmentReady: boolean;
};

export type ModelRuntimeState =
  | { kind: "not_downloaded" }
  | { kind: "downloaded"; modelPath: string }
  | { kind: "loading" }
  | { kind: "ready"; modelVersion: string }
  | { kind: "answering" }
  | { kind: "error"; message: string };

export function modelStatusToRuntimeState(status: ModelStatusResponse): ModelRuntimeState {
  if (status.modelReady) {
    return {
      kind: "ready",
      modelVersion: status.inferenceBackend === "mlx" ? status.mlxModelId : status.modelPath,
    };
  }
  if (status.modelDownloaded || status.mlxModelReady) {
    return { kind: "downloaded", modelPath: status.modelPath };
  }
  return { kind: "not_downloaded" };
}
