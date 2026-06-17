import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ModelStatusResponse } from "./types";

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
  unloadWhenIdle(): Promise<void>;
  getModelStatus(): Promise<ModelStatusResponse>;
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

    async unloadWhenIdle() {
      await invoke("unload_model_if_idle");
    },

    async getModelStatus() {
      return invoke<ModelStatusResponse>("get_model_status");
    },
  };
}

/** 单例，供 chat hook 等复用。 */
export const modelClient = createModelClient();
