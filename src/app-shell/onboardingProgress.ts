export type PhaseStatus = "waiting" | "running" | "switching" | "done" | "error";

export type SetupProgress = {
  phase: string;
  status: PhaseStatus;
  message: string;
  percent: number;
  speedMbps?: number | null;
};

export type FileByteProgress = {
  downloaded: number;
  total: number | null;
};

export type DownloadBytes = {
  model: FileByteProgress;
  mmproj: FileByteProgress;
};

const PHASE_ORDER = ["device", "runtime", "model", "mmproj", "shortcut", "done"] as const;

const STATUS_RANK: Record<PhaseStatus, number> = {
  waiting: 0,
  running: 1,
  switching: 1,
  done: 2,
  error: 3,
};

const SMALL_PHASE_WEIGHTS = {
  device: 5,
  runtime: 10,
  shortcut: 5,
} as const;

const DOWNLOAD_WEIGHT = 80;

import {
  EXPECTED_MODEL_BYTES,
  EXPECTED_MMPROJ_BYTES,
} from "../shared/modelConstants";

function effectiveTotal(file: FileByteProgress, expected: number): number {
  return file.total ?? expected;
}

export function createInitialProgress(): Record<string, SetupProgress> {
  return Object.fromEntries(
    PHASE_ORDER.map((phase) => [
      phase,
      {
        phase,
        status: "waiting" as PhaseStatus,
        message: "等待中",
        percent: 0,
      },
    ]),
  );
}

export function createInitialDownloadBytes(): DownloadBytes {
  return {
    model: { downloaded: 0, total: null },
    mmproj: { downloaded: 0, total: null },
  };
}

export function mergeDownloadBytes(
  current: DownloadBytes,
  file: "model" | "mmproj",
  downloaded: number,
  total: number | null | undefined,
): DownloadBytes {
  const prev = current[file];
  return {
    ...current,
    [file]: {
      downloaded: Math.max(prev.downloaded, downloaded),
      total: total ?? prev.total,
    },
  };
}

export function mergeProgress(
  current: Record<string, SetupProgress>,
  incoming: Partial<SetupProgress> & { phase: string },
): Record<string, SetupProgress> {
  const prev = current[incoming.phase];
  const incomingStatus = (incoming.status ?? prev?.status ?? "waiting") as PhaseStatus;

  if (prev?.status === "done" && incomingStatus !== "done" && incomingStatus !== "error") {
    return current;
  }

  const status =
    prev && STATUS_RANK[incomingStatus] < STATUS_RANK[prev.status]
      ? prev.status
      : incomingStatus;

  const percent = Math.max(prev?.percent ?? 0, incoming.percent ?? prev?.percent ?? 0);

  const speedMbps =
    incoming.speedMbps !== undefined
      ? incoming.speedMbps
      : status === "running" || status === "switching"
        ? (prev?.speedMbps ?? null)
        : null;

  return {
    ...current,
    [incoming.phase]: {
      phase: incoming.phase,
      status,
      message: incoming.message ?? prev?.message ?? "处理中…",
      percent: status === "done" ? 100 : percent,
      speedMbps,
    },
  };
}

function smallPhaseContribution(
  progress: Record<string, SetupProgress>,
  phase: keyof typeof SMALL_PHASE_WEIGHTS,
): number {
  const item = progress[phase];
  if (!item) {
    return 0;
  }
  const ratio = item.status === "done" ? 1 : item.percent / 100;
  return SMALL_PHASE_WEIGHTS[phase] * ratio;
}

function downloadContribution(
  progress: Record<string, SetupProgress>,
  bytes?: DownloadBytes,
): number {
  const model = progress.model;
  const mmproj = progress.mmproj;

  if (model?.status === "done" && mmproj?.status === "done") {
    return DOWNLOAD_WEIGHT;
  }

  if (bytes) {
    const downloaded = bytes.model.downloaded + bytes.mmproj.downloaded;
    const combinedTotal =
      effectiveTotal(bytes.model, EXPECTED_MODEL_BYTES) +
      effectiveTotal(bytes.mmproj, EXPECTED_MMPROJ_BYTES);

    if (combinedTotal > 0) {
      return DOWNLOAD_WEIGHT * Math.min(1, downloaded / combinedTotal);
    }
  }

  const modelPercent = model?.status === "done" ? 100 : model?.percent ?? 0;
  const mmprojPercent = mmproj?.status === "done" ? 100 : mmproj?.percent ?? 0;
  return DOWNLOAD_WEIGHT * ((modelPercent + mmprojPercent) / 200);
}

export function computeOverallPercent(
  progress: Record<string, SetupProgress>,
  bytes?: DownloadBytes,
): number {
  const total =
    smallPhaseContribution(progress, "device") +
    smallPhaseContribution(progress, "runtime") +
    downloadContribution(progress, bytes) +
    smallPhaseContribution(progress, "shortcut");

  return Math.min(100, Math.round(total));
}

export { PHASE_ORDER };
