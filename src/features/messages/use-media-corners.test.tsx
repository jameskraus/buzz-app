// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMediaCorners } from "./use-media-corners";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("waits for layout, updates the media silhouette, and releases its observer on unmount", () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  let width = 320;
  const measure = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(180);
  function Surface() {
    const corners = useMediaCorners();
    return (
      <div ref={corners} style={{ borderTopLeftRadius: 16 }}>
        <svg data-image-outline="" aria-hidden="true">
          <path />
        </svg>
      </div>
    );
  }
  const { container, unmount } = render(<Surface />);
  const surface = container.firstElementChild as HTMLElement;
  const outline = surface.querySelector("path");
  // Ref attachment must not synchronously force layout during React's commit.
  expect(measure).not.toHaveBeenCalled();
  resize();
  expect(outline?.getAttribute("d")).toContain("M 25.6 0 L 294.4 0");
  expect(surface.style.getPropertyValue("--media-corner-clip")).toContain(
    "M 25.6 0 L 294.4 0",
  );
  width = 240;
  resize();
  expect(outline?.getAttribute("d")).toContain("M 25.6 0 L 214.4 0");
  expect(surface.style.getPropertyValue("--media-corner-clip")).toContain(
    "M 25.6 0 L 214.4 0",
  );
  width = 0;
  resize();
  expect(outline?.getAttribute("d")).toContain("M 25.6 0 L 214.4 0");
  width = 320;
  resize();
  expect(outline?.getAttribute("d")).toContain("M 25.6 0 L 294.4 0");
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(surface.style.getPropertyValue("--media-corner-clip")).toBe("");
  expect(surface.hasAttribute("data-smooth-corners")).toBe(false);
});
