import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Composer } from "./Composer";
import { ImagePreviewStrip } from "./ImagePreviewStrip";
import { ModelStatusBar } from "./ModelStatusBar";
import { PanelHeader } from "./PanelHeader";
import { QuickActions } from "./QuickActions";
import { RecognizedTextPanel } from "./RecognizedTextPanel";
import { ReplaceImageConfirm } from "./ReplaceImageConfirm";
import { TranscriptPanel } from "./TranscriptPanel";
import { useImageSession } from "./useImageSession";
import { exportCurrentSession } from "../export/exportSession";
import { captureScreenRegion } from "../image/captureScreen";
import {
  filterAcceptedFiles,
  readClipboardImage,
  readFileAsDataUrl,
} from "../image/imageIntake";
import { loadSettings } from "../settings/settingsStore";

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

export function ChatPanel({ onCollapse }: { onCollapse?: () => void }) {
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [shortcutHint, setShortcutHint] = useState("");
  const [focusComposerSignal, setFocusComposerSignal] = useState(0);
  const {
    state,
    streamingText,
    isAnswering,
    ocrLoading,
    error,
    statusBar,
    clearError,
    setImage,
    pendingReplaceImage,
    confirmReplaceImage,
    cancelReplaceImage,
    ask,
    stopGeneration,
    clearConversation,
  } = useImageSession();
  const dropRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasConversation = state.messages.length > 0 || Boolean(streamingText);
  const showQuickActions = Boolean(state.image) && !hasConversation;
  const banner = error || notice;

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
      if (event.key !== "Escape") {
        return;
      }
      if (pendingReplaceImage) {
        return;
      }
      void invoke("hide_quick_panel_command");
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingReplaceImage]);

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
        void readFileAsDataUrl(file).then((image) => void setImage(image));
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
  }, [setImage, state.image, hasConversation]);

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

  function handleAskImage() {
    if (!state.image) {
      return;
    }
    setNotice("");
    setFocusComposerSignal((value) => value + 1);
  }

  function triggerReplaceImage() {
    fileInputRef.current?.click();
  }

  async function handlePasteImage() {
    const image = await readClipboardImage();
    if (image) {
      await setImage(image);
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
        visible={statusBar.visible}
        message={statusBar.message}
        detail={statusBar.detail}
        onStop={() => void stopGeneration()}
      />

      <div className="image2-panel-tabs" aria-label="识别模式">
        <button type="button" className="is-active" onClick={() => void handleCaptureScreen()} disabled={capturing || isAnswering}>
          <span>⌗</span>
          截图
        </button>
        <button type="button" onClick={() => void handleCopyText()} disabled={!state.image || isAnswering}>
          <span>≡</span>
          文字
        </button>
        <button type="button" onClick={handleTranslateImage} disabled={!state.image || isAnswering}>
          <span>⇄</span>
          翻译
        </button>
        <button type="button" onClick={handleAskImage} disabled={!state.image || isAnswering}>
          <span>◎</span>
          问图
        </button>
      </div>

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

      {pendingReplaceImage ? (
        <ReplaceImageConfirm
          onCancel={() => cancelReplaceImage()}
          onConfirm={() => void confirmReplaceImage()}
        />
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
              <span className="drop-zone__icon" aria-hidden="true">
                <span />
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
                  onAsk={handleAskImage}
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
        focusSignal={focusComposerSignal}
        onChange={setInput}
        onSubmit={submit}
        onStop={() => void stopGeneration()}
      />
    </section>
  );
}
