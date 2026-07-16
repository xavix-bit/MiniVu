import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/settings/SettingsPanel";
import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
} from "../src/settings/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/settings/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/settingsStore")>();
  return {
    ...actual,
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
  };
});

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
    });
  });

  it("keeps one loaded form and its edits while switching between general and shortcut", async () => {
    const { rerender } = render(<SettingsPanel view="general" />);

    const theme = await screen.findByRole("combobox", { name: "外观主题" });
    fireEvent.change(theme, { target: { value: "dark" } });
    expect(screen.getByText("自动保留")).toBeVisible();
    expect(screen.queryByText("全局快捷键")).not.toBeInTheDocument();

    rerender(<SettingsPanel view="shortcut" />);
    expect(screen.getByText("全局快捷键")).toBeVisible();
    expect(screen.queryByText("自动保留")).not.toBeInTheDocument();

    rerender(<SettingsPanel view="general" />);
    expect(screen.getByRole("combobox", { name: "外观主题" })).toHaveValue("dark");
    expect(loadSettings).toHaveBeenCalledTimes(1);
  });

  it("fresh-merges its owned fields when saving and does not register event listeners", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const concurrentlyUpdated = {
      ...initial,
      inferenceBackend: "mlx" as const,
      mlxModelId: "mlx-community/updated-model",
      downloadMirror: "modelscope" as const,
      ggufModelVariant: "q6_k" as const,
    };
    vi.mocked(loadSettings)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(concurrentlyUpdated);

    render(<SettingsPanel view="general" />);
    fireEvent.change(await screen.findByRole("combobox", { name: "外观主题" }), {
      target: { value: "dark" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        ...concurrentlyUpdated,
        theme: "dark",
        shortcut: initial.shortcut,
        captureRetention: initial.captureRetention,
        backgroundWarmup: initial.backgroundWarmup,
      }),
    );
    expect(listen).not.toHaveBeenCalled();
  });
});
