import { useEffect, useRef } from "react";

type ComposerProps = {
  value: string;
  disabled: boolean;
  isAnswering: boolean;
  canSubmit: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
};

const MIN_INPUT_HEIGHT = 44;
const MAX_INPUT_RATIO = 0.38;
/** 仅拦截 IME 确认词与 Enter 同一按键泄漏，不挡用户第二次 intentional Enter */
const IME_ENTER_LEAK_MS = 40;

function maxInputHeight() {
  return Math.max(120, Math.round(window.innerHeight * MAX_INPUT_RATIO));
}

function isImeEnterLeak(event: React.KeyboardEvent<HTMLTextAreaElement>, compositionEndedAt: number) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) {
    return true;
  }
  return performance.now() - compositionEndedAt < IME_ENTER_LEAK_MS;
}

export function Composer({
  value,
  disabled,
  isAnswering,
  canSubmit,
  onChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);

  function autoSizeInput() {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, MIN_INPUT_HEIGHT), maxInputHeight());
    el.style.height = `${next}px`;
  }

  useEffect(() => {
    autoSizeInput();
  }, [value]);

  useEffect(() => {
    function handleResize() {
      autoSizeInput();
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  function trySubmit() {
    if (!canSubmit || isAnswering || !value.trim()) {
      return;
    }
    onSubmit();
    if (inputRef.current) {
      inputRef.current.style.height = `${MIN_INPUT_HEIGHT}px`;
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (composingRef.current) {
      return;
    }
    trySubmit();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    if (composingRef.current || isImeEnterLeak(event, compositionEndedAtRef.current)) {
      return;
    }

    event.preventDefault();
    trySubmit();
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        ref={inputRef}
        className="composer__input"
        value={value}
        rows={2}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionUpdate={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          compositionEndedAtRef.current = performance.now();
        }}
        placeholder="输入问题，Enter 发送"
      />
      <div className="composer__footer">
        <span className="composer__hint">Enter 发送 · Shift+Enter 换行</span>
        {isAnswering ? (
          <button type="button" className="composer__stop" onClick={onStop}>
            停止
          </button>
        ) : (
          <button type="submit" className="composer__submit" disabled={!canSubmit || !value.trim()}>
            提问
          </button>
        )}
      </div>
    </form>
  );
}
