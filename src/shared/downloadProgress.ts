import {
  EXPECTED_GGUF_BYTES,
  EXPECTED_MLX_BYTES,
  expectedGgufBytesForVariant,
} from "./modelConstants";
import type { GgufModelVariant } from "../settings/settingsStore";

export type GgufFileKey = "model" | "mmproj";

export function resolveGgufPercent(
  previous: number,
  downloaded: number,
  total: number | null | undefined,
  fileKey: GgufFileKey,
  variant?: GgufModelVariant,
): number {
  const expected = variant
    ? expectedGgufBytesForVariant(variant)[fileKey]
    : EXPECTED_GGUF_BYTES[fileKey];
  const basis = total && total > 0 ? total : expected;
  const fromBytes = basis > 0 ? Math.round((downloaded / basis) * 100) : 0;
  return Math.min(100, Math.max(previous, fromBytes));
}

export function resolveMlxPercent(previous: number, downloaded: number): number {
  const fromBytes =
    EXPECTED_MLX_BYTES > 0
      ? Math.round((downloaded / EXPECTED_MLX_BYTES) * 100)
      : 0;
  return Math.min(100, Math.max(previous, fromBytes));
}

export function formatDownloadDetail(
  downloaded: number,
  total: number | null | undefined,
  fileKey: GgufFileKey,
): string {
  const expected = EXPECTED_GGUF_BYTES[fileKey];
  const basis = total && total > 0 ? total : expected;
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);
  return `${mb(downloaded)} / ${mb(basis)} MB`;
}
