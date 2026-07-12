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
  return backend === "mlx" ? "MLX 实验加速" : "内置 Metal 本地推理";
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
    } catch (error) {
      setBenchmarkError(String(error));
    } finally {
      setBenchmarking(false);
    }
  }

  async function installMlxRuntime() {
    setInstallingMlx(true);
    setMlxInstallError("");
    try {
      await invoke("install_mlx_runtime_command");
      setSavedMessage("MLX 推理引擎已安装");
    } catch (error) {
      setMlxInstallError(String(error));
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
      setSavedMessage("MLX 模型权重已下载");
      onSaved?.();
    } catch (error) {
      setMlxDownloadError(String(error));
    } finally {
      setDownloadingMlx(false);
    }
  }

  return (
    <form className="settings-form settings-form--stack" aria-label="设置" onSubmit={(event) => void handleSave(event)}>
      {deviceInfo ? (
        <p className="callout callout--info settings-device-info">{deviceInfo.message}（{deviceInfo.platform} · {deviceInfo.memoryGb.toFixed(1)} GB）</p>
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
          <h2 className="settings-section__title">本地推理</h2>
          <label className="settings-field">
            <span>推理模式</span>
            <select
              value={settings.inferenceBackend ?? "llama"}
              onChange={(event) => {
                const inferenceBackend = event.target.value as AppSettings["inferenceBackend"];
                setSettings((current) => ({ ...current, inferenceBackend }));
              }}
            >
              <option value="llama">内置 Metal</option>
              <option value="mlx">MLX 实验加速</option>
            </select>
            <span className="field-hint">
              {isMlx
                ? "需额外安装。"
                : "默认。"}
              {backendDirty ? " 改完后需点底部「保存设置」。" : ""}
            </span>
          </label>

          {isMlx ? (
            <>
              <label className="settings-field">
                <span>MLX 模型 ID</span>
                <input
                  value={settings.mlxModelId ?? "mlx-community/MiniCPM-V-4.6-4bit"}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, mlxModelId: event.target.value }))
                  }
                  placeholder="mlx-community/MiniCPM-V-4.6-4bit"
                />
              </label>

              <div className="settings-field">
                <span>MLX 实验环境</span>
                <div className="settings-actions-row">
                  <button
                    type="button"
                    className="settings-btn settings-btn--secondary"
                    disabled={installingMlx}
                    onClick={() => void installMlxRuntime()}
                  >
                    {installingMlx ? "安装中…" : "1. 安装实验加速包"}
                  </button>
                  <button
                    type="button"
                    className="settings-btn settings-btn--primary"
                    disabled={downloadingMlx}
                    onClick={() => void downloadMlxModel()}
                  >
                    {downloadingMlx
                      ? `2. 下载模型${mlxDownloadPercent !== null ? ` ${mlxDownloadPercent}%` : "…"}`
                      : "2. 下载模型权重"}
                  </button>
                </div>
                {mlxInstallError ? <p className="onboarding-error">{mlxInstallError}</p> : null}
                {mlxDownloadError ? <p className="onboarding-error">{mlxDownloadError}</p> : null}
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="settings-section">
        <h2 className="settings-section__title">性能</h2>
        <label className="settings-field">
          <span>模型保活时间（分钟）</span>
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
            <option value={-1}>永不卸载</option>
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
          <span>启动时预加载模型</span>
          <span className="field-hint">
            {deviceInfo && deviceInfo.memoryGb < 16
              ? "内存不足 16 GB，建议关闭。"
              : isMlx
                ? "启动后会常驻内存；实际占用随模型和对话长度变化。"
                : "启动后会常驻内存；实际占用随模型档位、图片和对话长度变化。"}
          </span>
        </label>
      </section>

      {!isMlx ? (
        <section className="settings-section">
          <h2 className="settings-section__title">GGUF 模型与下载</h2>
          <div className="settings-field">
            <span>模型下载镜像</span>
            <select
              value={settings.downloadMirror}
              onChange={(event) => {
                const downloadMirror = event.target.value as AppSettings["downloadMirror"];
                setSettings((current) => {
                  const next = { ...current, downloadMirror };
                  void saveSettings(next);
                  return next;
                });
                setSavedMessage("镜像设置已保存");
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
                {benchmarking ? "测速中…" : "测速镜像"}
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
                      <span>{item.error ?? "测速失败"}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {benchmarkError ? <p className="onboarding-error">{benchmarkError}</p> : null}
          </div>
        </section>
      ) : null}

      <div className="settings-form__footer">
        <button type="submit" className="settings-btn settings-btn--primary">
          保存设置
        </button>
        {savedMessage ? <p className="saved-message">{savedMessage}</p> : null}
      </div>
    </form>
  );
}
