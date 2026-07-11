import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { EnvironmentStatus, ModelStatusResponse } from "./types";

export type AskImageRequest = {
  imageDataUrl: string;
  ocrText: string;
  prompt: string;
  history: { role: string; content: string }[];
};

export type StreamChunk = {
  text: string;
  done: boolean;
};

export type ModelClient = {
  askImage(
    request: AskImageRequest,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<void>;
  cancelGeneration(): Promise<void>;
  warmupModel(): Promise<void>;
  unloadWhenIdle(): Promise<void>;
  /** 运维/调试详情：侧车、路径、后端细项。 */
  getModelStatus(): Promise<ModelStatusResponse>;
  /** 环境是否可正常使用（单一判定来源）。 */
  getEnvironmentStatus(): Promise<EnvironmentStatus>;
  isAppEnvironmentReady(): Promise<boolean>;
  onSidecarLoadProgress(callback: (message: string) => void): Promise<UnlistenFn>;
};

export function createModelClient(): ModelClient {
  return {
    async askImage(request, onChunk) {
      let unlisten: UnlistenFn | undefined;
      try {
        unlisten = await listen<StreamChunk>("model-stream", (event) => {
          onChunk(event.payload);
        });
        await invoke("ask_image", {
          imageDataUrl: request.imageDataUrl,
          ocrText: request.ocrText,
          prompt: request.prompt,
          history: request.history,
        });
      } finally {
        unlisten?.();
      }
    },

    async cancelGeneration() {
      await invoke("cancel_generation");
    },

    async warmupModel() {
      await invoke("warmup_model");
    },

    async unloadWhenIdle() {
      await invoke("unload_model_if_idle");
    },

    async getModelStatus() {
      return invoke<ModelStatusResponse>("get_model_status");
    },

    async getEnvironmentStatus() {
      return invoke<EnvironmentStatus>("get_environment_status");
    },

    async isAppEnvironmentReady() {
      return invoke<boolean>("is_app_environment_ready");
    },

    async onSidecarLoadProgress(callback) {
      return listen<{ message: string }>("sidecar-load-progress", (event) => {
        callback(event.payload.message);
      });
    },
  };
}

/** 单例，供 chat hook、设置页等复用。 */
export const modelClient = createModelClient();
