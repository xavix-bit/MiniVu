import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../settings/settingsStore";

type ModelStatus = {
  modelReady: boolean;
  modelDownloaded: boolean;
  mmprojDownloaded: boolean;
  modelSize: string | null;
  sidecarRunning: boolean;
  llamaServerAvailable: boolean;
  inferenceBackend?: "llama" | "mlx";
  mlxRuntimeAvailable?: boolean;
  mlxModelReady?: boolean;
  activeBackend?: string;
};

type HomeOverviewProps = {
  modelReady: boolean;
  onOpenSetup: () => void;
  onOpenModel: () => void;
  onOpenSettings: () => void;
};

function runtimeLabel(status: ModelStatus | null) {
  if (status?.inferenceBackend === "mlx") {
    return status.mlxRuntimeAvailable ? "MLX 可用" : "MLX 未安装";
  }
  return status?.llamaServerAvailable ? "可用" : "未安装";
}

const STATUS_ITEMS = [
  { key: "server", label: "推理引擎", pick: (s: ModelStatus | null) => runtimeLabel(s) },
  {
    key: "model",
    label: "模型",
    pick: (s: ModelStatus | null) =>
      s?.inferenceBackend === "mlx"
        ? s.mlxModelReady
          ? "已就绪"
          : "未下载"
        : s?.modelDownloaded
          ? "已下载"
          : "未下载",
  },
  {
    key: "backend",
    label: "推理后端",
    pick: (s: ModelStatus | null) => s?.activeBackend ?? (s?.inferenceBackend === "mlx" ? "MLX" : "llama.cpp"),
  },
  { key: "sidecar", label: "推理进程", pick: (s: ModelStatus | null) => (s?.sidecarRunning ? "运行中" : "待唤起") },
] as const;

/** 仅统计「能否开始识图」的硬性条件，不含运行态指标 */
const READINESS_KEYS = new Set(["server", "model"]);

type DeviceInfo = {
  platform: string;
  isAppleSilicon: boolean;
  memoryGb: number;
  recommended: boolean;
  message: string;
};

function formatShortcut(shortcut: string) {
  return shortcut
    .replace("Control", "⌃")
    .replace("Option", "⌥")
    .replace("Command", "⌘")
    .replace("Shift", "⇧")
    .replace(/\+/g, " ");
}

function isPositive(value: string) {
  return (
    value === "已下载" ||
    value === "已就绪" ||
    value === "可用" ||
    value === "MLX 可用" ||
    value === "运行中"
  );
}

function isStatHighlight(key: string, value: string, environmentReady: boolean) {
  if (key === "backend") {
    return Boolean(value);
  }
  if (key === "sidecar") {
    return value === "运行中" || (environmentReady && value === "待唤起");
  }
  return isPositive(value);
}

export function HomeOverview({
  modelReady,
  onOpenSetup,
  onOpenModel,
  onOpenSettings,
}: HomeOverviewProps) {
  const [shortcut, setShortcut] = useState("Control+Option+Space");
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    void loadSettings().then((settings) => setShortcut(settings.shortcut));
    const timer = window.setTimeout(() => {
      void invoke<ModelStatus>("get_model_status").then(setStatus);
      void invoke<DeviceInfo>("get_device_info").then(setDeviceInfo);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [modelReady]);

  async function openQuickPanel() {
    await invoke("show_quick_panel");
  }

  const readinessItems = STATUS_ITEMS.filter((item) => READINESS_KEYS.has(item.key));
  const readinessDone = readinessItems.filter((item) => isPositive(item.pick(status))).length;
  const readinessTotal = readinessItems.length;
  const ringFull = modelReady || readinessDone === readinessTotal;
  const ringProgress = ringFull ? 1 : readinessDone / readinessTotal;

  return (
    <div className="settings-page settings-page--home">
      <header className="home-hero-header reveal">
        <div>
          <h1>本地识图，随时问答</h1>
          <p>
            {modelReady ? (
              <>
                按 <strong>{formatShortcut(shortcut)}</strong> 唤起识图面板，截图或粘贴图片即可提问
              </>
            ) : (
              "完成环境配置后，即可在本机进行视觉问答"
            )}
          </p>
        </div>
        {modelReady ? (
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void openQuickPanel()}>
            打开识图面板
          </button>
        ) : (
          <button type="button" className="settings-btn settings-btn--primary" onClick={onOpenSetup}>
            开始配置
          </button>
        )}
      </header>

      {!modelReady ? (
        <div className="ui-card ui-card--notice reveal reveal--1" role="status">
          <div>
            <p className="ui-card__title">环境尚未就绪</p>
            <p className="ui-card__desc">需要先安装推理引擎并下载视觉模型（约 2 GB）。</p>
          </div>
          <button type="button" className="settings-btn settings-btn--secondary" onClick={onOpenSetup}>
            去配置
          </button>
        </div>
      ) : null}

      <div className="home-dashboard reveal reveal--1">
        <section className="ui-card ui-card--hero" aria-label="使用概览">
          <div className="ui-card__top">
            <div>
              <p className="ui-card__eyebrow">当前状态</p>
              <p className="ui-card__headline">{modelReady ? "可以开始识图" : "等待环境配置"}</p>
            </div>
            <span className={`status-chip${modelReady ? " is-ready" : ""}`}>
              <span className="status-chip__dot" aria-hidden="true" />
              {modelReady ? "已就绪" : "未就绪"}
            </span>
          </div>

          <div
            className="home-hero-ring"
            role="img"
            aria-label={
              ringFull
                ? "环境已就绪"
                : `环境配置进度 ${readinessDone} / ${readinessTotal}`
            }
          >
            <svg viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" className="home-hero-ring__track" />
              <circle
                cx="60"
                cy="60"
                r="52"
                className={`home-hero-ring__progress${ringFull ? " is-complete" : ""}`}
                style={{ strokeDashoffset: `${327 - 327 * ringProgress}` }}
              />
            </svg>
            <div className="home-hero-ring__label">
              {ringFull ? (
                <>
                  <strong className="home-hero-ring__check" aria-hidden="true">
                    ✓
                  </strong>
                  <span>环境就绪</span>
                </>
              ) : (
                <>
                  <strong>{readinessDone}</strong>
                  <span>/ {readinessTotal}</span>
                </>
              )}
            </div>
          </div>

          <p className="ui-card__desc">
            {modelReady
              ? "推理引擎与模型已就绪。首次提问时会载入模型，进程显示「待唤起」属正常。"
              : "完成推理引擎安装与模型下载后即可开始识图。"}
          </p>

          {modelReady ? (
            <button type="button" className="ui-card__text-link" onClick={() => void openQuickPanel()}>
              立即识图 →
            </button>
          ) : null}
        </section>

        <div className="home-stat-grid" aria-label="环境指标">
          {STATUS_ITEMS.map((item) => {
            const value = item.pick(status);
            return (
              <article key={item.key} className="ui-card ui-card--stat">
                <span className="ui-card__stat-label">{item.label}</span>
                <strong className={isStatHighlight(item.key, value, modelReady) ? "is-positive" : undefined}>
                  {value}
                </strong>
              </article>
            );
          })}
        </div>

        <button type="button" className="ui-card ui-card--action" onClick={() => void openQuickPanel()} disabled={!modelReady}>
          <span className="ui-card__action-icon" aria-hidden="true">
            ⌘
          </span>
          <div>
            <p className="ui-card__title">快捷识图</p>
            <p className="ui-card__desc">
              {modelReady ? formatShortcut(shortcut) : "完成配置后可用"}
            </p>
          </div>
        </button>

        <button type="button" className="ui-card ui-card--action ui-card--tint-blue" onClick={onOpenModel}>
          <span className="ui-card__action-icon" aria-hidden="true">
            ◫
          </span>
          <div>
            <p className="ui-card__title">模型文件</p>
            <p className="ui-card__desc">
              {status?.modelSize ? `已占用 ${status.modelSize}` : "查看下载与管理"}
            </p>
          </div>
        </button>

        <button type="button" className="ui-card ui-card--action ui-card--tint-warm" onClick={onOpenSettings}>
          <span className="ui-card__action-icon" aria-hidden="true">
            ⚙
          </span>
          <div>
            <p className="ui-card__title">偏好设置</p>
            <p className="ui-card__desc">快捷键、预热与推理引擎</p>
          </div>
        </button>
      </div>

      <footer className="ui-card ui-card--footer reveal reveal--2">
        <p>
          {deviceInfo
            ? `${deviceInfo.message} · ${deviceInfo.platform} · ${deviceInfo.memoryGb.toFixed(1)} GB`
            : "正在读取设备信息…"}
        </p>
        <p className="ui-card__muted">MiniVu v0.1.0 · 数据不出本机</p>
      </footer>
    </div>
  );
}
