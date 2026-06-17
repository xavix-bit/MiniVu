import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
  type AppSettings,
  type MirrorBenchmarkResponse,
  type MirrorId,
} from "./settingsStore";
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

const MIRROR_LABELS: Record<AppSettings["downloadMirror"], string> = {
  auto: "自动（失败时切换备用源）",
  modelscope: "仅 ModelScope（国内镜像）",
  huggingface: "仅 HuggingFace（海外源）",
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

  const isMlx = (settings.inferenceBackend ?? "mlx") === "mlx";

  useEffect(() => {
    void loadSettings().then(setSettings);
    void invoke<DeviceInfo>("get_device_info").then(setDeviceInfo);

    let unlisten: (() => void) | undefined;
    void listen<{ file: string; percent?: number; status?: string }>("model-download-progress", (event) => {
      if (event.payload.file !== "mlx") {
        return;
      }
      if (event.payload.status === "done") {
        setMlxDownloadPercent(100);
        setDownloadingMlx(false);
      } else if (typeof event.payload.percent === "number") {
        setMlxDownloadPercent(event.payload.percent);
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
    await saveSettings(settings);
    setSavedMessage("设置已保存");
    onSaved?.();
  }

  async function pickDirectory(kind: "gguf" | "mlx") {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: kind === "mlx" ? "选择 MLX 模型目录" : "选择 GGUF 模型目录",
    });
    if (typeof selected === "string") {
      setSettings((current) =>
        kind === "mlx"
          ? { ...current, mlxModelPath: selected }
          : { ...current, modelPath: selected },
      );
    }
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
      setSavedMessage("测速完成，推荐镜像已保存");
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
    } catch (error) {
      setMlxDownloadError(String(error));
    } finally {
      setDownloadingMlx(false);
    }
  }

  return (
    <form className="settings-card settings-form" aria-label="设置" onSubmit={(event) => void handleSave(event)}>
      {deviceInfo ? (
        <p className="device-info">
          {deviceInfo.message}（{deviceInfo.platform} · {deviceInfo.memoryGb.toFixed(1)} GB）
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
          <h2 className="settings-section__title">推理引擎</h2>
          <label className="settings-field">
            <span>后端</span>
            <select
              value={settings.inferenceBackend ?? "mlx"}
              onChange={(event) => {
                const inferenceBackend = event.target.value as AppSettings["inferenceBackend"];
                setSettings((current) => ({ ...current, inferenceBackend }));
              }}
            >
              <option value="mlx">MLX（Apple Silicon 推荐）</option>
              <option value="llama">llama.cpp（GGUF）</option>
            </select>
            <span className="field-hint">
              {isMlx
                ? "MLX 使用原生 Unified Memory，识图通常更快。需先安装引擎并下载 MLX 权重（约 2 GB）。"
                : "使用 GGUF 主模型 + mmproj，适合已有 6 GB 模型文件或需跨平台时。"}
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

              <label className="settings-field">
                <span>本地 MLX 目录（可选）</span>
                <div className="path-picker">
                  <input
                    value={settings.mlxModelPath ?? ""}
                    placeholder="留空则从 HuggingFace 下载到缓存"
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        mlxModelPath: event.target.value || null,
                      }))
                    }
                  />
                  <button type="button" onClick={() => void pickDirectory("mlx")}>
                    选择目录
                  </button>
                </div>
              </label>

              <div className="settings-field">
                <span>MLX 环境</span>
                <div className="settings-actions-row">
                  <button
                    type="button"
                    className="settings-btn settings-btn--secondary"
                    disabled={installingMlx}
                    onClick={() => void installMlxRuntime()}
                  >
                    {installingMlx ? "安装中…" : "1. 安装推理引擎"}
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
                <span className="field-hint">请先安装引擎，再下载权重。下载完成后识图时只需载入内存（约 30–60 秒）。</span>
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
            <option value={-1}>永不卸载（推荐）</option>
          </select>
          <span className="field-hint">
            卸载后下次提问需重新载入模型。内存紧张时可改为 15 或 30 分钟。
          </span>
        </label>

        <label className="settings-field settings-field--checkbox">
          <input
            type="checkbox"
            checked={settings.preloadModel ?? true}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                preloadModel: event.target.checked,
              }))
            }
          />
          <span>打开应用时后台预热模型</span>
          <span className="field-hint">
            {isMlx
              ? "启动后预载入 MLX 模型到内存，首次提问更快（约占用 2–3 GB）。"
              : "启动后预载入 GGUF 模型到内存，首次提问更快（约占用 6 GB）。"}
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
            <span className="field-hint">
              用于「模型文件」页的 GGUF 下载。测速约下载 4MB 样本，需联网。
            </span>
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

          <label className="settings-field">
            <span>手动 GGUF 路径（可选）</span>
            <div className="path-picker">
              <input
                value={settings.modelPath ?? ""}
                placeholder="包含主模型与 mmproj 的目录，或主模型 .gguf 文件"
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    modelPath: event.target.value || null,
                  }))
                }
              />
              <button type="button" onClick={() => void pickDirectory("gguf")}>
                选择目录
              </button>
            </div>
          </label>
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
