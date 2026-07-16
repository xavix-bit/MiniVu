import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import appIconUrl from "../../app-icon.png";
import { startWindowDrag } from "../window/panelChrome";
import { ChatPanel } from "../chat/ChatPanel";
import { PanelChrome } from "../window/panelChrome";
import { ClipboardPaste, History, ScanLine } from "lucide-react";
import { CaptureError, captureScreenRegion } from "../image/captureScreen";
import { readClipboardImage } from "../image/imageIntake";
import { captureClient } from "../captures/captureClient";
import type { AcceptedImage } from "../image/imageInput";
import type { CaptureSource } from "../captures/types";
import { loadSettings } from "../settings/settingsStore";
import { modelClient } from "../model/modelClient";

type PanelMode = "expanded" | "launcher" | "pet" | "hidden";

const PET_DRAG_THRESHOLD_PX = 4;

export function QuickLauncher({
  onCapture,
  onPaste,
  onRecent,
}: {
  onCapture: () => void;
  onPaste: () => void;
  onRecent: () => void;
}) {
  return (
    <div className="quick-launcher" aria-label="快捷操作">
      <button type="button" onClick={onCapture}>
        <ScanLine size={19} aria-hidden="true" />
        <span>截图</span>
      </button>
      <button type="button" onClick={onPaste}>
        <ClipboardPaste size={18} aria-hidden="true" />
        <span>粘贴</span>
      </button>
      <button type="button" onClick={onRecent}>
        <History size={18} aria-hidden="true" />
        <span>最近</span>
      </button>
    </div>
  );
}

export function QuickPanelShell() {
  const [mode, setMode] = useState<PanelMode>("expanded");
  const [activeCapture, setActiveCapture] = useState<{
    recordId: string;
    image: AcceptedImage;
  } | null>(null);
  const petDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressPetClickRef = useRef(false);

  useLayoutEffect(() => {
    document.documentElement.classList.add("quick-panel-window");
    document.documentElement.dataset.panelMode = mode;
    return () => {
      document.documentElement.classList.remove("quick-panel-window");
      delete document.documentElement.dataset.panelMode;
    };
  }, [mode]);

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
    void invoke("show_quick_launcher_command");
  }

  const showResult = useCallback(async (image: AcceptedImage, source: CaptureSource) => {
    const settings = await loadSettings();
    const record = await captureClient.create({
      dataUrl: image.dataUrl,
      source,
      retention: settings.captureRetention ?? "24h",
    });
    setActiveCapture({ recordId: record.id, image });
    await invoke("expand_quick_panel_command");
  }, []);

  const handleCapture = useCallback(async () => {
    try {
      const image = await captureScreenRegion();
      await showResult(image, "capture");
    } catch (error) {
      if (error instanceof CaptureError && error.code === "cancelled") return;
      console.warn("截图失败");
    }
  }, [showResult]);

  const handlePaste = useCallback(async () => {
    const image = await readClipboardImage();
    if (image) {
      await showResult(image, "paste");
    }
  }, [showResult]);

  const handleRequireModel = useCallback(async (prompt: string) => {
    if (!activeCapture) return false;
    const status = await modelClient.getEnvironmentStatus().catch(() => null);
    if (status?.modelReady) return true;

    await emitTo("main", "model-required", {
      recordId: activeCapture.recordId,
      prompt,
    });
    await invoke("show_main");
    return false;
  }, [activeCapture]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let active = true;

    async function consumeCaptureRequest() {
      const pending = await invoke<boolean>("take_pending_capture_request");
      if (active && pending) {
        await handleCapture();
      }
    }

    void listen<PanelMode>("quick-panel-mode", (event) => {
      setMode(event.payload);
    }).then((cleanup) => {
      if (active) unlisteners.push(cleanup);
      else cleanup();
    });

    void listen("capture-requested", () => {
      void consumeCaptureRequest();
    }).then((cleanup) => {
      if (active) {
        unlisteners.push(cleanup);
        void consumeCaptureRequest();
      } else {
        cleanup();
      }
    });

    return () => {
      active = false;
      for (const cleanup of unlisteners) cleanup();
    };
  }, [handleCapture]);

  useEffect(() => {
    if (mode !== "launcher") return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") void invoke("close_quick_panel_command");
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [mode]);

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

  if (mode === "launcher") {
    return (
      <main className="quick-panel-shell quick-panel-shell--launcher">
        <QuickLauncher
          onCapture={() => void handleCapture()}
          onPaste={() => void handlePaste()}
          onRecent={() => void invoke("show_main")}
        />
      </main>
    );
  }

  return (
    <main className="quick-panel-shell">
      <PanelChrome>
        <ChatPanel
          initialImage={activeCapture?.image ?? null}
          recordId={activeCapture?.recordId ?? null}
          onImageInput={showResult}
          onRequireModel={handleRequireModel}
          onCollapse={() => void invoke("close_quick_panel_command")}
        />
      </PanelChrome>
    </main>
  );
}
