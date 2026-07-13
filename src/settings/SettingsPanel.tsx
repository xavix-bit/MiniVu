import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
  type AppSettings,
  type InferenceBackend,
  type MirrorBenchmarkResponse,
  type MirrorId,
} from "./settingsStore";
import { resolveMlxPercent } from "../shared/downloadProgress";
import { ShortcutRecorder } from "./shortcutRecorder";
import { applyTheme } from "../theme/applyTheme";
import { settingsThemeToMode } from "../theme/useAppTheme";

type DeviceInfo = {
  platform: string;
  isAppleSilicon: boolean;
  memoryGb: number;
  recommended: boolean;
  message: string;
};

type SettingsPanelProps = {
  onSaved?: () => void;
};

function backendLabel(backend: InferenceBackend) {
  return backend === "mlx" ? "兼容模式" : "标准模式";
}

function safeSettingsError(action: "speed" | "install" | "download"): string {
  if (action === "speed") return "测速未完成，请检查网络后重试。";
  if (action === "install") return "安装未完成，请重新启动应用后重试。";
  return "下载未完成，请检查网络和可用空间后重试。";
}

const MIRROR_LABELS: Record<AppSettings["downloadMirror"], string> = {
  auto: "自动切换",
  modelscope: "ModelScope",
  huggingface: "HuggingFace",
};

function formatMirrorName(mirror: MirrorId | null | undefined) {
  if (mirror === "modelscope") {
    return "ModelScope";
  }
  if (mirror === "huggingface") {
    return "HuggingFace";
  }
  return "—";
}

export function SettingsPanel({ onSaved }: SettingsPanelProps) {
  const [settings, setSettings] = useState<AppSettings>(createDefaultSettings());
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [savedMessage, setSavedMessage] = useState("");
  const [benchmark, setBenchmark] = useState<MirrorBenchmarkResponse | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState("");
  const [installingMlx, setInstallingMlx] = useState(false);
  const [downloadingMlx, setDownloadingMlx] = useState(false);
  const [mlxInstallError, setMlxInstallError] = useState("");
  const [mlxDownloadError, setMlxDownloadError] = useState("");
  const [mlxDownloadPercent, setMlxDownloadPercent] = useState<number | null>(null);
  const [savedBackend, setSavedBackend] = useState<AppSettings["inferenceBackend"]>("llama");

  const isMlx = (settings.inferenceBackend ?? "llama") === "mlx";
  const backendDirty = (settings.inferenceBackend ?? "llama") !== savedBackend;

  useEffect(() => {
    void loadSettings().then((loaded) => {
      setSettings(loaded);
      setSavedBackend(loaded.inferenceBackend ?? "llama");
    });
    void invoke<DeviceInfo>("get_device_info").then(setDeviceInfo);

    let unlisten: (() => void) | undefined;
    void listen<{ file: string; percent?: number; status?: string; downloaded?: number }>(
      "model-download-progress",
      (event) => {
      if (event.payload.file !== "mlx") {
        return;
      }
      if (event.payload.status === "done") {
        setMlxDownloadPercent(100);
        setDownloadingMlx(false);
      } else {
        setMlxDownloadPercent((prev) =>
          resolveMlxPercent(prev ?? 0, event.payload.downloaded ?? 0),
        );
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const previousBackend = savedBackend;
    await saveSettings(settings);
    setSavedBackend(settings.inferenceBackend ?? "llama");
    if (previousBackend !== (settings.inferenceBackend ?? "llama")) {
      setSavedMessage(
        `已切换为 ${backendLabel(settings.inferenceBackend ?? "llama")}。`,
      );
    } else {
      setSavedMessage("设置已保存");
    }
    onSaved?.();
  }

  async function runBenchmark() {
    setBenchmarking(true);
    setBenchmarkError("");
    try {
      const result = await invoke<MirrorBenchmarkResponse>("benchmark_download_mirrors");
      setBenchmark(result);
      setSettings((current) => {
        const next = {
          ...current,
          preferredMirror: result.recommended,
          lastSpeedTestAt: String(result.testedAtUnix),
        };
        void saveSettings(next);
        return next;
      });
      setSavedMessage("测速完成");
    } catch {
      setBenchmarkError(safeSettingsError("speed"));
    } finally {
      setBenchmarking(false);
    }
  }

  async function installMlxRuntime() {
    setInstallingMlx(true);
    setMlxInstallError("");
    try {
      await invoke("install_mlx_runtime_command");
      setSavedMessage("兼容处理组件已安装");
    } catch {
      setMlxInstallError(safeSettingsError("install"));
    } finally {
      setInstallingMlx(false);
    }
  }

  async function downloadMlxModel() {
    setDownloadingMlx(true);
    setMlxDownloadError("");
    setMlxDownloadPercent(0);
    try {
      await saveSettings(settings);
      await invoke("download_mlx_model", { force: false });
      setSavedMessage("兼容模式所需内容已下载");
      onSaved?.();
    } catch {
      setMlxDownloadError(safeSettingsError("download"));
    } finally {
      setDownloadingMlx(false);
    }
  }

  return (
    <form className="settings-form settings-form--stack" aria-label="设置" onSubmit={(event) => void handleSave(event)}>
      {deviceInfo ? (
        <p className="callout callout--info settings-device-info">
          {deviceInfo.recommended ? "这台设备适合本机处理" : "这台设备可以使用，处理速度可能较慢"}
          （{deviceInfo.platform} · {deviceInfo.memoryGb.toFixed(1)} GB）
        </p>
      ) : null}

      <section className="settings-section">
        <h2 className="settings-section__title">外观与快捷</h2>
        <label className="settings-field">
          <span>外观主题</span>
          <select
            value={settings.theme ?? "system"}
            onChange={(event) => {
              const theme = event.target.value as AppSettings["theme"];
              setSettings((current) => ({ ...current, theme }));
              applyTheme(settingsThemeToMode(theme));
            }}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>

        <label className="settings-field">
          <span>全局快捷键</span>
          <ShortcutRecorder
            value={settings.shortcut}
            onChange={(shortcut) => setSettings((current) => ({ ...current, shortcut }))}
          />
        </label>
      </section>

      {deviceInfo?.isAppleSilicon ? (
        <section className="settings-section">
          <h2 className="settings-section__title">本机处理</h2>
          <div className="settings-field">
            <span>处理方式</span>
            <strong>{backendLabel(settings.inferenceBackend ?? "llama")}</strong>
            <span className="field-hint">标准模式适合大多数设备。</span>
          </div>

          <details className="settings-advanced">
            <summary>高级设置</summary>
            <label className="settings-field">
              <span>兼容模式</span>
              <select
                value={settings.inferenceBackend ?? "llama"}
                onChange={(event) => {
                  const inferenceBackend = event.target.value as AppSettings["inferenceBackend"];
                  setSettings((current) => ({ ...current, inferenceBackend }));
                }}
              >
                <option value="llama">标准（llama / Metal）</option>
                <option value="mlx">MLX 实验模式</option>
              </select>
              <span className="field-hint">
                仅在标准模式无法使用时切换。{backendDirty ? " 更改后请保存设置。" : ""}
              </span>
            </label>

            {isMlx ? (
              <>
                <label className="settings-field">
                  <span>模型 ID</span>
                  <input
                    value={settings.mlxModelId ?? "mlx-community/MiniCPM-V-4.6-4bit"}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, mlxModelId: event.target.value }))
                    }
                    placeholder="mlx-community/MiniCPM-V-4.6-4bit"
                  />
                </label>

                <div className="settings-field">
                  <span>MLX 实验内容</span>
                  <div className="settings-actions-row">
                    <button type="button" className="settings-btn settings-btn--secondary" disabled={installingMlx} onClick={() => void installMlxRuntime()}>
                      {installingMlx ? "安装中…" : "1. 安装兼容组件"}
                    </button>
                    <button type="button" className="settings-btn settings-btn--primary" disabled={downloadingMlx} onClick={() => void downloadMlxModel()}>
                      {downloadingMlx
                        ? `2. 下载内容${mlxDownloadPercent !== null ? ` ${mlxDownloadPercent}%` : "…"}`
                        : "2. 下载所需内容"}
                    </button>
                  </div>
                  {mlxInstallError ? <p className="onboarding-error">{mlxInstallError}</p> : null}
                  {mlxDownloadError ? <p className="onboarding-error">{mlxDownloadError}</p> : null}
                </div>
              </>
            ) : null}
          </details>
        </section>
      ) : null}

      <section className="settings-section">
        <h2 className="settings-section__title">性能</h2>
        <label className="settings-field">
          <span>保持快速响应（分钟）</span>
          <select
            value={settings.modelWarmMinutes}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                modelWarmMinutes: Number(event.target.value) as AppSettings["modelWarmMinutes"],
              }))
            }
          >
            <option value={5}>5</option>
            <option value={15}>15</option>
            <option value={30}>30</option>
            <option value={-1}>始终保持</option>
          </select>
          <span className="field-hint">时间越长，下次响应越快。</span>
        </label>

        <label className="settings-field settings-field--checkbox">
          <input
            type="checkbox"
            checked={settings.preloadModel ?? false}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                preloadModel: event.target.checked,
              }))
            }
          />
          <span>启动时提前准备</span>
          <span className="field-hint">
            {deviceInfo && deviceInfo.memoryGb < 16
              ? "内存不足 16 GB，建议关闭。"
              : "打开应用后即可更快开始处理；会使用更多内存。"}
          </span>
        </label>
      </section>

      <section className="settings-section">
          <h2 className="settings-section__title">下载设置</h2>
          <div className="settings-field">
            <span>下载来源</span>
            <select
              value={settings.downloadMirror}
              onChange={(event) => {
                const downloadMirror = event.target.value as AppSettings["downloadMirror"];
                setSettings((current) => {
                  const next = { ...current, downloadMirror };
                  void saveSettings(next);
                  return next;
                });
                setSavedMessage("下载来源已保存");
              }}
            >
              {(Object.keys(MIRROR_LABELS) as AppSettings["downloadMirror"][]).map((key) => (
                <option key={key} value={key}>
                  {MIRROR_LABELS[key]}
                </option>
              ))}
            </select>
            <span className="field-hint">测速需联网。</span>
            <div className="mirror-benchmark">
              <button
                type="button"
                className="settings-btn settings-btn--secondary"
                disabled={benchmarking}
                onClick={() => void runBenchmark()}
              >
                {benchmarking ? "测速中…" : "测试下载速度"}
              </button>
              {settings.preferredMirror ? (
                <span className="field-hint">
                  推荐优先：{formatMirrorName(settings.preferredMirror)}
                  {settings.lastSpeedTestAt
                    ? ` · 最近测速 ${new Date(Number(settings.lastSpeedTestAt) * 1000).toLocaleString()}`
                    : ""}
                </span>
              ) : null}
            </div>
            {benchmark ? (
              <ul className="mirror-benchmark__results" aria-label="镜像测速结果">
                {benchmark.results.map((item) => (
                  <li key={item.mirror} className={`mirror-benchmark__item${item.ok ? "" : " is-error"}`}>
                    <strong>{item.label}</strong>
                    {item.ok ? (
                      <span>
                        延迟 {item.latencyMs} ms · 样本 {item.speedMbps?.toFixed(1)} MB/s
                        {benchmark.recommended === item.mirror ? " · 推荐" : ""}
                      </span>
                    ) : (
                      <span>暂时无法连接</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {benchmarkError ? <p className="onboarding-error">{benchmarkError}</p> : null}
          </div>
        </section>

      <div className="settings-form__footer">
        <button type="submit" className="settings-btn settings-btn--primary">
          保存设置
        </button>
        {savedMessage ? <p className="saved-message">{savedMessage}</p> : null}
      </div>
    </form>
  );
}
