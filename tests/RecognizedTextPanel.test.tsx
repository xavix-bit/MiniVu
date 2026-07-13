import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecognizedTextPanel } from "../src/chat/RecognizedTextPanel";

describe("RecognizedTextPanel", () => {
  it("shows every recognition state and offers a safe retry on failure", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <RecognizedTextPanel status="recognizing" text="" onRetry={retry} />,
    );
    expect(screen.getByText("正在识别文字…")).toBeInTheDocument();

    rerender(<RecognizedTextPanel status="recognized" text="识别内容" onRetry={retry} />);
    expect(screen.getByText(/识别到文字/)).toBeInTheDocument();

    rerender(<RecognizedTextPanel status="empty" text="" onRetry={retry} />);
    expect(screen.getByText("未识别到文字")).toBeInTheDocument();

    rerender(<RecognizedTextPanel status="failed" text="" onRetry={retry} />);
    expect(screen.getByText("文字没识别出来")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("stderr");
  });
});
