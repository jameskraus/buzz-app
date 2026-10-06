const restores = new WeakMap<HTMLElement, () => void>();
const macWebKit = () =>
  navigator.platform === "MacIntel" &&
  !navigator.maxTouchPoints && // desktop-mode iPad keeps its momentum policy
  navigator.vendor === "Apple Computer, Inc.";

/**
 * Applies an automatic scroll correction. Mac WebKit can leave the corrected
 * viewport unpainted while native momentum continues, so stop the momentum the
 * existing correction policy: hide vertical overflow for
 * one task. The scroller must keep its inline size (`scrollbar-gutter: stable`).
 */
export function correctScrollTop(element: HTMLElement, delta: number) {
  if (!delta) return;
  if (macWebKit()) {
    // Corrections in one task share the original declaration.
    restores.get(element)?.();
    const { style } = element;
    const value = style.getPropertyValue("overflow-y");
    const priority = style.getPropertyPriority("overflow-y");
    style.setProperty("overflow-y", "hidden", "important");
    const restore = () => {
      clearTimeout(timer);
      restores.delete(element);
      if (
        style.getPropertyValue("overflow-y") === "hidden" &&
        style.getPropertyPriority("overflow-y") === "important"
      )
        value
          ? style.setProperty("overflow-y", value, priority)
          : style.removeProperty("overflow-y");
    };
    const timer = setTimeout(restore);
    restores.set(element, restore);
  }
  element.scrollTop += delta;
}
