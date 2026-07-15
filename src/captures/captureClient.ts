import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CaptureClient,
  CaptureRecord,
  CaptureRecordChanged,
  CaptureRecordPatch,
  CreateCaptureInput,
} from "./types";

export const captureClient: CaptureClient = {
  list(query, pinnedOnly) {
    return invoke<CaptureRecord[]>("list_capture_records", {
      query: query?.trim() || null,
      pinnedOnly: pinnedOnly ?? false,
    });
  },

  get(id) {
    return invoke<CaptureRecord | null>("get_capture_record", { id });
  },

  readImage(id, thumbnail) {
    return invoke<string>("read_capture_image", { id, thumbnail });
  },

  create(input: CreateCaptureInput) {
    return invoke<CaptureRecord>("create_capture_record", {
      input: {
        imageDataUrl: input.dataUrl,
        source: input.source,
        retention: input.retention ?? "24h",
      },
    });
  },

  update(id: string, patch: CaptureRecordPatch) {
    return invoke<CaptureRecord | null>("update_capture_record", { id, patch });
  },

  async remove(id) {
    await invoke("delete_capture_record", { id });
  },

  cleanup() {
    return invoke<number>("cleanup_capture_records");
  },

  subscribe(callback) {
    return listen<CaptureRecordChanged>("capture-record-changed", (event) => {
      callback(event.payload);
    });
  },
};
