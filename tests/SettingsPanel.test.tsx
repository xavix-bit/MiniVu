import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/settings/SettingsPanel";
import {
  createDefaultSettings,
  loadSettings,
  updateSettings,
} from "../src/settings/settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/settings/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/settings/settingsStore")>();
  return {
    ...actual,
    loadSettings: vi.fn(),
    updateSettings: vi.fn(),
  };
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadSettings).mockResolvedValue({
      ...createDefaultSettings(),
      onboardingComplete: true,
    });
    vi.mocked(updateSettings).mockImplementation(async (patch) => ({
      ...createDefaultSettings(),
      onboardingComplete: true,
      ...patch,
    }));
  });

  it("keeps defaults read-only until persisted settings load", async () => {
    const load = createDeferred<ReturnType<typeof createDefaultSettings>>();
    vi.mocked(loadSettings).mockReturnValue(load.promise);

    render(<SettingsPanel view="general" />);

    const theme = screen.getByRole("combobox", { name: "外观主题" });
    expect(theme).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(updateSettings).not.toHaveBeenCalled();

    load.resolve({
      ...createDefaultSettings(),
      onboardingComplete: true,
      theme: "dark",
    });

    await waitFor(() => expect(theme).toBeEnabled());
    expect(theme).toHaveValue("dark");
  });

  it("recovers from a settings load failure through retry", async () => {
    vi.mocked(loadSettings)
      .mockRejectedValueOnce(new Error("load_app_settings: corrupt file path"))
      .mockResolvedValueOnce({
        ...createDefaultSettings(),
        onboardingComplete: true,
        captureRetention: "7d",
      });

    render(<SettingsPanel view="general" />);

    expect(await screen.findByText("无法读取设置，请重试。")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "外观主题" })).toBeDisabled();
    expect(screen.queryByText(/load_app_settings|corrupt|path/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /自动保留/ })).toBeEnabled(),
    );
    expect(screen.getByRole("combobox", { name: /自动保留/ })).toHaveValue("7d");
    expect(screen.queryByText("无法读取设置，请重试。")).not.toBeInTheDocument();
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

  it("saves only the general view fields through the serialized settings API", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    vi.mocked(loadSettings).mockResolvedValue(initial);

    render(<SettingsPanel view="general" />);
    fireEvent.change(await screen.findByRole("combobox", { name: "外观主题" }), {
      target: { value: "dark" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        theme: "dark",
        captureRetention: initial.captureRetention,
        backgroundWarmup: initial.backgroundWarmup,
      }),
    );
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(listen).not.toHaveBeenCalled();
  });

  it("saves only the shortcut view field through the serialized settings API", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
      shortcut: "CommandOrControl+Shift+8",
    };
    vi.mocked(loadSettings).mockResolvedValue(initial);

    render(<SettingsPanel view="shortcut" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重新录制" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        shortcut: initial.shortcut,
      }),
    );
  });

  it("shows pending and product error states while saving", async () => {
    const save = createDeferred<ReturnType<typeof createDefaultSettings>>();
    vi.mocked(updateSettings).mockReturnValue(save.promise);

    render(<SettingsPanel view="general" />);
    await screen.findByRole("combobox", { name: "外观主题" });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();

    save.reject(new Error("update_app_settings failed: disk full at /Users/test"));

    expect(await screen.findByText("无法保存设置，请重试。")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled();
    expect(screen.queryByText(/update_app_settings|disk full|Users\/test/)).not.toBeInTheDocument();
  });

  it("does not replace a newer draft when a slow save resolves", async () => {
    const initial = {
      ...createDefaultSettings(),
      onboardingComplete: true,
    };
    const save = createDeferred<ReturnType<typeof createDefaultSettings>>();
    vi.mocked(loadSettings).mockResolvedValue(initial);
    vi.mocked(updateSettings).mockReturnValue(save.promise);

    render(<SettingsPanel view="general" />);
    const theme = await screen.findByRole("combobox", { name: "外观主题" });
    fireEvent.change(theme, { target: { value: "dark" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    fireEvent.change(theme, { target: { value: "light" } });

    save.resolve({ ...initial, theme: "dark" });

    await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
    expect(theme).toHaveValue("light");
    expect(screen.queryByText("设置已保存")).not.toBeInTheDocument();
  });
});
