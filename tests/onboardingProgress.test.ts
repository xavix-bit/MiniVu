import { describe, expect, it } from "vitest";
import {
  computeOverallPercent,
  createInitialDownloadBytes,
  createInitialProgress,
  mergeDownloadBytes,
  mergeProgress,
} from "../src/app-shell/onboardingProgress";

describe("onboardingProgress", () => {
  it("uses combined byte progress for model downloads", () => {
    const progress = mergeProgress(createInitialProgress(), {
      phase: "runtime",
      status: "done",
      message: "完成",
      percent: 100,
    });

    const bytes = mergeDownloadBytes(
      mergeDownloadBytes(createInitialDownloadBytes(), "model", 500, 1000),
      "mmproj",
      250,
      500,
    );

    const overall = computeOverallPercent(progress, bytes);
    expect(overall).toBe(50);
  });

  it("keeps progress monotonic when a phase is already done", () => {
    const current = mergeProgress(createInitialProgress(), {
      phase: "model",
      status: "done",
      message: "完成",
      percent: 100,
    });

    const next = mergeProgress(current, {
      phase: "model",
      status: "running",
      message: "回退",
      percent: 10,
    });

    expect(next.model.status).toBe("done");
    expect(next.model.percent).toBe(100);
  });
});
