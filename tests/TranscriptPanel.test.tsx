import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptPanel } from "../src/chat/TranscriptPanel";

describe("TranscriptPanel", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it("scrolls immediately for every streamed text update", () => {
    const { rerender } = render(<TranscriptPanel messages={[]} streamingText="第一段" />);
    rerender(<TranscriptPanel messages={[]} streamingText="第一段第二段" />);
    rerender(<TranscriptPanel messages={[]} streamingText="第一段第二段第三段" />);

    expect(scrollIntoView).toHaveBeenCalledTimes(3);
    expect(scrollIntoView).toHaveBeenNthCalledWith(1, { block: "end", behavior: "auto" });
    expect(scrollIntoView).toHaveBeenNthCalledWith(2, { block: "end", behavior: "auto" });
    expect(scrollIntoView).toHaveBeenNthCalledWith(3, { block: "end", behavior: "auto" });
  });
});
