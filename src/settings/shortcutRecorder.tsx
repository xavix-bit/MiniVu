import { useEffect, useState } from "react";

type ShortcutRecorderProps = {
  disabled?: boolean;
  value: string;
  onChange: (value: string) => void;
};

function formatKeyLabel(part: string) {
  return part
    .replace("Control", "⌃")
    .replace("Option", "⌥")
    .replace("Command", "⌘")
    .replace("Shift", "⇧")
    .replace("Space", "Space");
}

export function ShortcutRecorder({ disabled = false, value, onChange }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const parts = value.split("+").filter(Boolean);

  useEffect(() => {
    if (disabled || !recording) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      const next: string[] = [];
      if (event.metaKey) next.push("Command");
      if (event.ctrlKey) next.push("Control");
      if (event.altKey) next.push("Option");
      if (event.shiftKey) next.push("Shift");

      const key = event.key;
      if (!["Meta", "Control", "Alt", "Shift"].includes(key)) {
        next.push(key.length === 1 ? key.toUpperCase() : key);
      }

      if (next.length > 1) {
        onChange(next.join("+"));
        setRecording(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [disabled, onChange, recording]);

  useEffect(() => {
    if (disabled) {
      setRecording(false);
    }
  }, [disabled]);

  return (
    <div className="shortcut-recorder">
      <div className="shortcut-pills" aria-label="当前快捷键">
        {parts.map((part) => (
          <span key={part} className="shortcut-pill">
            {formatKeyLabel(part)}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="shortcut-recorder__btn"
        disabled={disabled}
        onClick={() => setRecording(true)}
      >
        {recording ? "请按下快捷键…" : "重新录制"}
      </button>
    </div>
  );
}
