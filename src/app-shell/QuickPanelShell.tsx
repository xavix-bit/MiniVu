import { useEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import appIconUrl from "../../app-icon.png";
import { startWindowDrag } from "../window/panelChrome";
import { ChatPanel } from "../chat/ChatPanel";
import { PanelChrome } from "../window/panelChrome";

type PanelMode = "expanded" | "pet" | "hidden";

const PET_DRAG_THRESHOLD_PX = 4;

export function QuickPanelShell() {
  const [mode, setMode] = useState<PanelMode>("expanded");
  const petDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressPetClickRef = useRef(false);

  useEffect(() => {
    document.documentElement.classList.add("quick-panel-window");
    document.documentElement.dataset.panelMode = mode;
    return () => {
      document.documentElement.classList.remove("quick-panel-window");
      delete document.documentElement.dataset.panelMode;
    };
  }, [mode]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    void listen<PanelMode>("quick-panel-mode", (event) => {
      setMode(event.payload);
    }).then((cleanup) => unlisteners.push(cleanup));

    return () => {
      for (const cleanup of unlisteners) {
        cleanup();
      }
    };
  }, []);

  function handlePetPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }
    petDragStartRef.current = { x: event.clientX, y: event.clientY };
    suppressPetClickRef.current = false;
  }

  function handlePetPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = petDragStartRef.current;
    if (!start || event.buttons !== 1 || suppressPetClickRef.current) {
      return;
    }
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.hypot(deltaX, deltaY) < PET_DRAG_THRESHOLD_PX) {
      return;
    }
    suppressPetClickRef.current = true;
    startWindowDrag(event, { allowInteractiveTarget: true });
  }

  function handlePetPointerEnd() {
    petDragStartRef.current = null;
    window.setTimeout(() => {
      suppressPetClickRef.current = false;
    }, 250);
  }

  function handlePetClick(event: ReactMouseEvent<HTMLButtonElement>) {
    if (suppressPetClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      window.setTimeout(() => {
        suppressPetClickRef.current = false;
      }, 250);
      return;
    }
    void invoke("expand_quick_panel_command");
  }

  if (mode === "pet") {
    return (
      <main className="quick-panel-shell quick-panel-shell--pet">
        <button
          type="button"
          className="pet-bubble"
          aria-label="展开 MiniVu"
          title="点击展开"
          onPointerDown={handlePetPointerDown}
          onPointerMove={handlePetPointerMove}
          onPointerUp={handlePetPointerEnd}
          onPointerCancel={handlePetPointerEnd}
          onClick={handlePetClick}
        >
          <img src={appIconUrl} alt="" className="pet-bubble__icon" width={44} height={44} />
        </button>
      </main>
    );
  }

  return (
    <main className="quick-panel-shell">
      <PanelChrome>
        <ChatPanel onCollapse={() => void invoke("close_quick_panel_command")} />
      </PanelChrome>
    </main>
  );
}
