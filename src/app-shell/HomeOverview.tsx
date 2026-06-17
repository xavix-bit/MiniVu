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
          ? "首次识图下载"
          : "未下载"
        : s?.modelDownloaded
          ? "已下载"
          : "未下载",
  },
  {
    key: "mmproj",
    label: "后端",
    pick: (s: ModelStatus | null) => s?.activeBackend ?? (s?.inferenceBackend === "mlx" ? "MLX" : "llama.cpp"),
  },
  { key: "sidecar", label: "推理进程", pick: (s: ModelStatus | null) => (s?.sidecarRunning ? "运行中" : "空闲") },
] as const;

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
    value === "可用" ||
    value === "MLX 可用" ||
    value === "MLX 已就绪" ||
    value === "运行中"
  );
}

export function HomeOverview({ modelReady, onOpenSetup }: HomeOverviewProps) {
  const [shortcut, setShortcut] = useState("Control+Option+Space");
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    void loadSettings().then((settings) => setShortcut(settings.shortcut));
    void invoke<ModelStatus>("get_model_status").then(setStatus);
    void invoke<DeviceInfo>("get_device_info").then(setDeviceInfo);
  }, []);

  async function openQuickPanel() {
    await invoke("show_quick_panel");
  }

  return (
    <div className="settings-page settings-page--home">
      <header className="settings-page-header reveal">
        <div className="section-label">
          <span className="section-label__dot" aria-hidden="true" />
          <span className="section-label__text">本地识图</span>
        </div>
        <h1>
          <span className="settings-page-header__title-wrap">
            本地识图，<span className="gradient-text">即时问答</span>
            <span className="settings-page-header__underline" aria-hidden="true" />
          </span>
        </h1>
        <p>
          {modelReady
            ? <>按 <strong>{formatShortcut(shortcut)}</strong> 随时唤起识图面板</>
            : "完成环境配置后即可开始使用"}
        </p>
      </header>

      {!modelReady ? (
        <div className="callout callout--attention" role="status">
          <p>推理环境尚未就绪，需要先安装推理引擎并下载视觉模型。</p>
          <button type="button" className="callout__action" onClick={onOpenSetup}>
            开始配置
          </button>
        </div>
      ) : null}

      <section className="surface surface--elevated home-panel reveal reveal--1" aria-label="概览">
        <div className="home-panel__head">
          <div>
            <p className="home-panel__eyebrow">当前状态</p>
            <p className="home-panel__title">{modelReady ? "可以开始识图" : "等待环境配置"}</p>
          </div>
          <span className={`status-chip${modelReady ? " is-ready" : ""}`}>
            <span className="status-chip__dot" aria-hidden="true" />
            {modelReady ? "已就绪" : "未就绪"}
          </span>
        </div>

        <ul className="home-panel__metrics inverted-section">
          {STATUS_ITEMS.map((item) => {
            const value = item.pick(status);
            return (
              <li key={item.key}>
                <span>{item.label}</span>
                <strong className={isPositive(value) ? "is-positive" : undefined}>{value}</strong>
              </li>
            );
          })}
        </ul>

        <div className="home-panel__cta">
          {modelReady ? (
            <button type="button" className="settings-btn settings-btn--primary" onClick={() => void openQuickPanel()}>
              打开识图面板
            </button>
          ) : (
            <button type="button" className="settings-btn settings-btn--primary" onClick={onOpenSetup}>
              一键配置环境
            </button>
          )}
        </div>

        <footer className="home-panel__meta">
          <p>
            {deviceInfo
              ? `${deviceInfo.message} · ${deviceInfo.platform} · ${deviceInfo.memoryGb.toFixed(1)} GB`
              : "正在读取设备信息…"}
            {status?.modelSize ? ` · 模型 ${status.modelSize}` : ""}
          </p>
          <p>图片与对话仅保留在本机，仅在下载模型时使用网络。</p>
        </footer>
      </section>
    </div>
  );
}
