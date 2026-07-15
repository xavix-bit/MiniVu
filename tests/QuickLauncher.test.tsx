import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickLauncher } from "../src/app-shell/QuickPanelShell";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../src/chat/ChatPanel", () => ({ ChatPanel: () => null }));

describe("QuickLauncher", () => {
  it("exposes only the three primary screenshot actions", () => {
    const onCapture = vi.fn();
    const onPaste = vi.fn();
    const onRecent = vi.fn();
    render(<QuickLauncher onCapture={onCapture} onPaste={onPaste} onRecent={onRecent} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["截图", "粘贴", "最近"]);
    fireEvent.click(screen.getByRole("button", { name: "截图" }));
    fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onRecent).toHaveBeenCalledOnce();
  });
});
