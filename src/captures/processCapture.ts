import { invoke } from "@tauri-apps/api/core";
import { modelClient } from "../model/modelClient";
import { captureClient } from "./captureClient";

type ProcessCaptureOptions = {
  warmup?: boolean;
};

export function processCaptureInBackground(
  recordId: string,
  dataUrl: string,
  options: ProcessCaptureOptions = {},
) {
  const ocrRequest = invoke<{ text: string }>("recognize_text_from_image_data_url", { dataUrl });
  if (options.warmup) {
    queueMicrotask(() => {
      void modelClient.warmupModel().catch(() => {});
    });
  }
  void ocrRequest.then(
    (result) => captureClient.update(recordId, {
      ocrText: result.text,
      ocrState: "ready",
    }),
    () => captureClient.update(recordId, { ocrState: "failed" }),
  ).catch(() => {});
}
