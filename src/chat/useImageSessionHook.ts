import { useCallback, useEffect, useMemo, useState } from "react";
import { modelClient } from "../model/modelClient";
import {
  createImageSessionState,
  shouldConfirmImageReplacement,
  type ChatMessage,
  type ImageAttachment,
  type ImageSessionState,
} from "./useImageSession";

export function useImageSession() {
  const [state, setState] = useState<ImageSessionState>(createImageSessionState);
  const [streamingText, setStreamingText] = useState("");
  const [isAnswering, setIsAnswering] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [inferPhase, setInferPhase] = useState<"loading" | "thinking">("loading");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [error, setError] = useState("");

  const clearError = useCallback(() => setError(""), []);

  const resetSession = useCallback(() => {
    setState(createImageSessionState());
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setOcrLoading(false);
    setError("");
  }, []);

  const setImage = useCallback(async (image: ImageAttachment) => {
    if (shouldConfirmImageReplacement(state)) {
      const confirmed = window.confirm("替换图片将清空当前对话，是否继续？");
      if (!confirmed) {
        return false;
      }
      setState({ ...createImageSessionState(), image, ocrText: "" });
      setStreamingText("");
      setIsAnswering(false);
    } else {
      setState((current) => ({ ...current, image, ocrText: "" }));
    }

    setError("");
    setOcrLoading(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
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
  }, [state]);

  const clearConversation = useCallback(() => {
    setState((current) => ({ ...current, messages: [] }));
    setStreamingText("");
    setIsAnswering(false);
    setModelLoading(false);
    setError("");
  }, []);

  const client = useMemo(() => modelClient, []);

  const stopGeneration = useCallback(async () => {
    try {
      await client.cancelGeneration();
    } catch {
      // 忽略取消失败
    }
  }, [client]);

  const ask = useCallback(
    async (prompt: string) => {
      if (!state.image || !prompt.trim() || isAnswering) {
        return;
      }

      const history = state.messages;
      const isFollowUp = history.length > 0;
      const userMessage: ChatMessage = { role: "user", content: prompt.trim() };
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
      let failed = false;
      try {
        await client.askImage(
          {
            imageDataUrl: state.image.dataUrl,
            ocrText: state.ocrText,
            prompt: prompt.trim(),
            history,
          },
          (chunk) => {
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
          setError("模型未返回内容，请重试");
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
            messages: [...current.messages, { role: "assistant", content: assistantText.trim() }],
          }));
        }
        setStreamingText("");
      }
    },
    [client, isAnswering, state.image, state.messages, state.ocrText],
  );

  useEffect(() => {
    let unlistenClosing: (() => void) | undefined;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenClosing = await listen("quick-panel-closing", () => {
        resetSession();
      });
    })();

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
    clearError,
    setImage,
    ask,
    stopGeneration,
    clearConversation,
    resetSession,
  };
}
