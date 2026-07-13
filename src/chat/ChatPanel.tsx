import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Composer } from "./Composer";
import { ImagePreviewStrip } from "./ImagePreviewStrip";
import { ModelStatusBar } from "./ModelStatusBar";
import { PanelHeader } from "./PanelHeader";
import { RecognizedTextPanel } from "./RecognizedTextPanel";
import { ReplaceImageConfirm } from "./ReplaceImageConfirm";
import { TranscriptPanel } from "./TranscriptPanel";
import { useImageSession } from "./useImageSession";
import { exportCurrentSession } from "../export/exportSession";
import { captureScreenRegion, isCaptureCancelled } from "../image/captureScreen";
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
    ocrStatus,
    error,
    answerError,
    statusBar,
    clearError,
    setImage,
    retryOcr,
    pendingReplaceImage,
    confirmReplaceImage,
    cancelReplaceImage,
    ask,
    retryAnswer,
    stopGeneration,
    clearConversation,
  } = useImageSession();
  const dropRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasConversation = state.messages.length > 0 || Boolean(streamingText);
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
      if (isAnswering) {
        return;
      }
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
  }, [isAnswering, setImage]);

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
      if (isAnswering) {
        return;
      }
      setDragOver(true);
    }

    function handleDragLeave(event: DragEvent) {
      if (!element?.contains(event.relatedTarget as Node)) {
        setDragOver(false);
      }
    }

    function handleDragOver(event: DragEvent) {
      event.preventDefault();
      if (isAnswering) {
        return;
      }
      setDragOver(true);
    }

    function handleDrop(event: DragEvent) {
      event.preventDefault();
      setDragOver(false);
      if (isAnswering) {
        return;
      }
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
  }, [hasConversation, isAnswering, setImage, state.image]);

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
    if (isAnswering) {
      return;
    }
    fileInputRef.current?.click();
  }

  async function handlePasteImage() {
    if (isAnswering) {
      return;
    }
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
      if (!isCaptureCancelled(err)) {
        setNotice("未能截图，请重试");
      }
    } finally {
      setCapturing(false);
    }
  }

  function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    if (isAnswering) {
      event.target.value = "";
      return;
    }
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
      />

      <div className="image2-panel-tabs" aria-label="快捷操作">
        <button type="button" aria-label="截图 OCR" onClick={() => void handleCaptureScreen()} disabled={capturing || isAnswering}>
          <span>⌗</span>
          截图 OCR
        </button>
        <button type="button" aria-label="截图翻译" onClick={handleTranslateImage} disabled={!state.image || isAnswering}>
          <span>⇄</span>
          截图翻译
        </button>
        <button type="button" aria-label="图片问答" onClick={handleAskImage} disabled={!state.image || isAnswering}>
          <span>◎</span>
          图片问答
        </button>
        <button type="button" aria-label="更多" onClick={triggerReplaceImage} disabled={isAnswering}>
          <span>•••</span>
          更多
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
        disabled={isAnswering}
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
                <span>{shortcutHint ? `${shortcutHint} 唤起面板` : "粘贴或截图"}</span>
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
                粘贴图片
              </button>
              <button
                type="button"
                className="drop-zone__secondary"
                disabled={isAnswering}
                onClick={triggerReplaceImage}
              >
                选择图片
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
                  <button type="button" className="ghost-btn" disabled={isAnswering} onClick={triggerReplaceImage}>
                    换图
                  </button>
                  {hasConversation ? (
                    <button type="button" className="ghost-btn" disabled={isAnswering} onClick={clearConversation}>
                      清空
                    </button>
                  ) : null}
                </div>
              </div>
              {!hasConversation ? (
                <RecognizedTextPanel
                  text={state.ocrText}
                  status={ocrStatus}
                  disabled={isAnswering}
                  onRetry={() => void retryOcr()}
                />
              ) : null}
            </div>

            {hasConversation ? (
              <TranscriptPanel messages={state.messages} streamingText={streamingText} />
            ) : null}

            {hasConversation ? (
              <RecognizedTextPanel
                text={state.ocrText}
                status={ocrStatus}
                compact
                disabled={isAnswering}
                onRetry={() => void retryOcr()}
              />
            ) : null}

            {answerError ? (
              <div className="answer-error" role="alert">
                <span>{answerError}</span>
                <button type="button" onClick={() => void retryAnswer()} disabled={isAnswering}>
                  重试回答
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <Composer
        value={input}
        disabled={!state.image || isAnswering}
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
