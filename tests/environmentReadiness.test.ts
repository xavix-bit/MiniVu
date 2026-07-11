import { describe, expect, it } from "vitest";
import { environmentReadinessPercent } from "../src/model/types";
import type { EnvironmentStatus } from "../src/model/types";

function env(partial: Partial<EnvironmentStatus>): EnvironmentStatus {
  return {
    onboardingComplete: false,
    inferenceBackend: "mlx",
    runtimeReady: false,
    modelReady: false,
    environmentReady: false,
    ...partial,
  };
}

describe("environmentReadinessPercent", () => {
  it("returns 100 when environment is fully ready", () => {
    expect(
      environmentReadinessPercent(
        env({ onboardingComplete: true, runtimeReady: true, modelReady: true, environmentReady: true }),
      ),
    ).toBe(100);
  });

  it("counts runtime and model readiness without onboarding", () => {
    expect(environmentReadinessPercent(env({ runtimeReady: true, modelReady: false }))).toBe(50);
    expect(environmentReadinessPercent(env({ runtimeReady: false, modelReady: true }))).toBe(50);
    expect(environmentReadinessPercent(env({ runtimeReady: false, modelReady: false }))).toBe(0);
  });
});
