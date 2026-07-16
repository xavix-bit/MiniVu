import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  createDefaultSettings,
  loadSettings,
  updateSettings,
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

export function ModelPreferencesPanel({ onSaved }: ModelPreferencesPanelProps) {
  const mountedRef = useRef(false);
  const unsupportedFallbackAttemptedRef = useRef(false);
  const [settings, setSettings] = useState<AppSettings>(createDefaultSettings());
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [deviceInfoLoading, setDeviceInfoLoading] = useState(true);
  const [deviceInfoError, setDeviceInfoError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [savingBackend, setSavingBackend] = useState(false);
  const [backendError, setBackendError] = useState("");
  const [installingMlx, setInstallingMlx] = useState(false);
  const [installError, setInstallError] = useState("");
  const [benchmark, setBenchmark] = useState<MirrorBenchmarkResponse | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const [sourceError, setSourceError] = useState("");

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
      } else {
        setDeviceInfoError("暂时无法检测设备，仍可使用默认方式。");
      }
      setDeviceInfoLoading(false);
    });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaveError("");
    try {
      const next = await updateSettings({ mlxModelId: settings.mlxModelId });
      if (!mountedRef.current) {
        return;
      }
      setSettings((current) => ({ ...current, mlxModelId: next.mlxModelId }));
      setSavedMessage("设置已保存");
      onSaved?.(next);
    } catch {
      if (mountedRef.current) {
        setSaveError("无法保存模型设置，请重试。");
      }
    }
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
    } catch {
      if (mountedRef.current) {
        setInstallError("无法安装加速组件，请重试。");
      }
    } finally {
      if (mountedRef.current) {
        setInstallingMlx(false);
      }
    }
  }

  async function changeBackend(inferenceBackend: AppSettings["inferenceBackend"]) {
    if (inferenceBackend === settings.inferenceBackend) {
      return;
    }
    setSavingBackend(true);
    setBackendError("");
    setSavedMessage("");
    try {
      const next = await updateSettings({ inferenceBackend });
      if (!mountedRef.current) {
        return;
      }
      setSettings((current) => ({
        ...current,
        inferenceBackend: next.inferenceBackend,
      }));
      onSaved?.(next);
    } catch {
      if (mountedRef.current) {
        setBackendError("无法保存问图方式，请重试。");
      }
    } finally {
      if (mountedRef.current) {
        setSavingBackend(false);
      }
    }
  }

  useEffect(() => {
    if (
      deviceInfo?.isAppleSilicon !== false ||
      settings.inferenceBackend !== "mlx" ||
      unsupportedFallbackAttemptedRef.current
    ) {
      return;
    }
    unsupportedFallbackAttemptedRef.current = true;
    void changeBackend("llama");
  }, [deviceInfo, settings.inferenceBackend]);

  async function changeDownloadSource(downloadMirror: AppSettings["downloadMirror"]) {
    setSavingSource(true);
    setSourceError("");
    try {
      const next = await updateSettings({ downloadMirror });
      if (!mountedRef.current) {
        return;
      }
      setSettings((current) => ({ ...current, downloadMirror: next.downloadMirror }));
      setSavedMessage("下载来源已保存");
      onSaved?.(next);
    } catch {
      if (mountedRef.current) {
        setSourceError("无法保存下载来源，请重试。");
      }
    } finally {
      if (mountedRef.current) {
        setSavingSource(false);
      }
    }
  }

  async function runBenchmark() {
    setBenchmarking(true);
    setBenchmarkError("");
    try {
      const result = await invoke<MirrorBenchmarkResponse>("benchmark_download_mirrors");
      const next = await updateSettings({
        preferredMirror: result.recommended,
        lastSpeedTestAt: String(result.testedAtUnix),
      });
      if (!mountedRef.current) {
        return;
      }
      setBenchmark(result);
      setSettings((current) => ({
        ...current,
        preferredMirror: next.preferredMirror,
        lastSpeedTestAt: next.lastSpeedTestAt,
      }));
      setSavedMessage("下载速度测试完成");
      onSaved?.(next);
    } catch {
      if (mountedRef.current) {
        setBenchmarkError("下载测速失败，请稍后重试。");
      }
    } finally {
      if (mountedRef.current) {
        setBenchmarking(false);
      }
    }
  }

  const supportsMlx = deviceInfo?.isAppleSilicon ?? false;
  const backend = settings.inferenceBackend;
  const isMlx = backend === "mlx";
  const showMlxOption = supportsMlx || isMlx;

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
            disabled={deviceInfoLoading || savingBackend}
            onChange={(event) => {
              const inferenceBackend = event.target.value as AppSettings["inferenceBackend"];
              void changeBackend(inferenceBackend);
            }}
          >
            <option value="llama">默认</option>
            {showMlxOption ? (
              <option value="mlx" disabled={!supportsMlx}>
                实验加速
              </option>
            ) : null}
          </select>
          {deviceInfoError ? <p className="field-hint">{deviceInfoError}</p> : null}
          {backendError ? <p className="onboarding-error">{backendError}</p> : null}
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
              disabled={savingSource}
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
            {sourceError ? <p className="onboarding-error">{sourceError}</p> : null}
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
                      <span>暂时无法测试此下载来源。</span>
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
        {saveError ? <p className="onboarding-error">{saveError}</p> : null}
      </div>
    </form>
  );
}
