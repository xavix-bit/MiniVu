import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureRecord } from "../src/captures/types";
import { CaptureCanvas } from "../src/workbench/CaptureCanvas";

type Size = { width: number; height: number };

let imageSize: Size;
let stageSize: Size;

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];

  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function record(id = "one"): CaptureRecord {
  return {
    id,
    source: "capture",
    title: `截图 ${id}`,
    ocrText: "",
    ocrState: "ready",
    messages: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    expiresAtMs: 2,
    pinned: false,
    imageDataUrl: `data:image/png;base64,${id}`,
    thumbnailDataUrl: `data:image/jpeg;base64,${id}`,
  };
}

beforeEach(() => {
  imageSize = { width: 0, height: 0 };
  stageSize = { width: 800, height: 600 };
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
    return this.classList.contains("capture-canvas__stage") ? stageSize.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
    return this.classList.contains("capture-canvas__stage") ? stageSize.height : 0;
  });
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockImplementation(() => imageSize.width);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockImplementation(() => imageSize.height);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CaptureCanvas", () => {
  it("fits on image load and exposes the percentage as read-only output", () => {
    render(<CaptureCanvas record={record()} />);

    const percentage = screen.getByLabelText("当前缩放比例");
    expect(percentage.tagName).toBe("OUTPUT");
    expect(screen.queryByRole("button", { name: "当前缩放比例" })).not.toBeInTheDocument();

    imageSize = { width: 1600, height: 900 };
    fireEvent.load(screen.getByRole("img", { name: "截图 one" }));

    expect(percentage).toHaveTextContent("46%");
  });

  it("re-fits when the selected record changes", () => {
    imageSize = { width: 1600, height: 900 };
    const view = render(<CaptureCanvas record={record()} />);
    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("46%");

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("66%");

    imageSize = { width: 600, height: 1200 };
    stageSize = { width: 900, height: 700 };
    view.rerender(<CaptureCanvas record={record("two")} />);

    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("53%");
    expect(screen.getByRole("button", { name: "适合窗口" })).toHaveAttribute("aria-pressed", "true");
  });

  it("re-fits observed resizes only while automatic fit is active", () => {
    imageSize = { width: 1600, height: 900 };
    render(<CaptureCanvas record={record()} />);
    const percentage = screen.getByLabelText("当前缩放比例");
    const observer = ResizeObserverMock.instances[0];

    stageSize = { width: 1000, height: 800 };
    act(() => observer.trigger());
    expect(percentage).toHaveTextContent("59%");

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(percentage).toHaveTextContent("78%");
    expect(screen.getByRole("button", { name: "适合窗口" })).toHaveAttribute("aria-pressed", "false");

    stageSize = { width: 1200, height: 900 };
    act(() => observer.trigger());
    expect(percentage).toHaveTextContent("78%");
  });

  it("shows the image at an explicit centered one-to-one viewport", () => {
    imageSize = { width: 1600, height: 900 };
    render(<CaptureCanvas record={record()} />);

    fireEvent.click(screen.getByRole("button", { name: "原始大小" }));

    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("100%");
    expect(screen.getByRole("img", { name: "截图 one" })).toHaveStyle({
      transform: "translate(0px, 0px) scale(1)",
    });
    expect(screen.getByRole("button", { name: "适合窗口" })).toHaveAttribute("aria-pressed", "false");
  });

  it("pans only with the active pointer and keeps manual pan through resizes", () => {
    imageSize = { width: 1600, height: 900 };
    const { container } = render(<CaptureCanvas record={record()} />);
    const stage = container.querySelector<HTMLElement>(".capture-canvas__stage")!;
    const image = screen.getByRole("img", { name: "截图 one" });
    Object.defineProperty(stage, "setPointerCapture", { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(stage, {
      button: 0,
      pointerId: 7,
      pointerType: "mouse",
      clientX: 10,
      clientY: 20,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 8,
      pointerType: "mouse",
      clientX: 110,
      clientY: 120,
    });
    expect(image).toHaveStyle({ transform: "translate(0px, 0px) scale(0.46)" });

    fireEvent.pointerMove(stage, { pointerId: 7, clientX: 30, clientY: 50 });
    expect(image).toHaveStyle({ transform: "translate(20px, 30px) scale(0.46)" });
    expect(screen.getByRole("button", { name: "适合窗口" })).toHaveAttribute("aria-pressed", "false");

    stageSize = { width: 1000, height: 800 };
    act(() => ResizeObserverMock.instances[0].trigger());
    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("46%");

    fireEvent.pointerUp(stage, { pointerId: 8 });
    fireEvent.pointerMove(stage, { pointerId: 7, clientX: 40, clientY: 60 });
    expect(image).toHaveStyle({ transform: "translate(30px, 40px) scale(0.46)" });

    fireEvent.pointerUp(stage, { pointerId: 7 });
    fireEvent.pointerMove(stage, { pointerId: 7, clientX: 80, clientY: 90 });
    expect(image).toHaveStyle({ transform: "translate(30px, 40px) scale(0.46)" });
  });

  it("clears active drags on cancel, lost capture, and record change", () => {
    imageSize = { width: 1600, height: 900 };
    const view = render(<CaptureCanvas record={record()} />);
    const stage = view.container.querySelector<HTMLElement>(".capture-canvas__stage")!;
    Object.defineProperty(stage, "setPointerCapture", { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(stage, { pointerId: 2 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(screen.getByRole("img", { name: "截图 one" })).toHaveStyle({
      transform: "translate(20px, 20px) scale(0.46)",
    });

    fireEvent.pointerCancel(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 40, clientY: 40 });
    expect(screen.getByRole("img", { name: "截图 one" })).toHaveStyle({
      transform: "translate(20px, 20px) scale(0.46)",
    });

    fireEvent.pointerDown(stage, { button: 0, pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.lostPointerCapture(stage, { pointerId: 3 });
    fireEvent.pointerMove(stage, { pointerId: 3, clientX: 10, clientY: 10 });
    expect(screen.getByRole("img", { name: "截图 one" })).toHaveStyle({
      transform: "translate(20px, 20px) scale(0.46)",
    });

    fireEvent.pointerDown(stage, { button: 0, pointerId: 4, clientX: 0, clientY: 0 });
    view.rerender(<CaptureCanvas record={record("two")} />);
    fireEvent.pointerMove(stage, { pointerId: 4, clientX: 10, clientY: 10 });
    expect(screen.getByRole("img", { name: "截图 two" })).toHaveStyle({
      transform: "translate(0px, 0px) scale(0.46)",
    });
  });

  it("disconnects the resize observer on cleanup", () => {
    const { unmount } = render(<CaptureCanvas record={record()} />);
    const observer = ResizeObserverMock.instances[0];

    expect(observer.observe).toHaveBeenCalledTimes(1);
    unmount();

    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });
});
