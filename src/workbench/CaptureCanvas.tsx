import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { CaptureRecord } from "../captures/types";
import {
  clampZoom,
  fitViewport,
  oneToOneViewport,
  type CanvasViewport,
} from "./canvasViewport";

type CaptureCanvasProps = {
  record: CaptureRecord;
};

export function CaptureCanvas({ record }: CaptureCanvasProps) {
  const [viewport, setViewport] = useState<CanvasViewport>(oneToOneViewport);
  const [isAutoFit, setIsAutoFit] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const autoFitRef = useRef(true);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);

  function setAutoFit(enabled: boolean) {
    autoFitRef.current = enabled;
    setIsAutoFit(enabled);
  }

  function applyFit() {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image || image.naturalWidth === 0 || image.naturalHeight === 0) return;
    if (stage.clientWidth === 0 || stage.clientHeight === 0) return;

    setViewport(fitViewport(
      { width: image.naturalWidth, height: image.naturalHeight },
      { width: stage.clientWidth, height: stage.clientHeight },
    ));
  }

  function fitImage() {
    setAutoFit(true);
    applyFit();
  }

  function adjustZoom(delta: number) {
    setAutoFit(false);
    setViewport((current) => ({
      ...current,
      zoom: clampZoom(current.zoom + delta),
    }));
  }

  function showActualSize() {
    setAutoFit(false);
    setViewport(oneToOneViewport());
  }

  useEffect(() => {
    dragRef.current = null;
    setAutoFit(true);
    applyFit();
  }, [record.id]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (autoFitRef.current) applyFit();
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="capture-canvas" aria-label="截图预览">
      <div className="capture-canvas__toolbar" aria-label="缩放工具">
        <button type="button" title="缩小" aria-label="缩小" onClick={() => adjustZoom(-0.2)}>
          <Minus size={16} />
        </button>
        <output className="capture-canvas__zoom" aria-label="当前缩放比例">
          {Math.round(viewport.zoom * 100)}%
        </output>
        <button type="button" title="放大" aria-label="放大" onClick={() => adjustZoom(0.2)}>
          <Plus size={16} />
        </button>
        <span className="capture-canvas__toolbar-gap" aria-hidden="true" />
        <button
          type="button"
          className={isAutoFit ? "is-active" : undefined}
          title="适合窗口"
          aria-label="适合窗口"
          aria-pressed={isAutoFit}
          onClick={fitImage}
        >
          <Maximize2 size={16} />
        </button>
        <button
          type="button"
          className="capture-canvas__actual"
          title="原始大小"
          aria-label="原始大小"
          onClick={showActualSize}
        >
          1:1
        </button>
      </div>
      <div
        ref={stageRef}
        className="capture-canvas__stage"
        onWheel={(event) => {
          event.preventDefault();
          adjustZoom(event.deltaY < 0 ? 0.1 : -0.1);
        }}
        onPointerDown={(event) => {
          if (event.button === 0 && !dragRef.current) {
            dragRef.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              ox: viewport.offset.x,
              oy: viewport.offset.y,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          const start = dragRef.current;
          if (start && event.pointerId === start.pointerId) {
            setAutoFit(false);
            setViewport((current) => ({
              ...current,
              offset: {
                x: start.ox + event.clientX - start.x,
                y: start.oy + event.clientY - start.y,
              },
            }));
          }
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
      >
        {record.imageDataUrl ? (
          <img
            ref={imageRef}
            key={record.id}
            src={record.imageDataUrl}
            alt={record.title || "截图"}
            draggable={false}
            onLoad={fitImage}
            style={{
              transform: `translate(${viewport.offset.x}px, ${viewport.offset.y}px) scale(${viewport.zoom})`,
            }}
          />
        ) : (
          <div className="capture-canvas__loading">正在载入截图</div>
        )}
      </div>
    </section>
  );
}
