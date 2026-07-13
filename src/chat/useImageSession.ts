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

export type OcrStatus = "idle" | "recognizing" | "recognized" | "empty" | "failed";

type FailedAnswer = {
  prompt: string;
  displayText?: string;
};

export function useImageSession() {
  const [state, setState] = useState<ImageSessionState>(createImageSessionState);
  const [streamingText, setStreamingText] = useState("");
  const [isAnswering, setIsAnswering] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [inferPhase, setInferPhase] = useState<"loading" | "thinking">("loading");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>("idle");
  const [ocrError, setOcrError] = useState("");
  const [error, setError] = useState("");
  const [answerError, setAnswerError] = useState("");
  const [failedAnswer, setFailedAnswer] = useState<FailedAnswer | null>(null);
  const [pendingReplaceImage, setPendingReplaceImage] = useState<ImageAttachment | null>(null);
  const [inferenceBackend, setInferenceBackend] = useState<"llama" | "mlx">("llama");
  const [mlxWeightsReady, setMlxWeightsReady] = useState(true);
  const [loadProgress, setLoadProgress] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const isAnsweringRef = useRef(false);
  const ocrRequestRef = useRef(0);
  const warmupStartedRef = useRef(false);

  const setAnswering = useCallback((value: boolean) => {
    isAnsweringRef.current = value;
    setIsAnswering(value);
  }, []);

  const clearError = useCallback(() => {
    setError("");
    setAnswerError("");
  }, []);

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
    ocrRequestRef.current += 1;
    setState(createImageSessionState());
    setStreamingText("");
    setAnswering(false);
    setModelLoading(false);
    setOcrLoading(false);
    setOcrStatus("idle");
    setOcrError("");
    setError("");
    setAnswerError("");
    setFailedAnswer(null);
    setPendingReplaceImage(null);
    setLoadProgress("");
    setElapsed(0);
    warmupStartedRef.current = false;
  }, [setAnswering]);

  const recognizeImage = useCallback(async (image: ImageAttachment) => {
    const requestId = ++ocrRequestRef.current;
    setOcrLoading(true);
    setOcrStatus("recognizing");
    setOcrError("");
    try {
      const ocr = await invoke<{ text: string }>("recognize_text_from_image_data_url", {
        dataUrl: image.dataUrl,
      });
      const text = ocr.text.trim();
      if (requestId !== ocrRequestRef.current) {
        return;
      }
      setState((current) => ({ ...current, ocrText: text }));
      setOcrStatus(text ? "recognized" : "empty");
    } catch {
      if (requestId !== ocrRequestRef.current) {
        return;
      }
      setState((current) => ({ ...current, ocrText: "" }));
      setOcrStatus("failed");
      setOcrError("文字没识别出来");
    } finally {
      if (requestId === ocrRequestRef.current) {
        setOcrLoading(false);
      }
    }
  }, []);

  const applyImage = useCallback(async (image: ImageAttachment, replaceConversation: boolean) => {
    if (isAnsweringRef.current) {
      return false;
    }
    if (replaceConversation) {
      setState({ ...createImageSessionState(), image, ocrText: "" });
      setStreamingText("");
      setAnswering(false);
    } else {
      setState((current) => ({ ...current, image, ocrText: "" }));
    }

    setError("");
    setAnswerError("");
    setFailedAnswer(null);
    kickModelWarmup();
    await recognizeImage(image);
    return true;
  }, [kickModelWarmup, recognizeImage, setAnswering]);

  const retryOcr = useCallback(async () => {
    if (!state.image || ocrLoading || isAnsweringRef.current) {
      return;
    }
    await recognizeImage(state.image);
  }, [ocrLoading, recognizeImage, state.image]);

  const setImage = useCallback(
    async (image: ImageAttachment) => {
      if (isAnsweringRef.current) {
        return false;
      }
      if (shouldConfirmImageReplacement(state)) {
        setPendingReplaceImage(image);
        return false;
      }
      return applyImage(image, false);
    },
    [applyImage, state],
  );

  const confirmReplaceImage = useCallback(async () => {
    if (!pendingReplaceImage || isAnsweringRef.current) {
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
    if (isAnsweringRef.current) {
      return;
    }
    setState((current) => ({ ...current, messages: [] }));
    setStreamingText("");
    setAnswering(false);
    setModelLoading(false);
    setError("");
    setAnswerError("");
    setFailedAnswer(null);
  }, [setAnswering]);

  const stopGeneration = useCallback(async () => {
    try {
      await modelClient.cancelGeneration();
    } catch {
      // 忽略取消失败
    }
  }, []);

  const runAnswer = useCallback(
    async (prompt: string, displayText?: string, reuseLastQuestion = false) => {
      if (!state.image || !prompt.trim() || isAnsweringRef.current) {
        return;
      }

      const history = reuseLastQuestion ? state.messages.slice(0, -1) : state.messages;
      const isFollowUp = history.length > 0;
      const userMessage: ChatMessage = {
        role: "user",
        content: (displayText ?? prompt).trim(),
      };
      if (!reuseLastQuestion) {
        setState((current) => ({
          ...current,
          messages: [...current.messages, userMessage],
        }));
      }
      setStreamingText("");
      setAnswering(true);
      setModelLoading(true);
      setInferPhase(isFollowUp ? "thinking" : "loading");
      setError("");
      setAnswerError("");
      setFailedAnswer(null);

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
          setAnswerError("回答没有完成，请重试");
        }
      } catch {
        failed = true;
        setAnswerError("回答没有完成，请重试");
      } finally {
        setModelLoading(false);
        setAnswering(false);
        if (failed) {
          setFailedAnswer({ prompt: prompt.trim(), displayText });
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
    [setAnswering, state.image, state.messages, state.ocrText],
  );

  const ask = useCallback(
    async (prompt: string, displayText?: string) => runAnswer(prompt, displayText),
    [runAnswer],
  );

  const retryAnswer = useCallback(async () => {
    if (!failedAnswer) {
      return;
    }
    await runAnswer(failedAnswer.prompt, failedAnswer.displayText, true);
  }, [failedAnswer, runAnswer]);

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
    ocrStatus,
    ocrError,
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
    resetSession,
  };
}
