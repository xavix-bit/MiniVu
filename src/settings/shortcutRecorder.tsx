import { useEffect, useState } from "react";

type ShortcutRecorderProps = {
  value: string;
  onChange: (value: string) => void;
};

export function ShortcutRecorder({ value, onChange }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      const parts: string[] = [];
      if (event.metaKey) parts.push("Command");
      if (event.ctrlKey) parts.push("Control");
      if (event.altKey) parts.push("Option");
      if (event.shiftKey) parts.push("Shift");

      const key = event.key;
      if (!["Meta", "Control", "Alt", "Shift"].includes(key)) {
        parts.push(key.length === 1 ? key.toUpperCase() : key);
      }

      if (parts.length > 1) {
        onChange(parts.join("+"));
        setRecording(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onChange, recording]);

  return (
    <div className="shortcut-recorder">
      <input readOnly value={value} />
      <button type="button" onClick={() => setRecording(true)}>
        {recording ? "请按下快捷键…" : "录制"}
      </button>
    </div>
  );
}
