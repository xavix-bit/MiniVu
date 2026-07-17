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
  notice,
}: {
  onCapture: () => void;
  onPaste: () => void;
  onRecent: () => void;
  notice?: string | null;
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
      {notice ? (
        <div className="quick-launcher__notice" role="status" aria-live="polite">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

export function QuickPanelShell() {
  const [mode, setMode] = useState<PanelMode>("hidden");
  const [notice, setNotice] = useState<string | null>(null);
  const [activeCapture, setActiveCapture] = useState<{
    recordId: string;
    image: AcceptedImage;
  } | null>(null);
  const petDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressPetClickRef = useRef(false);
  const mountedRef = useRef(false);
  const modeRef = useRef<PanelMode>(mode);
  const pasteRequestIdRef = useRef(0);

  const invalidatePasteRequest = useCallback(() => {
    pasteRequestIdRef.current += 1;
    if (mountedRef.current) setNotice(null);
  }, []);

  const isCurrentPaste = useCallback((requestId: number) => (
    mountedRef.current &&
    modeRef.current === "launcher" &&
    pasteRequestIdRef.current === requestId
  ), []);

  const applyPanelMode = useCallback((nextMode: PanelMode) => {
    modeRef.current = nextMode;
    setMode(nextMode);
    invalidatePasteRequest();
  }, [invalidatePasteRequest]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pasteRequestIdRef.current += 1;
    };
  }, []);

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

  const showResult = useCallback(async (
    image: AcceptedImage,
    source: CaptureSource,
    isCurrent: () => boolean = () => true,
  ) => {
    if (!isCurrent()) return;
    const settings = await loadSettings();
    if (!isCurrent()) return;
    const record = await captureClient.create({
      dataUrl: image.dataUrl,
      source,
      retention: settings.captureRetention ?? "24h",
    });
    if (!isCurrent()) {
      await captureClient.remove(record.id).catch(() => undefined);
      return;
    }
    setActiveCapture({ recordId: record.id, image });
    setNotice(null);
    if (!isCurrent()) return;
    await invoke("expand_quick_panel_command");
  }, []);

  const handleCapture = useCallback(async () => {
    invalidatePasteRequest();
    try {
      const image = await captureScreenRegion();
      await showResult(image, "capture");
    } catch (error) {
      if (error instanceof CaptureError && error.code === "cancelled") return;
      const code = error instanceof CaptureError ? error.code : "unknown";
      try {
        await emitTo("main", "capture-recovery", { code });
        await invoke("show_main");
      } catch {
        console.warn("无法打开截图恢复页面");
      }
    }
  }, [invalidatePasteRequest, showResult]);

  const handlePaste = useCallback(async () => {
    invalidatePasteRequest();
    const requestId = pasteRequestIdRef.current;
    try {
      const image = await readClipboardImage();
      if (!isCurrentPaste(requestId)) return;
      if (image) {
        await showResult(image, "paste", () => isCurrentPaste(requestId));
        return;
      }
      if (isCurrentPaste(requestId)) setNotice("剪贴板里没有图片");
    } catch {
      if (isCurrentPaste(requestId)) setNotice("无法读取剪贴板");
    }
  }, [invalidatePasteRequest, isCurrentPaste, showResult]);

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
    let modeRevision = 0;

    async function consumeCaptureRequest() {
      const pending = await invoke<boolean>("take_pending_capture_request");
      if (active && pending) {
        await handleCapture();
      }
    }

    async function subscribeToPanelMode() {
      const cleanup = await listen<PanelMode>("quick-panel-mode", (event) => {
        modeRevision += 1;
        applyPanelMode(event.payload);
      });
      if (!active) {
        cleanup();
        return;
      }
      unlisteners.push(cleanup);

      const revisionAtRequest = modeRevision;
      try {
        const currentMode = await invoke<PanelMode>("get_quick_panel_mode");
        if (active && modeRevision === revisionAtRequest) {
          applyPanelMode(currentMode);
        }
      } catch {
        // The native window starts hidden, so a failed snapshot is safe to leave blank.
      }
    }

    void subscribeToPanelMode();

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
  }, [applyPanelMode, handleCapture]);

  useEffect(() => {
    if (mode !== "launcher") return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        invalidatePasteRequest();
        void invoke("close_quick_panel_command");
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [invalidatePasteRequest, mode]);

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
          onRecent={() => {
            invalidatePasteRequest();
            void invoke("show_main");
          }}
          notice={notice}
        />
      </main>
    );
  }

  if (mode === "hidden") {
    return null;
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
