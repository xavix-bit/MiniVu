import { useEffect } from "react";
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
    void loadSettings()
      .then((settings) => applyTheme(settingsThemeToMode(settings.theme)))
      .catch(() => applyTheme("system"));
  }, []);
}
