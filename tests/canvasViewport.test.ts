import { describe, expect, it } from "vitest";
import { clampZoom, fitViewport, oneToOneViewport } from "../src/workbench/canvasViewport";

describe("canvas viewport", () => {
  it("fits a landscape image inside the stage inset", () => {
    expect(fitViewport(
      { width: 1600, height: 900 },
      { width: 800, height: 600 },
    )).toEqual({ zoom: 0.46, offset: { x: 0, y: 0 } });
  });

  it("fits a portrait image inside the stage inset", () => {
    expect(fitViewport(
      { width: 600, height: 1200 },
      { width: 900, height: 700 },
    )).toEqual({ zoom: 0.53, offset: { x: 0, y: 0 } });
  });

  it("clamps zoom at the supported bounds", () => {
    expect(clampZoom(0.1)).toBe(0.4);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(8)).toBe(4);
  });

  it("clamps fitted zoom at the supported bounds", () => {
    expect(fitViewport(
      { width: 1000, height: 1000 },
      { width: 100, height: 100 },
      0,
    ).zoom).toBe(0.4);
    expect(fitViewport(
      { width: 100, height: 100 },
      { width: 1000, height: 1000 },
      0,
    ).zoom).toBe(4);
  });

  it("returns a centered one-to-one viewport", () => {
    expect(oneToOneViewport()).toEqual({ zoom: 1, offset: { x: 0, y: 0 } });
  });
});
