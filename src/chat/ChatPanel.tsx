import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Composer } from "./Composer";
import { ImagePreviewStrip } from "./ImagePreviewStrip";
import { ModelStatusBar } from "./ModelStatusBar";
import { PanelHeader } from "./PanelHeader";
import { QuickActions } from "./QuickActions";
import { RecognizedTextPanel } from "./RecognizedTextPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { useImageSession } from "./useImageSessionHook";
import { exportCurrentSession } from "../export/exportSession";
import { captureScreenRegion } from "../image/captureScreen";
import {
  filterAcceptedFiles,
  readClipboardImage,
  readFileAsDataUrl,
} from "../image/imageIntake";

export function ChatPanel() {
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [loadProgress, setLoadProgress] = useState("");
  const [inferenceBackend, setInferenceBackend] = useState<"llama" | "mlx">("mlx");
  const [elapsed, setElapsed] = useState(0);
  const {
    state,
    streamingText,
    isAnswering,
    modelLoading,
    inferPhase,
    ocrLoading,
    error,
    clearError,
    setImage,
    ask,
    stopGeneration,
    clearConversation,
  } = useImageSession();
  const dropRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasConversation = state.messages.length > 0 || Boolean(streamingText);
  const showQuickActions = Boolean(state.image) && !hasConversation;
  const waitingForModel = modelLoading && !streamingText && inferPhase === "loading";
  const statusMessage =
    loadProgress ||
    (streamingText
      ? "正在生成回答…"
      : inferPhase === "thinking"
        ? "正在理解图片并思考…"
        : inferenceBackend === "mlx"
          ? "正在准备 MLX 模型…"
          : "正在加载模型到内存…");
  const banner = error || notice;

  useEffect(() => {
    void invoke<{ inferenceBackend: "llama" | "mlx" }>("get_model_status").then((status) => {
      setInferenceBackend(status.inferenceBackend ?? "mlx");
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ message: string }>("sidecar-load-progress", (event) => {
        setLoadProgress(event.payload.message);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!waitingForModel) {
      setElapsed(0);
      setLoadProgress("");
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waitingForModel]);

  useEffect(() => {
    function handlePaste(event: ClipboardEvent) {
      const items = event.clipboardData?.items;
      if (!items) {
        return;
      }
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          event.preventDefault();
          const file = item.getAsFile();
          if (file) {
            void readFileAsDataUrl(file).then((image) => void setImage(image));
          }
          return;
        }
      }
      void readClipboardImage().then((image) => {
        if (image) {
          void setImage(image);
        }
      });
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [setImage]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        void invoke("close_quick_panel_command");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const element = dropRef.current;
    if (!element) {
      return;
    }

    function handleDragOver(event: DragEvent) {
      event.preventDefault();
    }

    function handleDrop(event: DragEvent) {
      event.preventDefault();
      const files = filterAcceptedFiles(event.dataTransfer?.files ?? []);
      const file = files[0];
      if (file) {
        void readFileAsDataUrl(file).then((image) => void setImage(image));
      }
    }

    element.addEventListener("dragover", handleDragOver);
    element.addEventListener("drop", handleDrop);
    return () => {
      element.removeEventListener("dragover", handleDragOver);
      element.removeEventListener("drop", handleDrop);
    };
  }, [setImage]);

  async function handleExport() {
    try {
      const path = await exportCurrentSession(state);
      if (path) {
        setNotice(`已导出到：${path}`);
      }
    } catch (err) {
      setNotice(`导出失败：${String(err)}`);
    }
  }

  async function handleOpenSettings() {
    await invoke("show_main");
  }

  async function handleClose() {
    await invoke("close_quick_panel_command");
  }

  function submit() {
    const prompt = input.trim();
    if (!prompt || isAnswering) {
      return;
    }
    setInput("");
    setNotice("");
    void ask(prompt);
  }

  function handleQuickAction(prompt: string) {
    if (isAnswering) {
      return;
    }
    setNotice("");
    void ask(prompt);
  }

  function triggerReplaceImage() {
    fileInputRef.current?.click();
  }

  async function handleCaptureScreen() {
    if (isAnswering || capturing) {
      return;
    }
    setCapturing(true);
    setNotice("");
    clearError();
    try {
      const image = await captureScreenRegion();
      await setImage(image);
    } catch (err) {
      const message = String(err);
      if (!message.includes("已取消截图")) {
        setNotice(message);
      }
    } finally {
      setCapturing(false);
    }
  }

  function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void readFileAsDataUrl(file).then((image) => void setImage(image));
    }
    event.target.value = "";
  }

  return (
    <section
      className={`chat-panel${hasConversation ? " chat-panel--active" : ""}`}
      aria-label="本地图片问答"
    >
      <PanelHeader
        onExport={() => void handleExport()}
        onOpenSettings={() => void handleOpenSettings()}
        onClose={() => void handleClose()}
      />

      <ModelStatusBar
        visible={modelLoading}
        message={statusMessage}
        detail={
          waitingForModel
            ? inferenceBackend === "mlx"
              ? `已等待 ${elapsed}s · 首次需下载约 2GB 并载入内存，请保持联网`
              : `已等待 ${elapsed}s · 仅首次约 30–90s`
            : inferPhase === "thinking" && !streamingText
              ? "模型已在内存，视觉推理需要几秒"
              : undefined
        }
      />

      {banner ? (
        <div
          className={`chat-banner${error ? " chat-banner--error" : ""}`}
          role="status"
        >
          <span>{banner}</span>
          <button
            type="button"
            className="chat-banner__close"
            onClick={() => {
              clearError();
              setNotice("");
            }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={handleFilePicked}
      />

      <div className="chat-panel__body">
        {!state.image ? (
          <div ref={dropRef} className="drop-zone">
            <span className="drop-zone__icon" aria-hidden="true" />
            <strong>添加一张图片开始</strong>
            <button
              type="button"
              className="drop-zone__capture"
              disabled={capturing || isAnswering}
              onClick={() => void handleCaptureScreen()}
            >
              {capturing ? "请在屏幕上框选区域…" : "框选截图"}
            </button>
            <span className="drop-zone__hint">或粘贴截图 · 拖入文件 · ⌘V</span>
            <span className="drop-zone__step">1. 截图/添加图片 → 2. 输入问题 → 3. 本地回答</span>
          </div>
        ) : (
          <>
            {hasConversation ? (
              <TranscriptPanel messages={state.messages} streamingText={streamingText} />
            ) : null}

            <div ref={dropRef} className="chat-panel__meta">
              <div className="chat-panel__image-row">
                <ImagePreviewStrip
                  dataUrl={state.image.dataUrl}
                  name={state.image.name}
                  compact={hasConversation}
                />
                <div className="chat-panel__image-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={capturing || isAnswering}
                    onClick={() => void handleCaptureScreen()}
                  >
                    {capturing ? "截图中…" : "截图"}
                  </button>
                  <button type="button" className="ghost-btn" onClick={triggerReplaceImage}>
                    换图
                  </button>
                  {hasConversation ? (
                    <button type="button" className="ghost-btn" onClick={clearConversation}>
                      清空对话
                    </button>
                  ) : null}
                </div>
              </div>
              {showQuickActions ? <QuickActions onSelect={handleQuickAction} /> : null}
              {!hasConversation && state.ocrText ? (
                <RecognizedTextPanel text={state.ocrText} loading={ocrLoading} />
              ) : null}
              {!hasConversation ? (
                <TranscriptPanel messages={state.messages} streamingText={streamingText} />
              ) : null}
            </div>

            {hasConversation && (state.ocrText || ocrLoading) ? (
              <RecognizedTextPanel text={state.ocrText} loading={ocrLoading} compact />
            ) : null}
          </>
        )}
      </div>

      <Composer
        value={input}
        disabled={!state.image}
        isAnswering={isAnswering}
        canSubmit={Boolean(state.image)}
        onChange={setInput}
        onSubmit={submit}
        onStop={() => void stopGeneration()}
      />
    </section>
  );
}
