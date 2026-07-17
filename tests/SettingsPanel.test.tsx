import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/settings/SettingsPanel";
import {
  createDefaultSettings,
  loadSettings,
  updateSettings,
  type AppSettings,
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

function loadedSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...createDefaultSettings(),
    onboardingComplete: true,
    ...overrides,
  };
}

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute("data-theme");
    vi.mocked(loadSettings).mockResolvedValue(loadedSettings());
    vi.mocked(updateSettings).mockImplementation(async (patch) => loadedSettings(patch));
  });

  it("auto-saves a theme selection after applying it and has no general save button", async () => {
    vi.mocked(updateSettings).mockImplementation(async (patch) => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
      return loadedSettings(patch);
    });
    render(<SettingsPanel view="general" />);

    fireEvent.click(await screen.findByRole("radio", { name: "浅色" }));

    expect(updateSettings).toHaveBeenCalledWith({ theme: "light" });
    expect(screen.queryByRole("button", { name: "保存设置" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("radiogroup", { name: "外观主题" })).not.toHaveAttribute(
        "data-saving",
      ),
    );
  });

  it("auto-saves the floating button switch as an exact patch", async () => {
    render(<SettingsPanel view="general" />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "悬浮按钮" }));

    expect(updateSettings).toHaveBeenCalledWith({ floatingAssistantEnabled: false });
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "悬浮按钮" })).not.toHaveAttribute(
        "data-saving",
      ),
    );
  });

  it("keeps defaults read-only until persisted settings load", async () => {
    const load = createDeferred<AppSettings>();
    vi.mocked(loadSettings).mockReturnValue(load.promise);
    render(<SettingsPanel view="general" />);

    const theme = screen.getByRole("radio", { name: "浅色" });
    const retention = screen.getByRole("combobox", { name: "保留时长" });
    expect(theme).toBeDisabled();
    expect(retention).toBeDisabled();
    fireEvent.click(theme);
    expect(updateSettings).not.toHaveBeenCalled();

    await act(async () => {
      load.resolve(loadedSettings({ theme: "dark", captureRetention: "7d" }));
      await load.promise;
    });

    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
    expect(retention).toBeEnabled();
    expect(retention).toHaveValue("7d");
  });

  it("recovers from a settings load failure through retry", async () => {
    vi.mocked(loadSettings)
      .mockRejectedValueOnce(new Error("load_app_settings: corrupt file path"))
      .mockResolvedValueOnce(loadedSettings({ captureRetention: "7d" }));
    render(<SettingsPanel view="general" />);

    expect(await screen.findByText("无法读取设置，请重试。")).toBeVisible();
    expect(screen.getByRole("radio", { name: "自动" })).toBeDisabled();
    expect(screen.queryByText(/load_app_settings|corrupt|path/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "保留时长" })).toBeEnabled(),
    );
    expect(screen.getByRole("combobox", { name: "保留时长" })).toHaveValue("7d");
    expect(screen.queryByText("无法读取设置，请重试。")).not.toBeInTheDocument();
  });

  it("keeps one loaded draft while switching between general and shortcut", async () => {
    const { rerender } = render(<SettingsPanel view="general" />);

    fireEvent.click(await screen.findByRole("radio", { name: "深色" }));
    await waitFor(() =>
      expect(screen.getByRole("radiogroup", { name: "外观主题" })).not.toHaveAttribute(
        "data-saving",
      ),
    );
    expect(screen.getByText("保留时长")).toBeVisible();

    rerender(<SettingsPanel view="shortcut" />);
    expect(screen.getByText("全局快捷键")).toBeVisible();
    expect(screen.queryByText("保留时长")).not.toBeInTheDocument();

    rerender(<SettingsPanel view="general" />);
    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
    expect(loadSettings).toHaveBeenCalledTimes(1);
  });

  it("only keeps explicit submission for the shortcut view", async () => {
    const initial = loadedSettings({ shortcut: "CommandOrControl+Shift+8" });
    vi.mocked(loadSettings).mockResolvedValue(initial);

    const { rerender } = render(<SettingsPanel view="general" />);
    await screen.findByRole("radio", { name: "自动" });
    expect(screen.queryByRole("button", { name: "保存设置" })).not.toBeInTheDocument();

    rerender(<SettingsPanel view="shortcut" />);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ shortcut: initial.shortcut }),
    );
    expect(listen).not.toHaveBeenCalled();
  });

  it("does not let an older theme response replace newer theme and retention drafts", async () => {
    const themeSave = createDeferred<AppSettings>();
    const retentionSave = createDeferred<AppSettings>();
    vi.mocked(updateSettings).mockImplementation((patch) =>
      "theme" in patch ? themeSave.promise : retentionSave.promise,
    );
    render(<SettingsPanel view="general" />);

    fireEvent.click(await screen.findByRole("radio", { name: "深色" }));
    fireEvent.change(screen.getByRole("combobox", { name: "保留时长" }), {
      target: { value: "7d" },
    });

    await act(async () => {
      retentionSave.resolve(loadedSettings({ theme: "system", captureRetention: "7d" }));
      await retentionSave.promise;
    });
    await act(async () => {
      themeSave.resolve(loadedSettings({ theme: "dark", captureRetention: "24h" }));
      await themeSave.promise;
    });

    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "保留时长" })).toHaveValue("7d");
  });

  it("retains a failed selection, hides raw errors, and retries the exact patch", async () => {
    vi.mocked(updateSettings)
      .mockRejectedValueOnce(new Error("update_app_settings failed: disk full at /Users/test"))
      .mockResolvedValueOnce(loadedSettings({ theme: "dark" }));
    render(<SettingsPanel view="general" />);

    fireEvent.click(await screen.findByRole("radio", { name: "深色" }));

    expect(await screen.findByText("主题未保存，请重试。")).toBeVisible();
    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
    expect(screen.queryByText(/update_app_settings|disk full|Users\/test/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试主题" }));

    expect(updateSettings).toHaveBeenLastCalledWith({ theme: "dark" });
    await waitFor(() =>
      expect(screen.queryByText("主题未保存，请重试。")).not.toBeInTheDocument(),
    );
  });

  it("distinguishes concurrent field failures and retries each exact patch", async () => {
    vi.mocked(updateSettings)
      .mockRejectedValueOnce(new Error("raw theme failure /tmp/theme"))
      .mockRejectedValueOnce(new Error("raw floating failure /tmp/floating"))
      .mockResolvedValueOnce(loadedSettings({ floatingAssistantEnabled: false }))
      .mockResolvedValueOnce(loadedSettings({ theme: "dark" }));
    render(<SettingsPanel view="general" />);

    fireEvent.click(await screen.findByRole("radio", { name: "深色" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "悬浮按钮" }));

    expect(await screen.findByText("主题未保存，请重试。")).toBeVisible();
    expect(await screen.findByText("悬浮按钮未保存，请重试。")).toBeVisible();
    expect(screen.getAllByText("重试")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "悬浮按钮" })).not.toBeChecked();
    expect(screen.queryByText(/raw theme|raw floating|\/tmp/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试悬浮按钮" }));
    expect(updateSettings).toHaveBeenLastCalledWith({ floatingAssistantEnabled: false });

    fireEvent.click(screen.getByRole("button", { name: "重试主题" }));
    expect(updateSettings).toHaveBeenLastCalledWith({ theme: "dark" });
    await waitFor(() => {
      expect(screen.getByRole("radiogroup", { name: "外观主题" })).not.toHaveAttribute(
        "data-saving",
      );
      expect(screen.getByRole("checkbox", { name: "悬浮按钮" })).not.toHaveAttribute(
        "data-saving",
      );
    });
  });

  it("ignores an old same-field failure and keeps saving until the latest request settles", async () => {
    const oldSave = createDeferred<AppSettings>();
    const latestSave = createDeferred<AppSettings>();
    vi.mocked(updateSettings)
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(latestSave.promise);
    render(<SettingsPanel view="general" />);

    fireEvent.click(await screen.findByRole("radio", { name: "深色" }));
    fireEvent.click(screen.getByRole("radio", { name: "浅色" }));
    const themeGroup = screen.getByRole("radiogroup", { name: "外观主题" });
    expect(themeGroup).toHaveAttribute("data-saving", "true");

    await act(async () => {
      oldSave.reject(new Error("stale failure: raw path /tmp/settings"));
      await oldSave.promise.catch(() => undefined);
    });

    expect(screen.getByRole("radio", { name: "浅色" })).toBeChecked();
    expect(screen.queryByText("主题未保存，请重试。")).not.toBeInTheDocument();
    expect(themeGroup).toHaveAttribute("data-saving", "true");

    await act(async () => {
      latestSave.resolve(loadedSettings({ theme: "light" }));
      await latestSave.promise;
    });

    expect(themeGroup).not.toHaveAttribute("data-saving");
    expect(screen.getByRole("radio", { name: "浅色" })).toBeChecked();
  });

  it("shows product error state for an explicit shortcut save", async () => {
    const save = createDeferred<AppSettings>();
    vi.mocked(updateSettings).mockReturnValue(save.promise);
    render(<SettingsPanel view="shortcut" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();

    await act(async () => {
      save.reject(new Error("update_app_settings failed: disk full at /Users/test"));
      await save.promise.catch(() => undefined);
    });

    expect(screen.getByText("无法保存设置，请重试。")).toBeVisible();
    expect(screen.queryByText(/update_app_settings|disk full|Users\/test/)).not.toBeInTheDocument();
  });
});
