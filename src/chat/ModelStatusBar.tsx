type ModelStatusBarProps = {
  visible: boolean;
  message: string;
  detail?: string;
  onStop?: () => void;
};

export function ModelStatusBar({ visible, message, detail, onStop }: ModelStatusBarProps) {
  if (!visible) {
    return null;
  }

  return (
    <div className="model-status-bar" role="status" aria-live="polite">
      <div className="model-status-bar__row">
        <span>{message}</span>
        {detail ? <span className="model-status-bar__detail">{detail}</span> : null}
        {onStop ? (
          <button type="button" className="model-status-bar__stop" onClick={onStop}>
            停止
          </button>
        ) : null}
      </div>
      <div className="model-status-bar__progress" aria-hidden="true" />
    </div>
  );
}
