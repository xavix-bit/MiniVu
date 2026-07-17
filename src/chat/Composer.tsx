import { useEffect, useRef } from "react";

type ComposerProps = {
  value: string;
  disabled: boolean;
  isAnswering: boolean;
  canSubmit: boolean;
  focusSignal?: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
};

const MIN_INPUT_HEIGHT = 44;
const MAX_INPUT_RATIO = 0.38;
const IME_CONFIRMATION_GUARD_MS = 250;

function maxInputHeight() {
  return Math.max(120, Math.round(window.innerHeight * MAX_INPUT_RATIO));
}

function isPhysicalEnter(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  return event.code === "Enter" || event.code === "NumpadEnter";
}

function isImeConfirmation(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  compositionEndedAt: number,
) {
  return event.nativeEvent.isComposing
    || event.keyCode === 229
    || performance.now() - compositionEndedAt < IME_CONFIRMATION_GUARD_MS;
}

export function Composer({
  value,
  disabled,
  isAnswering,
  canSubmit,
  focusSignal = 0,
  onChange,
  onSubmit,
  onStop,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY);

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

  // 图片就绪（disabled 变 false）后立即聚焦，省去一次点击 —— 截屏即答的核心摩擦点。
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  useEffect(() => {
    if (!disabled && focusSignal > 0) {
      inputRef.current?.focus();
    }
  }, [disabled, focusSignal]);

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

    if (!isPhysicalEnter(event)) {
      return;
    }

    event.preventDefault();
    if (composingRef.current || isImeConfirmation(event, compositionEndedAtRef.current)) {
      return;
    }

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
        placeholder="问这张图…"
      />
      <div className="composer__footer">
        {isAnswering ? (
          <button type="button" className="composer__stop" onClick={onStop}>
            停止
          </button>
        ) : (
          <button type="submit" className="composer__submit" disabled={!canSubmit || !value.trim()}>
            发送
          </button>
        )}
      </div>
    </form>
  );
}
