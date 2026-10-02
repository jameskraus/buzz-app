import { useCallback } from "react";
import { mediaCornerPath } from "./media-corners";

/** CSS chooses where to clip, so floating menus can escape the media surface. */
export function useMediaCorners() {
  return useCallback((element: HTMLElement | null) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      const { offsetWidth: width, offsetHeight: height } = element;
      if (!width || !height) return;
      const radius = Number.parseFloat(
        getComputedStyle(element).borderTopLeftRadius,
      );
      const path = mediaCornerPath(width, height, radius || 0);
      const clip = `path("${path}")`;
      if (element.style.getPropertyValue("--media-corner-clip") !== clip)
        element.style.setProperty("--media-corner-clip", clip);
      // Set the SVG attribute so the outline does not depend on CSS d support.
      element
        .querySelector("[data-image-outline] path")
        ?.setAttribute("d", path);
      element.dataset.smoothCorners = "";
    };
    // Initial observation runs before paint, without forcing layout in the ref.
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.style.removeProperty("--media-corner-clip");
      delete element.dataset.smoothCorners;
    };
  }, []);
}
