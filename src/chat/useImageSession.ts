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

export type UseImageSessionOptions = {
  recordId?: string | null;
};

export function useImageSession({ recordId = null }: UseImageSessionOptions = {}) {
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
  const imageRequestRef = useRef(0);
  const stateRef = useRef(state);
  const recordIdRef = useRef(recordId);
  const sessionGenerationRef = useRef(0);
  const currentRequestIdRef = useRef<string | null>(null);
  const answeringRef = useRef(false);
  const answerOperationRef = useRef(0);
  stateRef.current = state;
  recordIdRef.current = recordId;

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

  const cancelActiveRequest = useCallback(() => {
    const requestId = currentRequestIdRef.current;
    currentRequestIdRef.current = null;
    if (requestId) {
      void modelClient.cancelGeneration(requestId).catch(() => {
        /* 会话切换时取消失败不应阻塞新记录 */
      });
    }
  }, []);

  const resetSession = useCallback(() => {
    sessionGenerationRef.current += 1;
    answerOperationRef.current += 1;
    answeringRef.current = false;
    cancelActiveRequest();
    imageRequestRef.current += 1;
    const emptyState = createImageSessionState();
    stateRef.current = emptyState;
    setState(emptyState);
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setOcrLoading(false);
    setError("");
    setPendingReplaceImage(null);
    setLoadProgress("");
    setElapsed(0);
    warmupStartedRef.current = false;
  }, [cancelActiveRequest]);

  const loadSession = useCallback((session: ImageSessionState) => {
    sessionGenerationRef.current += 1;
    answerOperationRef.current += 1;
    answeringRef.current = false;
    cancelActiveRequest();
    imageRequestRef.current += 1;
    stateRef.current = session;
    setState(session);
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setOcrLoading(false);
    setError("");
    setPendingReplaceImage(null);
    setLoadProgress("");
    setElapsed(0);
  }, [cancelActiveRequest]);

  const applyImage = useCallback(async (image: ImageAttachment, replaceConversation: boolean) => {
    sessionGenerationRef.current += 1;
    answerOperationRef.current += 1;
    answeringRef.current = false;
    cancelActiveRequest();
    const request = ++imageRequestRef.current;
    if (replaceConversation) {
      const nextState = { ...createImageSessionState(), image, ocrText: "" };
      stateRef.current = nextState;
      setState(nextState);
      setStreamingText("");
      setIsAnswering(false);
    } else {
      setState((current) => {
        const nextState = { ...current, image, ocrText: "" };
        stateRef.current = nextState;
        return nextState;
      });
    }

    setError("");
    setOcrLoading(true);
    try {
      const ocrRequest = invoke<{ text: string }>("recognize_text_from_image_data_url", {
        dataUrl: image.dataUrl,
      });
      queueMicrotask(kickModelWarmup);
      const ocr = await ocrRequest;
      if (imageRequestRef.current === request) {
        setState((current) => {
          const nextState = { ...current, ocrText: ocr.text };
          stateRef.current = nextState;
          return nextState;
        });
      }
    } catch {
      if (imageRequestRef.current === request) {
        setError("文字识别失败，请重试。");
      }
    } finally {
      if (imageRequestRef.current === request) {
        setOcrLoading(false);
      }
    }
    return true;
  }, [cancelActiveRequest, kickModelWarmup]);

  const setImage = useCallback(async (image: ImageAttachment) => {
    if (shouldConfirmImageReplacement(stateRef.current)) {
      setPendingReplaceImage(image);
      return false;
    }
    return applyImage(image, false);
  }, [applyImage]);

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
    sessionGenerationRef.current += 1;
    answerOperationRef.current += 1;
    answeringRef.current = false;
    cancelActiveRequest();
    setState((current) => {
      const nextState = { ...current, messages: [] };
      stateRef.current = nextState;
      return nextState;
    });
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setError("");
  }, [cancelActiveRequest]);

  const suspendSession = useCallback(() => {
    sessionGenerationRef.current += 1;
    answerOperationRef.current += 1;
    answeringRef.current = false;
    cancelActiveRequest();
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setLoadProgress("");
    setElapsed(0);
  }, [cancelActiveRequest]);

  const stopGeneration = useCallback(async () => {
    const requestId = currentRequestIdRef.current;
    if (!requestId) {
      return;
    }
    try {
      await modelClient.cancelGeneration(requestId);
    } catch {
      // 忽略取消失败
    }
  }, []);

  const ask = useCallback(
    async (prompt: string, displayText?: string) => {
      const normalizedPrompt = prompt.trim();
      const initialState = stateRef.current;
      if (!initialState.image || !normalizedPrompt || answeringRef.current) {
        return;
      }

      const operation = ++answerOperationRef.current;
      answeringRef.current = true;
      setIsAnswering(true);
      setError("");

      const generation = sessionGenerationRef.current;
      const sessionRecordId = recordIdRef.current;
      let requestId: string | null = null;
      let userMessageAdded = false;
      let assistantText = "";
      let failed = false;

      const isCurrentOperation = () =>
        answerOperationRef.current === operation &&
        sessionGenerationRef.current === generation;

      try {
        await refreshModelStatus();
        if (!isCurrentOperation()) {
          return;
        }

        const sessionState = stateRef.current;
        if (!sessionState.image) {
          return;
        }
        const history = sessionState.messages;
        const isFollowUp = history.length > 0;
        requestId = crypto.randomUUID();
        currentRequestIdRef.current = requestId;
        const userMessage: ChatMessage = {
          role: "user",
          content: (displayText ?? normalizedPrompt).trim(),
        };
        setState((current) => {
          const nextState = {
            ...current,
            messages: [...current.messages, userMessage],
          };
          stateRef.current = nextState;
          return nextState;
        });
        userMessageAdded = true;
        setStreamingText("");
        setModelLoading(true);
        setInferPhase(isFollowUp ? "thinking" : "loading");

        await modelClient.askImage(
          {
            recordId: sessionRecordId ?? undefined,
            requestId,
            imageDataUrl: sessionState.image.dataUrl,
            ocrText: sessionState.ocrText,
            prompt: normalizedPrompt,
            history,
          },
          (chunk) => {
            if (
              currentRequestIdRef.current !== requestId ||
              !isCurrentOperation()
            ) {
              return;
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
      } catch {
        failed = true;
        if (isCurrentOperation()) {
          setError("暂时无法回答，请重试。");
        }
      } finally {
        if (!isCurrentOperation()) {
          return;
        }
        if (requestId && currentRequestIdRef.current === requestId) {
          currentRequestIdRef.current = null;
        }
        answeringRef.current = false;
        setModelLoading(false);
        setIsAnswering(false);
        if (failed && userMessageAdded) {
          setState((current) => {
            const nextState = {
              ...current,
              messages: current.messages.slice(0, -1),
            };
            stateRef.current = nextState;
            return nextState;
          });
        } else if (assistantText.trim()) {
          setState((current) => {
            const nextState: ImageSessionState = {
              ...current,
              messages: [
                ...current.messages,
                { role: "assistant", content: assistantText.trim() },
              ],
            };
            stateRef.current = nextState;
            return nextState;
          });
        }
        setStreamingText("");
      }
    },
    [refreshModelStatus],
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
      suspendSession();
    }).then((cleanup) => {
      unlistenClosing = cleanup;
    });

    return () => {
      unlistenClosing?.();
    };
  }, [suspendSession]);

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
    loadSession,
    resetSession,
  };
}
