import { describe, expect, it } from "vitest";
import { resolveGgufPercent, resolveMlxPercent } from "../src/shared/downloadProgress";
import {
  GGUF_MODEL_VARIANTS,
  EXPECTED_MLX_BYTES,
} from "../src/shared/modelConstants";

describe("downloadProgress", () => {
  it("exposes the supported MiniCPM-V 4.6 GGUF variants", () => {
    expect(Object.keys(GGUF_MODEL_VARIANTS)).toEqual(["q4_k_m", "q5_k_m", "q6_k"]);
  });

  it("keeps GGUF percent monotonic", () => {
    const expectedModelBytes = GGUF_MODEL_VARIANTS.q4_k_m.modelBytes;
    expect(resolveGgufPercent(0, expectedModelBytes * 0.1, null, "model")).toBe(10);
    expect(resolveGgufPercent(10, expectedModelBytes * 0.05, null, "model")).toBe(10);
    expect(resolveGgufPercent(10, expectedModelBytes * 0.5, null, "model")).toBe(50);
  });

  it("keeps MLX percent monotonic", () => {
    expect(resolveMlxPercent(0, EXPECTED_MLX_BYTES * 0.25)).toBe(25);
    expect(resolveMlxPercent(25, EXPECTED_MLX_BYTES * 0.1)).toBe(25);
    expect(resolveMlxPercent(25, EXPECTED_MLX_BYTES * 0.75)).toBe(75);
  });
});
