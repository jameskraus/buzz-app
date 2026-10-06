// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Virtualizer } from "@tanstack/react-virtual";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["wheel", "touchmove", "keydown", "pointerdown"])(
  "%s supersedes an unfinished index command when measurements arrive",
  (type) => {
    // Emulate only browser delivery: core computes all targets and corrections.
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const frame = () => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(performance.now());
      }
    };
    const scroller = document.createElement("div");
    document.body.append(scroller);
    Object.defineProperties(scroller, {
      scrollHeight: { value: 5000 },
      clientHeight: { value: 200 },
    });
    const scrollTo = vi.fn();
    let deliverOffset: (offset: number, scrolling: boolean) => void = () => {};
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 100,
      estimateSize: () => 50,
      getScrollElement: () => scroller,
      scrollToFn: scrollTo,
      // A renderer reads the new virtual items on notification, refreshing the
      // measurement positions that a later imperative command consumes.
      onChange: (instance) => {
        instance.getVirtualItems();
      },
      observeElementRect: (_instance, callback) => {
        callback({ width: 800, height: 200 });
        return () => {};
      },
      observeElementOffset: (_instance, callback) => {
        deliverOffset = callback;
        callback(0, false);
        return () => {};
      },
    });
    const dispose = virtualizer._didMount();
    try {
      virtualizer._willUpdate();
      virtualizer.scrollToIndex(20, { align: "start" });
      expect(scrollTo.mock.calls.at(-1)?.[0]).toBe(1000);

      // The browser has not landed at the command's destination when the reader
      // takes control. The subsequent row measurement moves that old target.
      scroller.dispatchEvent(new Event(type, { bubbles: true }));
      deliverOffset(150, true);
      scrollTo.mockClear();
      virtualizer.resizeItem(5, 100);
      frame();
      frame();
      expect(scrollTo).not.toHaveBeenCalled();

      virtualizer.scrollToIndex(30, { align: "start" });
      expect(scrollTo.mock.calls.at(-1)?.[0]).toBe(1550);
    } finally {
      dispose();
    }
  },
);
