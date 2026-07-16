import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureClient } from "../src/captures/captureClient";
import { processCaptureInBackground } from "../src/captures/processCapture";
import { modelClient } from "../src/model/modelClient";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/model/modelClient", () => ({
  modelClient: { warmupModel: vi.fn() },
}));
vi.mock("../src/captures/captureClient", () => ({
  captureClient: { update: vi.fn() },
}));

describe("processCaptureInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(captureClient.update).mockResolvedValue(null);
    vi.mocked(modelClient.warmupModel).mockResolvedValue(undefined);
  });

  it("keeps the record, marks failed OCR, and does not warm the model by default", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("OCR unavailable"));

    processCaptureInBackground("record-a", "data:image/png;base64,A");

    await vi.waitFor(() => {
      expect(captureClient.update).toHaveBeenCalledWith("record-a", { ocrState: "failed" });
    });
    expect(modelClient.warmupModel).not.toHaveBeenCalled();
  });

  it("warms the model only when the caller explicitly opts in", async () => {
    vi.mocked(invoke).mockResolvedValue({ text: "recognized" });

    processCaptureInBackground("record-a", "data:image/png;base64,A", { warmup: true });

    await vi.waitFor(() => {
      expect(captureClient.update).toHaveBeenCalledWith("record-a", {
        ocrText: "recognized",
        ocrState: "ready",
      });
      expect(modelClient.warmupModel).toHaveBeenCalledOnce();
    });
  });
});
