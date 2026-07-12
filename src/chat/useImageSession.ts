import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { modelClient } from "../model/modelClient";

export type ImageAttachment = {
  name: string;
  dataUrl: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  modelVersion?: string;
};

export type ImageSessionState = {
  image: ImageAttachment | null;
  ocrText: string;
  messages: ChatMessage[];
};

export function createImageSessionState(): ImageSessionState {
  return {
    image: null,
    ocrText: "",
    messages: [],
  };
}

export function shouldConfirmImageReplacement(state: ImageSessionState): boolean {
  return state.image !== null && state.messages.length > 0;
}

export type ImageSessionStatusBar = {
  visible: boolean;
  message: string;
  detail: string | undefined;
};

export function useImageSession() {
  const [state, setState] = useState<ImageSessionState>(createImageSessionState);
  const [streamingText, setStreamingText] = useState("");
  const [isAnswering, setIsAnswering] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [inferPhase, setInferPhase] = useState<"loading" | "thinking">("loading");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingReplaceImage, setPendingReplaceImage] = useState<ImageAttachment | null>(null);
  const [inferenceBackend, setInferenceBackend] = useState<"llama" | "mlx">("llama");
  const [mlxWeightsReady, setMlxWeightsReady] = useState(true);
  const [loadProgress, setLoadProgress] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const warmupStartedRef = useRef(false);

  const clearError = useCallback(() => setError(""), []);

  const kickModelWarmup = useCallback(() => {
    if (warmupStartedRef.current) {
      return;
    }
    warmupStartedRef.current = true;
    void modelClient.warmupModel().catch(() => {
      warmupStartedRef.current = false;
    });
  }, []);

  const refreshModelStatus = useCallback(async () => {
    const status = await modelClient.getModelStatus();
    setInferenceBackend(status.inferenceBackend ?? "llama");
    setMlxWeightsReady(status.mlxModelReady ?? false);
    return status;
  }, []);

  const resetSession = useCallback(() => {
    setState(createImageSessionState());
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setOcrLoading(false);
    setError("");
    setPendingReplaceImage(null);
    setLoadProgress("");
    setElapsed(0);
    warmupStartedRef.current = false;
  }, []);

  const applyImage = useCallback(async (image: ImageAttachment, replaceConversation: boolean) => {
    if (replaceConversation) {
      setState({ ...createImageSessionState(), image, ocrText: "" });
      setStreamingText("");
      setIsAnswering(false);
    } else {
      setState((current) => ({ ...current, image, ocrText: "" }));
    }

    setError("");
    setOcrLoading(true);
    kickModelWarmup();
    try {
      const ocr = await invoke<{ text: string }>("recognize_text_from_image_data_url", {
        dataUrl: image.dataUrl,
      });
      setState((current) => ({ ...current, ocrText: ocr.text }));
    } catch (err) {
      setError(`文字识别失败：${String(err)}`);
    } finally {
      setOcrLoading(false);
    }
    return true;
  }, [kickModelWarmup]);

  const setImage = useCallback(
    async (image: ImageAttachment) => {
      if (shouldConfirmImageReplacement(state)) {
        setPendingReplaceImage(image);
        return false;
      }
      return applyImage(image, false);
    },
    [applyImage, state],
  );

  const confirmReplaceImage = useCallback(async () => {
    if (!pendingReplaceImage) {
      return false;
    }
    const image = pendingReplaceImage;
    setPendingReplaceImage(null);
    return applyImage(image, true);
  }, [applyImage, pendingReplaceImage]);

  const cancelReplaceImage = useCallback(() => {
    setPendingReplaceImage(null);
  }, []);

  const clearConversation = useCallback(() => {
    setState((current) => ({ ...current, messages: [] }));
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setError("");
  }, []);

  const stopGeneration = useCallback(async () => {
    try {
      await modelClient.cancelGeneration();
    } catch {
      // 忽略取消失败
    }
  }, []);

  const ask = useCallback(
    async (prompt: string, displayText?: string) => {
      if (!state.image || !prompt.trim() || isAnswering) {
        return;
      }

      const history = state.messages;
      const isFollowUp = history.length > 0;
      const userMessage: ChatMessage = {
        role: "user",
        content: (displayText ?? prompt).trim(),
      };
      setState((current) => ({
        ...current,
        messages: [...current.messages, userMessage],
      }));
      setStreamingText("");
      setIsAnswering(true);
      setModelLoading(true);
      setInferPhase(isFollowUp ? "thinking" : "loading");
      setError("");

      let assistantText = "";
      let modelVersion: string | undefined;
      let failed = false;
      try {
        await modelClient.askImage(
          {
            imageDataUrl: state.image.dataUrl,
            ocrText: state.ocrText,
            prompt: prompt.trim(),
            history: history.map(({ role, content }) => ({ role, content })),
          },
          (chunk) => {
            if (chunk.modelLabel) {
              modelVersion = chunk.modelLabel;
            }
            if (chunk.text) {
              assistantText += chunk.text;
              setStreamingText(assistantText);
              setInferPhase("thinking");
            }
            if (chunk.done) {
              setModelLoading(false);
            }
          },
        );
        if (!assistantText.trim()) {
          failed = true;
          setError("没有生成结果。");
        }
      } catch (err) {
        failed = true;
        setError(String(err));
      } finally {
        setModelLoading(false);
        setIsAnswering(false);
        if (failed) {
          setState((current) => ({
            ...current,
            messages: current.messages.slice(0, -1),
          }));
        } else if (assistantText.trim()) {
          setState((current) => ({
            ...current,
            messages: [
              ...current.messages,
              { role: "assistant", content: assistantText.trim(), modelVersion },
            ],
          }));
        }
        setStreamingText("");
      }
    },
    [isAnswering, state.image, state.messages, state.ocrText],
  );

  const waitingForModel = modelLoading && !streamingText && inferPhase === "loading";

  const statusBar = useMemo<ImageSessionStatusBar>(() => {
    const message =
      loadProgress ||
      (streamingText
        ? "生成中…"
        : inferPhase === "thinking"
          ? "处理中…"
          : inferenceBackend === "mlx"
            ? "加载中…"
            : "加载中…");

    let detail: string | undefined;
    if (waitingForModel) {
      detail = loadProgress
        ? `${elapsed}s · ${loadProgress}`
        : inferenceBackend === "mlx"
          ? mlxWeightsReady
            ? `${elapsed}s`
            : `${elapsed}s · 下载中`
          : `${elapsed}s`;
    } else if (inferPhase === "thinking" && !streamingText) {
      detail = "请稍候";
    }

    return {
      visible: modelLoading,
      message,
      detail,
    };
  }, [
    elapsed,
    inferPhase,
    inferenceBackend,
    loadProgress,
    mlxWeightsReady,
    modelLoading,
    streamingText,
    waitingForModel,
  ]);

  useEffect(() => {
    void refreshModelStatus();
  }, [refreshModelStatus]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void modelClient.onSidecarLoadProgress((message) => {
      setLoadProgress(message);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
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
    let unlistenClosing: (() => void) | undefined;

    void listen("quick-panel-closing", () => {
      resetSession();
    }).then((cleanup) => {
      unlistenClosing = cleanup;
    });

    return () => {
      unlistenClosing?.();
    };
  }, [resetSession]);

  return {
    state,
    streamingText,
    isAnswering,
    modelLoading,
    inferPhase,
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
    resetSession,
  };
}
