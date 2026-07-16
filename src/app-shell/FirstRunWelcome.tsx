import { ExternalLink, LoaderCircle, ScanLine } from "lucide-react";

export type FirstRunWelcomeState =
  | { kind: "idle"; notice?: "capture-failed" | "save-failed" }
  | { kind: "capturing" }
  | { kind: "skipping" }
  | { kind: "permission-denied"; settingsOpenFailed?: boolean };

export type FirstRunWelcomeProps = {
  shortcut: string;
  state: FirstRunWelcomeState;
  onCapture: () => void;
  onSkip: () => void;
  onOpenScreenRecordingSettings: () => void;
};

function formatShortcut(shortcut: string) {
  return shortcut
    .split("+")
    .map((part) => {
      switch (part) {
        case "Control": return "⌃";
        case "Option":
        case "Alt": return "⌥";
        case "Command":
        case "Cmd":
        case "Super": return "⌘";
        case "Shift": return "⇧";
        case "Space": return "Space";
        default: return part;
      }
    })
    .join("");
}

export function FirstRunWelcome({
  shortcut,
  state,
  onCapture,
  onSkip,
  onOpenScreenRecordingSettings,
}: FirstRunWelcomeProps) {
  const pending = state.kind === "capturing" || state.kind === "skipping";
  const permissionDenied = state.kind === "permission-denied";
  const notice = state.kind === "idle" && state.notice === "capture-failed"
    ? "截图没有保存，请重试。"
    : state.kind === "idle" && state.notice === "save-failed"
      ? "暂时无法保存设置，请重试。"
      : null;

  return (
    <main className="first-run-welcome" aria-labelledby="first-run-title">
      <div className="first-run-welcome__crop" aria-hidden="true">
        <span className="first-run-welcome__corner first-run-welcome__corner--tl" />
        <span className="first-run-welcome__corner first-run-welcome__corner--tr" />
        <span className="first-run-welcome__corner first-run-welcome__corner--bl" />
        <span className="first-run-welcome__corner first-run-welcome__corner--br" />
      </div>

      <div className="first-run-welcome__content">
        <ScanLine className="first-run-welcome__icon" size={28} aria-hidden="true" />
        <h1 id="first-run-title">从一张截图开始</h1>
        <p>
          {permissionDenied
            ? "允许屏幕录制后，就可以继续截图。"
            : "框选屏幕上的内容，MiniVu 会把它保存到工作台。"}
        </p>

        {notice ? <div className="first-run-welcome__notice" role="status">{notice}</div> : null}
        {permissionDenied && state.settingsOpenFailed ? (
          <div className="first-run-welcome__permission" role="status">
            <span>系统设置没有打开，请手动打开后重试。</span>
          </div>
        ) : null}

        <div className="first-run-welcome__actions">
          {permissionDenied ? (
            <>
              <button
                type="button"
                className="first-run-welcome__primary"
                onClick={onOpenScreenRecordingSettings}
              >
                <ExternalLink size={17} aria-hidden="true" />
                打开系统设置
              </button>
              <button type="button" className="first-run-welcome__secondary" onClick={onCapture}>
                重试
              </button>
            </>
          ) : (
            <button
              type="button"
              className="first-run-welcome__primary"
              disabled={pending}
              onClick={onCapture}
            >
              {state.kind === "capturing" ? (
                <LoaderCircle className="is-spinning" size={17} aria-hidden="true" />
              ) : (
                <ScanLine size={17} aria-hidden="true" />
              )}
              {state.kind === "capturing" ? "正在截图" : "开始截图"}
            </button>
          )}
          {permissionDenied ? null : (
            <kbd aria-label={`快捷键 ${shortcut}`}>{formatShortcut(shortcut)}</kbd>
          )}
        </div>

        {permissionDenied ? null : (
          <button
            type="button"
            className="first-run-welcome__skip"
            disabled={pending}
            onClick={onSkip}
          >
            {state.kind === "skipping" ? "正在进入" : "稍后进入"}
          </button>
        )}
      </div>
    </main>
  );
}
