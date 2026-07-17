import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/chat/Composer";

type ComposerOverrides = Partial<React.ComponentProps<typeof Composer>>;

function renderComposer(overrides: ComposerOverrides = {}) {
  const props: React.ComponentProps<typeof Composer> = {
    value: "你好",
    disabled: false,
    isAnswering: false,
    canSubmit: true,
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };

  render(<Composer {...props} />);
  return props;
}

describe("Composer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not send when Pinyin confirmation leaks an Enter", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(100);
    const { onSubmit } = renderComposer({ value: "nihao" });
    const input = screen.getByRole("textbox");

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
    fireEvent.compositionEnd(input);
    now.mockReturnValue(220);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends on a later physical Enter and keeps Shift-Enter as a newline", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(100);
    const { onSubmit } = renderComposer();
    const input = screen.getByRole("textbox");

    fireEvent.compositionEnd(input);
    now.mockReturnValue(400);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("ignores a synthetic Enter without a physical Enter code", () => {
    const { onSubmit } = renderComposer();

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Unidentified" });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
