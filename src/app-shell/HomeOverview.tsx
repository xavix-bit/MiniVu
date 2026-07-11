import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { environmentReadinessPercent, type EnvironmentStatus } from "../model/types";
import { loadSettings } from "../settings/settingsStore";

type HomeOverviewProps = {
  environmentStatus: EnvironmentStatus | null;
  onOpenSetup: () => void;
  onOpenModel: () => void;
  onOpenSettings: () => void;
};

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

export function HomeOverview({
  environmentStatus,
  onOpenSetup,
  onOpenModel,
  onOpenSettings,
}: HomeOverviewProps) {
  const [shortcut, setShortcut] = useState("Control+Option+Space");
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);

  const environmentReady = environmentStatus?.environmentReady ?? false;
  const runtimeReady = environmentStatus?.runtimeReady ?? false;
  const modelReady = environmentStatus?.modelReady ?? false;
  const readinessPercent = environmentStatus
    ? environmentReadinessPercent(environmentStatus)
    : 0;
  const backendLabel = environmentStatus?.inferenceBackend === "mlx" ? "MLX" : "内置 Metal";
  const modelLabel =
    environmentStatus?.inferenceBackend === "mlx" ? "MiniCPM-V MLX 权重" : "MiniCPM-V 4.6 GGUF";

  useEffect(() => {
    void loadSettings().then((settings) => setShortcut(settings.shortcut));
    const timer = window.setTimeout(() => {
      void invoke<DeviceInfo>("get_device_info").then(setDeviceInfo);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [environmentStatus]);

  async function openQuickPanel() {
    await invoke("show_quick_panel");
  }

  const statusRows = [
    {
      label: "引擎",
      value: runtimeReady ? "可用" : environmentStatus ? "待配置" : "检测中",
      ready: runtimeReady,
    },
    {
      label: "模型",
      value: modelReady ? "已下载" : environmentStatus ? "待下载" : "检测中",
      ready: modelReady,
    },
    {
      label: "快捷键",
      value: formatShortcut(shortcut),
      ready: true,
    },
    {
      label: "设备",
      value: deviceInfo
        ? `${deviceInfo.platform} · ${deviceInfo.memoryGb.toFixed(1)} GB`
        : "检测中",
      ready: deviceInfo?.recommended ?? false,
    },
  ];

  return (
    <div className="home-overview home-overview--console">
      <section className="home-console-hero">
        <div className="home-console-hero__copy">
          <span className={`home-console-status${environmentReady ? " is-ready" : ""}`}>
            {environmentReady ? "可以开始" : "需要配置"}
          </span>
          <h1>截完图，马上读懂屏幕</h1>
          <p>截图、识字、翻译、问图，一个面板完成。</p>
          <div className="home-console-hero__actions">
            <button
              type="button"
              className="home-primary-button"
              onClick={environmentReady ? () => void openQuickPanel() : onOpenSetup}
            >
              {environmentReady ? "打开快捷面板" : "完成本地配置"}
            </button>
            <button type="button" className="home-secondary-button" onClick={onOpenModel}>
              管理模型文件
            </button>
          </div>
        </div>

        <aside className="home-command-card" aria-label="环境就绪度">
          <span className="home-command-card__label">本地环境</span>
          <div>
            <strong>{readinessPercent}%</strong>
            <p>{environmentReady ? `${backendLabel} 可用` : "待配置"}</p>
          </div>
          <div className="home-command-card__bar" aria-hidden="true">
            <span style={{ width: `${readinessPercent}%` }} />
          </div>
        </aside>
      </section>

      <section className="home-workbench">
        <article className="home-workflow-card">
          <div className="home-card-heading">
            <span>工作区</span>
            <h2>本次会话</h2>
          </div>
          <div className="home-empty-state">
            <strong>还没有识别结果</strong>
            <button type="button" onClick={() => void openQuickPanel()}>
              进入面板
            </button>
          </div>
        </article>

        <aside className="home-status-panel">
          <div className="home-card-heading">
            <span>状态</span>
            <h2>当前配置</h2>
          </div>
          <div className="home-status-list">
            {statusRows.map((row) => (
              <div key={row.label} className="home-status-row">
                <strong>{row.label}</strong>
                <span className={row.ready ? "is-ready" : ""}>{row.value}</span>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section className="home-workbench">
        <article className="home-workflow-card">
          <div className="home-card-heading">
            <span>能力</span>
            <h2>主要入口</h2>
          </div>
          <ol className="home-flow-list">
            <li>
              <span>01</span>
              <div>
                <strong>截图或拖入图片</strong>
                <p>框选、粘贴、拖入都可以。</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>本机 OCR 与图片问答</strong>
                <p>识字后继续追问。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>按需导出 Markdown</strong>
                <p>需要时再导出。</p>
              </div>
            </li>
          </ol>
        </article>

        <aside className="home-status-panel">
          <div className="home-card-heading">
            <span>模型</span>
            <h2>{backendLabel}</h2>
          </div>
          <div className="home-model-summary">
            <strong>{modelLabel}</strong>
            <p>{modelReady ? "可用" : "待下载"}</p>
            <button type="button" onClick={modelReady ? onOpenModel : onOpenSetup}>
              {modelReady ? "查看模型" : "去配置"}
            </button>
          </div>
        </aside>
      </section>

      <section className="home-action-grid" aria-label="快捷操作">
        <button type="button" className="home-action-tile home-action-tile--primary" onClick={() => void openQuickPanel()}>
          <span>OCR</span>
          <strong>截图识别</strong>
          <em>截取区域并提取文字</em>
        </button>
        <button type="button" className="home-action-tile" disabled={!environmentReady} onClick={() => void openQuickPanel()}>
          <span>Translate</span>
          <strong>截图翻译</strong>
          <em>{environmentReady ? "识别后继续翻译" : "配置完成后可用"}</em>
        </button>
        <button type="button" className="home-action-tile" disabled={!environmentReady} onClick={() => void openQuickPanel()}>
          <span>Ask</span>
          <strong>图片问答</strong>
          <em>{environmentReady ? "围绕截图继续问" : "配置完成后可用"}</em>
        </button>
        <button type="button" className="home-action-tile" onClick={onOpenSettings}>
          <span>Shortcut</span>
          <strong>{formatShortcut(shortcut)}</strong>
          <em>调整唤起方式</em>
        </button>
      </section>

      <footer className="home-footer home-footer--console">
        <p>
          {deviceInfo
            ? deviceInfo.message
            : "正在读取设备信息…"}
        </p>
      </footer>
    </div>
  );
}
