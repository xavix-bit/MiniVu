import { getCurrentWindow } from "@tauri-apps/api/window";
import { QuickPanelShell } from "./app-shell/QuickPanelShell";
import { MainWindowShell } from "./app-shell/MainWindowShell";
import { useAppTheme } from "./theme/useAppTheme";
import "./styles.css";

export default function App() {
  useAppTheme();
  const windowLabel = getCurrentWindow().label;

  if (windowLabel === "main") {
    return <MainWindowShell />;
  }

  return <QuickPanelShell />;
}
