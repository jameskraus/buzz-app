import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { correctScrollTop } from "./scroll-correction";
import {
  useCallback,
  useImperativeHandle,
  useRef,
  type ReactElement,
  type Ref,
  type RefObject,
} from "react";

export type TimelineVirtualizerHandle = {
  readonly cache: VirtualItem[];
  scrollTo(offset: number): void;
  scrollToIndex(
    index: number,
    options: { align: "start" | "center" | "end"; offset?: number },
  ): void;
};

/** Own range updates below the timeline so scrolling doesn't rebuild message props. */
export function TimelineVirtualizer({
  ref,
  children,
  scrollRef,
  keepMounted,
  startMargin,
  cache,
}: {
  ref: Ref<TimelineVirtualizerHandle>;
  children: ReactElement[];
  scrollRef: RefObject<HTMLElement | null>;
  keepMounted: number[];
  startMargin: number;
  cache?: VirtualItem[];
}) {
  const scrollPadding = useRef(0);
  const previousEdges = useRef([children[0]?.key, children.at(-1)?.key]);
  const prependedRow = useRef<ReactElement["key"]>(null);
  const first = children[0]?.key;
  const last = children.at(-1)?.key;
  if (first !== previousEdges.current[0] && last === previousEdges.current[1]) {
    prependedRow.current = previousEdges.current[0] ?? null;
  }
  previousEdges.current = [first, last];
  const getItemKey = useCallback(
    (index: number) => children[index]?.key ?? index,
    [children],
  );
  const virtualizer = useVirtualizer<HTMLElement, HTMLLIElement>({
    count: children.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 80,
    anchorTo: "end",
    // The timeline owns follow intent, including sends and explicit targets.
    followOnAppend: false,
    scrollMargin: startMargin,
    scrollPaddingStart: scrollPadding.current,
    initialMeasurementsCache: cache ?? [],
    measureElement(element, entry, instance) {
      const key = instance.options.getItemKey(Number(element.dataset.index));
      // Preserve fractional row geometry; the default rounds each row to pixels.
      const size =
        entry?.borderBoxSize[0]?.blockSize ??
        instance.itemSizeCache.get(key) ??
        element.getBoundingClientRect().height;
      // A no-op measurement must also consume the one-prepend exception.
      if (
        key === prependedRow.current &&
        size === instance.itemSizeCache.get(key)
      ) {
        prependedRow.current = null;
      }
      return size;
    },
    scrollToFn(offset, { adjustments = 0, behavior }, instance) {
      const element = instance.scrollElement;
      if (!element) return;
      // Undefined behavior identifies automatic resize/prepend corrections.
      // Preserve the existing desktop WebKit momentum workaround for both.
      const end = element.scrollHeight - element.clientHeight;
      const target = offset + adjustments;
      const top = target >= end - 1 ? Math.ceil(target) : target;
      if (behavior === undefined)
        correctScrollTop(element, top - element.scrollTop);
      else element.scrollTo({ top, behavior });
    },
    rangeExtractor: (range) => {
      // Preserve the previous 1600px directional buffer rather than comparing
      // different amounts of mounted message content across engines.
      const top = virtualizer.scrollOffset ?? 0;
      const bottom = top + (virtualizer.scrollRect?.height ?? 0);
      const before =
        !virtualizer.isScrolling || virtualizer.scrollDirection !== "forward"
          ? 1600
          : 0;
      const after =
        !virtualizer.isScrolling || virtualizer.scrollDirection !== "backward"
          ? 1600
          : 0;
      const first = Math.min(
        range.startIndex,
        virtualizer.getVirtualItemForOffset(Math.max(0, top - before))?.index ??
          range.startIndex,
      );
      const last = Math.max(
        range.endIndex,
        virtualizer.getVirtualItemForOffset(bottom + after)?.index ??
          range.endIndex,
      );
      const indices = new Set(keepMounted);
      for (let index = first; index <= last; index++) indices.add(index);
      return [...indices]
        .filter((index) => index >= 0 && index < range.count)
        .sort((a, b) => a - b);
    },
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) => {
    const top = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    if (item.key === prependedRow.current) {
      prependedRow.current = null;
      // Prepending can remove the old first row's day divider and byline.
      // Preserve its visible message text, not just the wrapper's top edge.
      return item.start < top + (instance.scrollRect?.height ?? 0);
    }
    return !instance.itemSizeCache.has(item.key)
      ? item.start < top
      : item.end <= top && instance.scrollDirection !== "backward";
  };
  useImperativeHandle(
    ref,
    () => ({
      get cache() {
        return virtualizer.takeSnapshot();
      },
      scrollTo(offset) {
        virtualizer.scrollToOffset(offset);
      },
      scrollToIndex(index, { align, offset = 0 }) {
        // Keep index-based reconciliation while restoring a row's exact viewport Y.
        scrollPadding.current = -offset;
        virtualizer.setOptions({
          ...virtualizer.options,
          scrollPaddingStart: -offset,
        });
        virtualizer.scrollToIndex(index, { align });
      },
    }),
    [virtualizer],
  );
  return (
    <ol
      style={{
        contain: "size style",
        overflowAnchor: "none",
        flex: "none",
        position: "relative",
        width: "100%",
        height: virtualizer.getTotalSize(),
      }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <li
          key={item.key}
          ref={virtualizer.measureElement}
          data-index={item.index}
          style={{
            contain: "layout style",
            position: "absolute",
            width: "100%",
            left: 0,
            top: item.start - startMargin,
          }}
        >
          {children[item.index]}
        </li>
      ))}
    </ol>
  );
}
