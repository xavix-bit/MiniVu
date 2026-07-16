import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
  type AppSettings,
  type MirrorBenchmarkResponse,
  type MirrorId,
} from "./settingsStore";

type DeviceInfo = {
  platform: string;
  isAppleSilicon: boolean;
  memoryGb: number;
  recommended: boolean;
  message: string;
};

type ModelPreferencesPanelProps = {
  onSaved?: (settings?: AppSettings) => void;
};

const DOWNLOAD_SOURCE_LABELS: Record<AppSettings["downloadMirror"], string> = {
  auto: "自动选择",
  modelscope: "ModelScope",
  huggingface: "HuggingFace",
};

function formatSourceName(source: MirrorId | null | undefined) {
  if (source === "modelscope") {
    return "ModelScope";
  }
  if (source === "huggingface") {
    return "HuggingFace";
  }
  return "—";
}

function mergeOwnedSettings(latest: AppSettings, draft: AppSettings): AppSettings {
  return {
    ...latest,
    inferenceBackend: draft.inferenceBackend,
    mlxModelId: draft.mlxModelId,
    downloadMirror: draft.downloadMirror,
    preferredMirror: draft.preferredMirror,
    lastSpeedTestAt: draft.lastSpeedTestAt,
  };
}

export function ModelPreferencesPanel({ onSaved }: ModelPreferencesPanelProps) {
  const mountedRef = useRef(false);
  const [settings, setSettings] = useState<AppSettings>(createDefaultSettings());
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [savedMessage, setSavedMessage] = useState("");
  const [installingMlx, setInstallingMlx] = useState(false);
  const [installError, setInstallError] = useState("");
  const [benchmark, setBenchmark] = useState<MirrorBenchmarkResponse | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState("");

  useEffect(() => {
    mountedRef.current = true;

    void Promise.allSettled([
      loadSettings(),
      invoke<DeviceInfo>("get_device_info"),
    ]).then(([loadedResult, deviceResult]) => {
      if (!mountedRef.current) {
        return;
      }
      if (loadedResult.status === "fulfilled") {
        setSettings(loadedResult.value);
      }
      if (deviceResult.status === "fulfilled") {
        setDeviceInfo(deviceResult.value);
      }
    });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    const latest = await loadSettings();
    const ownedDraft =
      deviceInfo?.isAppleSilicon === false
        ? { ...settings, inferenceBackend: "llama" as const }
        : settings;
    const next = mergeOwnedSettings(latest, ownedDraft);
    await saveSettings(next);
    if (!mountedRef.current) {
      return;
    }
    setSettings(next);
    setSavedMessage("设置已保存");
    onSaved?.(next);
  }

  async function installMlxRuntime() {
    setInstallingMlx(true);
    setInstallError("");
    try {
      await invoke("install_mlx_runtime_command");
      if (!mountedRef.current) {
        return;
      }
      setSavedMessage("加速组件已安装");
      onSaved?.();
    } catch (error) {
      if (mountedRef.current) {
        setInstallError(String(error));
      }
    } finally {
      if (mountedRef.current) {
        setInstallingMlx(false);
      }
    }
  }

  async function changeDownloadSource(downloadMirror: AppSettings["downloadMirror"]) {
    setSettings((current) => ({ ...current, downloadMirror }));
    const latest = await loadSettings();
    const next = { ...latest, downloadMirror };
    await saveSettings(next);
    if (!mountedRef.current) {
      return;
    }
    setSavedMessage("下载来源已保存");
    onSaved?.(next);
  }

  async function runBenchmark() {
    setBenchmarking(true);
    setBenchmarkError("");
    try {
      const result = await invoke<MirrorBenchmarkResponse>("benchmark_download_mirrors");
      const latest = await loadSettings();
      const next = {
        ...latest,
        preferredMirror: result.recommended,
        lastSpeedTestAt: String(result.testedAtUnix),
      };
      await saveSettings(next);
      if (!mountedRef.current) {
        return;
      }
      setBenchmark(result);
      setSettings((current) => ({
        ...current,
        preferredMirror: result.recommended,
        lastSpeedTestAt: String(result.testedAtUnix),
      }));
      setSavedMessage("下载速度测试完成");
      onSaved?.(next);
    } catch (error) {
      if (mountedRef.current) {
        setBenchmarkError(String(error));
      }
    } finally {
      if (mountedRef.current) {
        setBenchmarking(false);
      }
    }
  }

  const supportsMlx = deviceInfo?.isAppleSilicon ?? false;
  const backend = supportsMlx ? settings.inferenceBackend : "llama";
  const isMlx = backend === "mlx";

  return (
    <form
      className="settings-form settings-form--stack model-preferences-panel"
      aria-label="模型偏好"
      onSubmit={(event) => void handleSave(event)}
    >
      <section className="settings-section">
        <h2 className="settings-section__title">问图方式</h2>
        <label className="settings-field">
          <span>问图方式</span>
          <select
            value={backend}
            disabled={deviceInfo === null}
            onChange={(event) => {
              const inferenceBackend = event.target.value as AppSettings["inferenceBackend"];
              setSettings((current) => ({ ...current, inferenceBackend }));
            }}
          >
            <option value="llama">默认</option>
            {supportsMlx ? <option value="mlx">实验加速</option> : null}
          </select>
        </label>

        {isMlx ? (
          <>
            <label className="settings-field">
              <span>实验模型</span>
              <input
                value={settings.mlxModelId}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, mlxModelId: event.target.value }))
                }
                placeholder="mlx-community/MiniCPM-V-4.6-4bit"
              />
            </label>
            <div className="settings-field">
              <span>加速组件</span>
              <div className="settings-actions-row">
                <button
                  type="button"
                  className="settings-btn settings-btn--secondary"
                  disabled={installingMlx}
                  onClick={() => void installMlxRuntime()}
                >
                  {installingMlx ? "正在安装…" : "安装加速组件"}
                </button>
              </div>
              {installError ? <p className="onboarding-error">{installError}</p> : null}
            </div>
          </>
        ) : (
          <div className="settings-field">
            <label htmlFor="model-download-source">下载来源</label>
            <select
              id="model-download-source"
              value={settings.downloadMirror}
              onChange={(event) =>
                void changeDownloadSource(event.target.value as AppSettings["downloadMirror"])
              }
            >
              {(Object.keys(DOWNLOAD_SOURCE_LABELS) as AppSettings["downloadMirror"][]).map(
                (source) => (
                  <option key={source} value={source}>
                    {DOWNLOAD_SOURCE_LABELS[source]}
                  </option>
                ),
              )}
            </select>
            <div className="mirror-benchmark">
              <button
                type="button"
                className="settings-btn settings-btn--secondary"
                disabled={benchmarking}
                onClick={() => void runBenchmark()}
              >
                {benchmarking ? "正在测试…" : "测试下载速度"}
              </button>
              {settings.preferredMirror ? (
                <span className="field-hint">
                  优先使用 {formatSourceName(settings.preferredMirror)}
                </span>
              ) : null}
            </div>
            {benchmark ? (
              <ul className="mirror-benchmark__results" aria-label="下载速度结果">
                {benchmark.results.map((item) => (
                  <li
                    key={item.mirror}
                    className={`mirror-benchmark__item${item.ok ? "" : " is-error"}`}
                  >
                    <strong>{item.label}</strong>
                    {item.ok ? (
                      <span>
                        延迟 {item.latencyMs} ms · 下载 {item.speedMbps?.toFixed(1) ?? "—"} MB/s
                        {benchmark.recommended === item.mirror ? " · 推荐" : ""}
                      </span>
                    ) : (
                      <span>{item.error ?? "测试失败"}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {benchmarkError ? <p className="onboarding-error">{benchmarkError}</p> : null}
          </div>
        )}
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
