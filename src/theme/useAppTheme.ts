import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings, type AppSettings } from "../settings/settingsStore";
import { applyTheme, type ThemeMode } from "./applyTheme";

export function settingsThemeToMode(theme: AppSettings["theme"]): ThemeMode {
  if (theme === "light" || theme === "dark") {
    return theme;
  }
  return "system";
}

export function useAppTheme() {
  useEffect(() => {
    const label = getCurrentWindow().label;
    // 主窗口固定浅色卡片风格，避免跟随系统深色模式出现「灰侧栏 + 深主区」混搭
    if (label === "main") {
      applyTheme("light");
      return;
    }

    void loadSettings()
      .then((settings) => applyTheme(settingsThemeToMode(settings.theme)))
      .catch(() => applyTheme("system"));
  }, []);
}
