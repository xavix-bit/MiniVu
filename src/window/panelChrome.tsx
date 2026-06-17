import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export function startWindowDrag(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0) {
    return;
  }
  if ((event.target as HTMLElement).closest("button, a, input, textarea, select, label")) {
    return;
  }
  event.preventDefault();
  void getCurrentWindow().startDragging();
}

export function startWindowResize(
  direction: ResizeDirection,
  event: ReactPointerEvent<HTMLElement>,
) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void getCurrentWindow().startResizeDragging(direction);
}

type HandleSpec = {
  direction: ResizeDirection;
  className: string;
};

const RESIZE_HANDLES: HandleSpec[] = [
  { direction: "NorthWest", className: "panel-chrome__resize--nw" },
  { direction: "North", className: "panel-chrome__resize--n" },
  { direction: "NorthEast", className: "panel-chrome__resize--ne" },
  { direction: "West", className: "panel-chrome__resize--w" },
  { direction: "East", className: "panel-chrome__resize--e" },
  { direction: "SouthWest", className: "panel-chrome__resize--sw" },
  { direction: "South", className: "panel-chrome__resize--s" },
  { direction: "SouthEast", className: "panel-chrome__resize--se" },
];

type PanelChromeProps = {
  children: ReactNode;
};

export function PanelChrome({ children }: PanelChromeProps) {
  return (
    <div className="panel-chrome">
      <div
        className="panel-chrome__drag-rail panel-chrome__drag-rail--left"
        aria-hidden="true"
        onPointerDown={startWindowDrag}
      />
      <div
        className="panel-chrome__drag-rail panel-chrome__drag-rail--right"
        aria-hidden="true"
        onPointerDown={startWindowDrag}
      />
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.direction}
          className={`panel-chrome__resize ${handle.className}`}
          aria-hidden="true"
          onPointerDown={(event) => startWindowResize(handle.direction, event)}
        />
      ))}
      {children}
    </div>
  );
}
