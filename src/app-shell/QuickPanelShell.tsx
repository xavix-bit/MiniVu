import { useEffect } from "react";
import { ChatPanel } from "../chat/ChatPanel";
import { PanelChrome } from "../window/panelChrome";

export function QuickPanelShell() {
  useEffect(() => {
    document.documentElement.classList.add("quick-panel-window");
    return () => document.documentElement.classList.remove("quick-panel-window");
  }, []);

  return (
    <main className="quick-panel-shell">
      <PanelChrome>
        <div className="ambient-glow ambient-glow--panel" aria-hidden="true" />
        <ChatPanel />
      </PanelChrome>
    </main>
  );
}
