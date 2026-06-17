import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveGgufPercent } from "../shared/downloadProgress";
import { EXPECTED_GGUF_BYTES } from "../shared/modelConstants";

type ModelStatus = {
  modelReady: boolean;
  modelDownloaded: boolean;
  mmprojDownloaded: boolean;
  modelPath: string;
  mmprojPath: string;
  modelSize: string | null;
  sidecarRunning: boolean;
  llamaServerAvailable: boolean;
  inferenceBackend: "llama" | "mlx";
  activeBackend: string;
  mlxRuntimeAvailable: boolean;
  mlxModelId: string;
  mlxModelReady: boolean;
  mlxRequiresNetwork: boolean;
};

type ModelPanelProps = {
  onOpenSetup?: () => void;
};

type FileKey = "model" | "mmproj";

type MlxProgressState = {
  status: "idle" | "running" | "done";
  percent: number;
  detail: string;
};

type FileProgressState = {
  status: "idle" | "waiting" | "running" | "switching" | "done";
  percent: number;
  downloaded: number;
  speedMbps: number | null;
  detail: string;
};

const FILE_LABELS: Record<"model" | "mmproj", string> = {
  model: "主模型",
  mmproj: "视觉投影器",
};

function createIdleProgress(): Record<"model" | "mmproj", FileProgressState> {
  return {
    model: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
    mmproj: { status: "idle", percent: 0, downloaded: 0, speedMbps: null, detail: "" },
  };
}

function shortenPath(path: string) {
  if (path.length <= 56) {
    return path;
  }
  return `…${path.slice(-52)}`;
}

export function ModelPanel({ onOpenSetup }: ModelPanelProps) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<FileKey, FileProgressState>>(createIdleProgress);
  const [mlxProgress, setMlxProgress] = useState<MlxProgressState>({
    status: "idle",
    percent: 0,
    detail: "",
  });

  async function refresh() {
    const next = await invoke<ModelStatus>("get_model_status");
    setStatus(next);
  }

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    void listen<{
      file: string;
      status?: string;
      message?: string;
      downloaded: number;
      total: number | null;
      percent?: number;
      source?: string;
      speedMbps?: number;
    }>("model-download-progress", (event) => {
      const { file, status: downloadStatus, message, downloaded, total, source, speedMbps } =
        event.payload;
      const fileKey: FileKey = file === "mmproj" ? "mmproj" : "model";
      if (file === "mlx") {
        const percent = event.payload.percent ?? 0;
        setMlxProgress({
          status: downloadStatus === "done" ? "done" : "running",
          percent: downloadStatus === "done" ? 100 : percent,
          detail: message ?? "正在下载 MLX 权重…",
        });
        return;
      }
      const label = FILE_LABELS[fileKey];

      setFileProgress((current) => {
        const prev = current[fileKey];

        if (downloadStatus === "waiting") {
          return {
            ...current,
            [fileKey]: {
              ...prev,
              status: "waiting",
              detail: message ?? "等待中…",
            },
          };
        }

        if (downloadStatus === "switching") {
          return {
            ...current,
            [fileKey]: {
              ...prev,
              status: "switching",
              detail: message ?? "正在切换下载源…",
            },
          };
        }

        if (downloadStatus === "done") {
          return {
            ...current,
            [fileKey]: {
              status: "done",
              percent: 100,
              downloaded: Math.max(prev.downloaded, downloaded),
              speedMbps: null,
              detail: message ?? "下载完成",
            },
          };
        }

        const resolvedPercent = resolveGgufPercent(prev.percent, downloaded, total, fileKey);
        const speed =
          speedMbps && speedMbps > 0 ? speedMbps : prev.speedMbps;
        const sourceHint = source ? ` · ${source}` : "";

        return {
          ...current,
          [fileKey]: {
            status: "running",
            percent: resolvedPercent,
            downloaded: Math.max(prev.downloaded, downloaded),
            speedMbps: speed ?? null,
            detail: `正在下载${label} ${resolvedPercent}%${sourceHint}`,
          },
        };
      });
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  async function downloadModel() {
    const runtimeReady =
      status?.inferenceBackend === "mlx"
        ? status?.mlxRuntimeAvailable
        : status?.llamaServerAvailable;
    if (!runtimeReady) {
      onOpenSetup?.();
      return;
    }
    if (status?.inferenceBackend === "mlx") {
      setDownloading(true);
      setMlxProgress({ status: "running", percent: 0, detail: "准备下载…" });
      try {
        await invoke<string>("download_mlx_model", { force: true });
        setMlxProgress({ status: "done", percent: 100, detail: "下载完成" });
        await refresh();
      } catch (error) {
        window.alert(String(error));
        setMlxProgress({ status: "idle", percent: 0, detail: "" });
      } finally {
        setDownloading(false);
      }
      return;
    }

    setDownloading(true);
    setFileProgress({
      model: { status: "running", percent: 0, downloaded: 0, speedMbps: null, detail: "等待开始…" },
      mmproj: { status: "waiting", percent: 0, downloaded: 0, speedMbps: null, detail: "等待主模型完成…" },
    });
    try {
      await invoke<string>("download_model", { force: true });
      setFileProgress({
        model: { status: "done", percent: 100, downloaded: EXPECTED_GGUF_BYTES.model, speedMbps: null, detail: "下载完成" },
        mmproj: { status: "done", percent: 100, downloaded: EXPECTED_GGUF_BYTES.mmproj, speedMbps: null, detail: "下载完成" },
      });
      await refresh();
    } catch (error) {
      window.alert(String(error));
      setFileProgress(createIdleProgress());
    } finally {
      setDownloading(false);
    }
  }

  const isMlx = status?.inferenceBackend === "mlx";
  const runtimeReady = isMlx ? status?.mlxRuntimeAvailable : status?.llamaServerAvailable;

  const fileItems = status
    ? isMlx
      ? [
          {
            label: "推理引擎",
            value: status.mlxRuntimeAvailable ? "MLX 已安装" : "未安装",
            ok: status.mlxRuntimeAvailable,
            meta: status.activeBackend ?? "MLX",
          },
          {
            label: "MLX 模型",
            value: status.mlxModelReady ? "已下载" : "未下载",
            ok: status.mlxModelReady,
            meta: shortenPath(status.mlxModelId),
          },
          {
            label: "推理进程",
            value: status.sidecarRunning ? "运行中" : "未运行",
            ok: status.sidecarRunning,
            meta: status.mlxModelReady ? "权重已缓存" : "需先下载权重",
          },
        ]
      : [
          {
            label: "主模型",
            value: status.modelDownloaded ? "已下载" : "未下载",
            ok: status.modelDownloaded,
            meta: status.modelPath ? shortenPath(status.modelPath) : "—",
          },
          {
            label: "视觉投影",
            value: status.mmprojDownloaded ? "已下载" : "未下载",
            ok: status.mmprojDownloaded,
            meta: status.mmprojPath ? shortenPath(status.mmprojPath) : "—",
          },
          {
            label: "推理进程",
            value: status.sidecarRunning ? "运行中" : "未运行",
            ok: status.sidecarRunning,
            meta: status.modelSize ? `合计 ${status.modelSize}` : "—",
          },
        ]
    : [];

  return (
    <div className="model-panel">
      {!runtimeReady ? (
        <div className="callout callout--attention" role="status">
          <p>{isMlx ? "MLX 推理引擎未安装，请先在环境配置或设置中安装。" : "推理引擎未安装，请先在环境配置中完成一键安装。"}</p>
          {onOpenSetup ? (
            <button type="button" className="callout__action" onClick={onOpenSetup}>
              去环境配置
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="surface model-panel__files" aria-label="模型文件">
        {status ? (
          <ul className="model-file-list">
            {fileItems.map((item) => (
              <li key={item.label} className="model-file-list__item">
                <div className="model-file-list__head">
                  <span className="model-file-list__label">{item.label}</span>
                  <strong className={`model-file-list__value${item.ok ? " is-positive" : ""}`}>{item.value}</strong>
                </div>
                <span className="model-file-list__path">{item.meta}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="placeholder-copy">正在读取模型状态…</p>
        )}
      </section>

      <section className="surface model-panel__actions-card">
        <p className="setup-panel__lead">
          {isMlx
            ? "下载 MLX 权重（约 2 GB）后即可识图。引擎安装请在「偏好设置 → 推理引擎」完成。"
            : "重新下载 GGUF 主模型与 mmproj。下载镜像可在「偏好设置 → GGUF 模型与下载」中配置。"}
        </p>
        <div className="model-actions">
          <button
            type="button"
            className="settings-btn settings-btn--primary"
            disabled={downloading || !runtimeReady}
            onClick={() => void downloadModel()}
          >
            {downloading ? "下载中…" : isMlx ? "下载 MLX 权重" : "重新下载模型"}
          </button>
          <button type="button" className="settings-btn settings-btn--secondary" onClick={() => void refresh()}>
            刷新状态
          </button>
        </div>
        {isMlx && mlxProgress.status !== "idle" ? (
          <div className="model-download-progress" aria-label="MLX 下载进度">
            <div className={`model-download-progress__item is-${mlxProgress.status}`}>
              <div className="model-download-progress__head">
                <span className="model-download-progress__label">MLX 权重</span>
                <span className="model-download-progress__percent">
                  {mlxProgress.status === "done" ? "完成" : `${mlxProgress.percent}%`}
                </span>
              </div>
              <div className="onboarding-overall-progress__bar" aria-hidden="true">
                <span style={{ width: `${mlxProgress.percent}%` }} />
              </div>
              {mlxProgress.detail ? (
                <p className="model-download-progress__detail">{mlxProgress.detail}</p>
              ) : null}
            </div>
          </div>
        ) : null}
        {!isMlx && (["model", "mmproj"] as const).some((key) => fileProgress[key].status !== "idle") ? (
          <div className="model-download-progress" aria-label="下载进度">
            {(["model", "mmproj"] as const).map((key) => {
              const item = fileProgress[key];
              return (
                <div key={key} className={`model-download-progress__item is-${item.status}`}>
                  <div className="model-download-progress__head">
                    <span className="model-download-progress__label">{FILE_LABELS[key]}</span>
                    <div className="model-download-progress__meta">
                      {item.status === "running" && item.speedMbps ? (
                        <span className="model-download-progress__speed">{item.speedMbps.toFixed(1)} MB/s</span>
                      ) : null}
                      <span className="model-download-progress__percent">
                        {item.status === "done"
                          ? "完成"
                          : item.status === "waiting"
                            ? "等待"
                            : `${item.percent}%`}
                      </span>
                    </div>
                  </div>
                  <div className="onboarding-overall-progress__bar" aria-hidden="true">
                    <span style={{ width: `${item.percent}%` }} />
                  </div>
                  {item.detail ? <p className="model-download-progress__detail">{item.detail}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <p className="field-hint">
          {isMlx ? "MLX 模型 ID 与路径请在「偏好设置 → 推理引擎」中配置。" : "手动指定 GGUF 路径请在「偏好设置」中配置。"}
        </p>
      </section>
    </div>
  );
}
