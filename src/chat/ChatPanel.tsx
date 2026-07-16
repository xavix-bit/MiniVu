import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ImagePlus } from "lucide-react";
import { Composer } from "./Composer";
import { ImagePreviewStrip } from "./ImagePreviewStrip";
import { ModelStatusBar } from "./ModelStatusBar";
import { PanelHeader } from "./PanelHeader";
import { QuickActions } from "./QuickActions";
import { RecognizedTextPanel } from "./RecognizedTextPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { useImageSession, type ChatMessage } from "./useImageSession";
import { exportCurrentSession } from "../export/exportSession";
import { CaptureError, captureScreenRegion } from "../image/captureScreen";
import {
  filterAcceptedFiles,
  readClipboardImage,
  readFileAsDataUrl,
} from "../image/imageIntake";
import { loadSettings } from "../settings/settingsStore";
import type { AcceptedImage } from "../image/imageInput";
import { captureClient } from "../captures/captureClient";
import type { CaptureSource } from "../captures/types";

function formatShortcut(raw: string): string {
  return raw
    .split("+")
    .map((part) => {
      switch (part) {
        case "Control":
          return "⌃";
        case "Option":
        case "Alt":
          return "⌥";
        case "Command":
        case "Cmd":
        case "Super":
          return "⌘";
        case "Shift":
          return "⇧";
        case "Space":
          return "Space";
        default:
          return part;
      }
    })
    .join("");
}

const messageSaveQueues = new Map<string, Promise<void>>();

function enqueueMessageSave(recordId: string, messages: ChatMessage[]) {
  const previous = messageSaveQueues.get(recordId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await captureClient.update(recordId, { messages });
    })
    .catch(() => undefined);
  messageSaveQueues.set(recordId, next);
  void next.finally(() => {
    if (messageSaveQueues.get(recordId) === next) {
      messageSaveQueues.delete(recordId);
    }
  });
}

export function ChatPanel({
  onCollapse,
  initialImage,
  recordId,
  onImageInput,
}: {
  onCollapse?: () => void;
  initialImage?: AcceptedImage | null;
  recordId?: string | null;
  onImageInput?: (image: AcceptedImage, source: CaptureSource) => Promise<void> | void;
}) {
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [shortcutHint, setShortcutHint] = useState("");
  const {
    state,
    streamingText,
    isAnswering,
    ocrLoading,
    error,
    statusBar,
    clearError,
    setImage,
    ask,
    stopGeneration,
    clearConversation,
    loadSession,
    resetSession,
  } = useImageSession({ recordId });
  const dropRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const standaloneImageRef = useRef<string | null>(null);
  const [loadedRecordId, setLoadedRecordId] = useState<string | null>(null);

  const hasConversation = state.messages.length > 0 || Boolean(streamingText);
  const showQuickActions = Boolean(state.image) && !hasConversation;
  const banner = error || notice;

  useEffect(() => {
    let active = true;
    setLoadedRecordId(null);
    resetSession();

    if (!recordId) {
      if (initialImage && standaloneImageRef.current !== initialImage.dataUrl) {
        standaloneImageRef.current = initialImage.dataUrl;
        void setImage(initialImage);
      }
      return () => {
        active = false;
      };
    }

    void (async () => {
      try {
        const record = await captureClient.get(recordId);
        if (!active || !record) return;
        const image: AcceptedImage = initialImage ?? {
          name: `${recordId}.png`,
          dataUrl: await captureClient.readImage(recordId, false),
        };
        if (!active) return;

        if (record.ocrState === "pending") {
          await setImage(image);
        } else {
          loadSession({
            image,
            ocrText: record.ocrText,
            messages: record.messages,
          });
        }
        if (active) setLoadedRecordId(recordId);
      } catch (err) {
        if (active) setNotice(`加载截图失败：${String(err)}`);
      }
    })();

    return () => {
      active = false;
    };
  }, [initialImage?.dataUrl, initialImage?.name, loadSession, recordId, resetSession, setImage]);

  useEffect(() => {
    if (!recordId || loadedRecordId !== recordId || !state.image || ocrLoading) return;
    void captureClient.update(recordId, {
      ocrText: state.ocrText,
      ocrState: error ? "failed" : "ready",
    });
  }, [error, loadedRecordId, ocrLoading, recordId, state.image, state.ocrText]);

  useEffect(() => {
    if (!recordId || loadedRecordId !== recordId || !state.image) return;
    enqueueMessageSave(recordId, state.messages);
  }, [loadedRecordId, recordId, state.image, state.messages]);

  const acceptImage = useCallback(async (image: AcceptedImage, source: CaptureSource) => {
    setNotice("");
    clearError();
    if (onImageInput) {
      try {
        await onImageInput(image, source);
      } catch (err) {
        setNotice(`添加图片失败：${String(err)}`);
      }
      return;
    }
    if (recordId) {
      setNotice("无法创建新的截图记录。");
      return;
    }
    await setImage(image);
  }, [clearError, onImageInput, recordId, setImage]);

  useEffect(() => {
    let active = true;
    void loadSettings()
      .then((settings) => {
        if (active && settings.shortcut) {
          setShortcutHint(formatShortcut(settings.shortcut));
        }
      })
      .catch(() => {
        /* 读取失败时不展示提示即可 */
      });
    return () => {
      active = false;
    };
  }, []);

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
            void readFileAsDataUrl(file).then((image) => void acceptImage(image, "paste"));
          }
          return;
        }
      }
      void readClipboardImage().then((image) => {
        if (image) {
          void acceptImage(image, "paste");
        }
      });
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [acceptImage]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      void invoke("hide_quick_panel_command");
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const element = dropRef.current;
    if (!element) {
      return;
    }

    function handleDragEnter(event: DragEvent) {
      event.preventDefault();
      setDragOver(true);
    }

    function handleDragLeave(event: DragEvent) {
      if (!element?.contains(event.relatedTarget as Node)) {
        setDragOver(false);
      }
    }

    function handleDragOver(event: DragEvent) {
      event.preventDefault();
      setDragOver(true);
    }

    function handleDrop(event: DragEvent) {
      event.preventDefault();
      setDragOver(false);
      const files = filterAcceptedFiles(event.dataTransfer?.files ?? []);
      const file = files[0];
      if (file) {
        void readFileAsDataUrl(file).then((image) => void acceptImage(image, "drag"));
      }
    }

    element.addEventListener("dragenter", handleDragEnter);
    element.addEventListener("dragleave", handleDragLeave);
    element.addEventListener("dragover", handleDragOver);
    element.addEventListener("drop", handleDrop);
    return () => {
      element.removeEventListener("dragenter", handleDragEnter);
      element.removeEventListener("dragleave", handleDragLeave);
      element.removeEventListener("dragover", handleDragOver);
      element.removeEventListener("drop", handleDrop);
    };
  }, [acceptImage, state.image, hasConversation]);

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
    if (onCollapse) {
      onCollapse();
      return;
    }
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

  function handleQuickAction(prompt: string, displayText: string) {
    if (isAnswering) {
      return;
    }
    setNotice("");
    void ask(prompt, displayText);
  }

  async function handleCopyText() {
    if (ocrLoading) {
      setNotice("识别中…");
      return;
    }
    const text = state.ocrText.trim();
    if (!text) {
      setNotice("没识别到文字。");
      return;
    }
    try {
      await writeText(text);
      setNotice("已复制文字");
    } catch (err) {
      setNotice(`复制失败：${String(err)}`);
    }
  }

  function handleTranslateImage() {
    if (!state.image || isAnswering) {
      return;
    }
    if (ocrLoading) {
      setNotice("识别中…");
      return;
    }
    handleQuickAction(
      [
        "翻译图片里的所有可见文字。",
        "保留原有顺序和换行。",
        "如果文字已经是中文，就整理成可复制的原文。",
        "不要只摘一句，不要解释。",
      ].join("\n"),
      "翻译图片文字",
    );
  }

  function triggerReplaceImage() {
    fileInputRef.current?.click();
  }

  async function handlePasteImage() {
    const image = await readClipboardImage();
    if (image) {
      await acceptImage(image, "paste");
    } else {
      setNotice("剪贴板没有图片。");
    }
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
      await acceptImage(image, "capture");
    } catch (err) {
      if (err instanceof CaptureError && err.code === "cancelled") return;
      setNotice(
        err instanceof CaptureError && err.code === "permission-denied"
          ? "请在系统设置中允许屏幕录制后重试。"
          : "截图失败，请重试。",
      );
    } finally {
      setCapturing(false);
    }
  }

  function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      void readFileAsDataUrl(file).then((image) => void acceptImage(image, "file"));
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
        visible={statusBar.visible}
        message={statusBar.message}
        detail={statusBar.detail}
        onStop={() => void stopGeneration()}
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
            aria-label="关闭提示"
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
          <div className="image2-empty-flow">
            <div
              ref={dropRef}
              className={`drop-zone${dragOver ? " drop-zone--drag-over" : ""}`}
            >
              <span
                className="drop-zone__icon"
                data-testid="empty-image-icon"
                aria-hidden="true"
              >
                <ImagePlus />
              </span>
              <div className="drop-zone__copy">
                <strong>拖入图片</strong>
                <span>{shortcutHint ? `${shortcutHint} 截图` : "粘贴或截图"}</span>
              </div>
            </div>

            <div className="drop-zone__actions image2-start-actions">
              <button
                type="button"
                className="drop-zone__capture"
                disabled={capturing || isAnswering}
                onClick={() => void handleCaptureScreen()}
              >
                {capturing ? "截图中…" : "截图"}
              </button>
              <button
                type="button"
                className="drop-zone__secondary"
                disabled={isAnswering}
                onClick={() => void handlePasteImage()}
              >
                粘贴
              </button>
            </div>
          </div>
        ) : (
          <>
            <div ref={dropRef} className={`chat-panel__meta${hasConversation ? " chat-panel__meta--compact" : ""}`}>
              <div className={`chat-panel__image-row${hasConversation ? " chat-panel__image-row--compact" : ""}`}>
                <ImagePreviewStrip
                  dataUrl={state.image.dataUrl}
                  name={state.image.name}
                  compact={hasConversation}
                />
                <div className={`chat-panel__image-actions${hasConversation ? " chat-panel__image-actions--row" : ""}`}>
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
                      清空
                    </button>
                  ) : null}
                </div>
              </div>
              {showQuickActions ? (
                <QuickActions
                  onCopyText={() => void handleCopyText()}
                  onTranslate={handleTranslateImage}
                  textReady={Boolean(state.ocrText.trim())}
                  disabled={isAnswering || ocrLoading}
                />
              ) : null}
              {!hasConversation && (state.ocrText || ocrLoading) ? (
                <RecognizedTextPanel text={state.ocrText} loading={ocrLoading} />
              ) : null}
            </div>

            {hasConversation ? (
              <TranscriptPanel messages={state.messages} streamingText={streamingText} />
            ) : null}

            {hasConversation && (state.ocrText || ocrLoading) ? (
              <RecognizedTextPanel text={state.ocrText} loading={ocrLoading} compact />
            ) : null}
          </>
        )}
      </div>

      <Composer
        value={input}
        disabled={false}
        isAnswering={isAnswering}
        canSubmit={Boolean(state.image)}
        onChange={setInput}
        onSubmit={submit}
        onStop={() => void stopGeneration()}
      />
    </section>
  );
}
