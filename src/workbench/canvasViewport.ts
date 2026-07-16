export type CanvasSize = {
  width: number;
  height: number;
};

export type CanvasViewport = {
  zoom: number;
  offset: { x: number; y: number };
};

export function clampZoom(zoom: number): number {
  return Math.min(4, Math.max(0.4, zoom));
}

export function fitViewport(image: CanvasSize, stage: CanvasSize, inset = 32): CanvasViewport {
  return {
    zoom: clampZoom(Math.min(
      (stage.width - 2 * inset) / image.width,
      (stage.height - 2 * inset) / image.height,
    )),
    offset: { x: 0, y: 0 },
  };
}

export function oneToOneViewport(): CanvasViewport {
  return { zoom: 1, offset: { x: 0, y: 0 } };
}
