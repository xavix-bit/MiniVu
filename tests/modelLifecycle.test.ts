import { describe, expect, it } from "vitest";
import {
  formatModelStorage,
  matchesActiveDownload,
  resolveModelPrimaryAction,
  type ModelPrimaryAction,
} from "../src/model/modelLifecycle";
import type { DownloadTaskSnapshot, GgufVariantInventory } from "../src/model/types";

const inventory: GgufVariantInventory[] = [
  {
    variant: "q4_k_m",
    installed: true,
    installedBytes: 529_101_504,
    partialBytes: 0,
    expectedBytes: 529_101_504,
    active: true,
  },
];

const activeTask: DownloadTaskSnapshot = {
  taskId: 41,
  variant: "q5_k_m",
  status: "running",
  file: "model",
  downloaded: 100,
  total: 200,
  source: "modelscope",
};

describe("resolveModelPrimaryAction", () => {
  it("prioritizes cancel whenever a GGUF task is active", () => {
    expect(resolveModelPrimaryAction("q4_k_m", inventory, activeTask)).toEqual<ModelPrimaryAction>({
      kind: "cancel",
      label: "取消下载",
      disabled: false,
    });
  });

  it("disables the action for the installed active variant", () => {
    expect(resolveModelPrimaryAction("q4_k_m", inventory, null)).toEqual<ModelPrimaryAction>({
      kind: "current",
      label: "当前使用",
      disabled: true,
    });
  });

  it.each([
    [{ installed: true, active: false, partialBytes: 0 }, "switch", "切换到此模型"],
    [{ installed: false, active: false, partialBytes: 12 }, "resume", "继续下载并切换"],
    [{ installed: false, active: false, partialBytes: 0 }, "install", "下载并切换"],
  ] as const)("derives %s as the %s action", (changes, kind, label) => {
    const selected = [{ ...inventory[0], ...changes }];
    expect(resolveModelPrimaryAction("q4_k_m", selected, null)).toEqual({
      kind,
      label,
      disabled: false,
    });
  });
});

describe("matchesActiveDownload", () => {
  it("accepts only the current task identity, with a pending-variant bridge", () => {
    expect(matchesActiveDownload({ taskId: 41, variant: "q5_k_m" }, activeTask, null)).toBe(true);
    expect(matchesActiveDownload({ taskId: 40, variant: "q5_k_m" }, activeTask, null)).toBe(false);
    expect(matchesActiveDownload({ taskId: 41, variant: "q4_k_m" }, activeTask, null)).toBe(false);
    expect(matchesActiveDownload({ taskId: 99, variant: "q6_k" }, null, "q6_k")).toBe(true);
    expect(matchesActiveDownload({ taskId: 99, variant: "q5_k_m" }, null, "q6_k")).toBe(false);
  });
});

describe("formatModelStorage", () => {
  it("formats GGUF storage in natural binary units", () => {
    expect(formatModelStorage(0)).toBe("0 MB");
    expect(formatModelStorage(768 * 1024 * 1024)).toBe("768 MB");
    expect(formatModelStorage(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});
