import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import type { CaptureRecord } from "../captures/types";

type CaptureCanvasProps = {
  record: CaptureRecord;
};

export function CaptureCanvas({ record }: CaptureCanvasProps) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [record.id]);

  function setClampedZoom(next: number) {
    setZoom(Math.min(4, Math.max(0.4, next)));
  }

  function reset() {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }

  return (
    <section className="capture-canvas" aria-label="截图预览">
      <div className="capture-canvas__toolbar" aria-label="缩放工具">
        <button type="button" title="缩小" aria-label="缩小" onClick={() => setClampedZoom(zoom - 0.2)}>
          <Minus size={16} />
        </button>
        <button type="button" className="capture-canvas__zoom" title="恢复 100%" onClick={reset}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" title="放大" aria-label="放大" onClick={() => setClampedZoom(zoom + 0.2)}>
          <Plus size={16} />
        </button>
        <span />
        <button type="button" title="适合窗口" aria-label="适合窗口" onClick={reset}>
          <Maximize2 size={16} />
        </button>
        <button type="button" title="重置视图" aria-label="重置视图" onClick={reset}>
          <RotateCcw size={15} />
        </button>
      </div>
      <div
        className="capture-canvas__stage"
        onWheel={(event) => {
          event.preventDefault();
          setClampedZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1));
        }}
        onPointerDown={(event) => {
          if (event.button === 0) {
            dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          const start = dragRef.current;
          if (start) {
            setOffset({ x: start.ox + event.clientX - start.x, y: start.oy + event.clientY - start.y });
          }
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        {record.imageDataUrl ? (
          <img
            src={record.imageDataUrl}
            alt={record.title || "截图"}
            draggable={false}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          />
        ) : (
          <div className="capture-canvas__loading">正在载入截图</div>
        )}
      </div>
    </section>
  );
}
