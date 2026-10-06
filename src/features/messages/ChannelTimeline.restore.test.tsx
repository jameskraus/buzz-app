// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import type { ChannelWindow } from "../relay/contracts";
import { keypair, message, scriptedTransport } from "../relay/testing";
import { readView, writeView } from "../../shared/view-state";

// Real React lifecycle; only the virtualizer's imperative layout boundary is
// modeled here. Browser journeys retain the actual same-message/4px contract.
const scroll = vi.hoisted(() => ({ toIndex: vi.fn(), toOffset: vi.fn() }));
vi.mock("./TimelineVirtualizer", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    TimelineVirtualizer: forwardRef(function Virtualizer(
      { children }: { children: ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollToIndex: scroll.toIndex,
        scrollTo: scroll.toOffset,
      }));
      return <ol style={{ height: 2000 }}>{children}</ol>;
    }),
  };
});
const frames = new Map<number, FrameRequestCallback>();
const resizes = new Set<() => void>();
let nextFrame = 0;
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  scroll.toIndex.mockClear();
  scroll.toOffset.mockClear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        resizes.add(this.callback);
      }
      disconnect() {
        resizes.delete(this.callback);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function frame() {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
}
function mount(bottom = false, revealOnMount = false) {
  const viewer = keypair(),
    relay = keypair();
  const target = message(viewer, "c", "Saved reading anchor", 1);
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  writeView("scope", "scroll:c", {
    offset: 900,
    bottom,
    anchor: { id: target.id, y: 42 },
  });
  const window: ChannelWindow = {
    channelId: "c",
    status: "ready",
    freshness: "cached",
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    rows: [
      {
        id: target.id,
        channelId: "c",
        authorId: viewer.pubkey,
        content: target.content,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      },
    ],
  };
  const tree = (snapshot: ChannelWindow, revealMessageId?: string) => (
    <StrictMode>
      <ChannelTimeline
        channelId="c"
        scope="scope"
        queries={owner.session}
        window={snapshot}
        revealMessageId={revealMessageId}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  const first = window.rows[0];
  if (!first) throw new Error("Missing fixture row");
  const sent = { ...first, id: "sent", content: "New message" };
  const older = {
    ...first,
    id: "older",
    content: "Older history",
    createdAt: 0,
  };
  const sentWindow = { ...window, rows: [...window.rows, sent] };
  const result = render(
    revealOnMount ? tree(sentWindow, sent.id) : tree(window),
  );
  return {
    saved: { offset: 900, bottom, anchor: { id: target.id, y: 42 } },
    unmount: result.unmount,
    reveal() {
      result.rerender(tree(sentWindow, sent.id));
    },
    refreshSent() {
      result.rerender(
        tree({ ...sentWindow, rows: [...sentWindow.rows] }, sent.id),
      );
    },
    awaitReveal() {
      result.rerender(tree(window, sent.id));
    },
    prependOlder() {
      // An older-history page lands while the sent row is still revealing.
      result.rerender(
        tree({ ...sentWindow, rows: [older, ...sentWindow.rows] }, sent.id),
      );
    },
    replaceAnchor() {
      const first = window.rows[0];
      if (!first) throw new Error("Missing fixture row");
      result.rerender(
        tree({ ...window, rows: [{ ...first, id: "replacement" }] }),
      );
    },
    promote() {
      result.rerender(
        tree({ ...window, freshness: "verified", rows: [...window.rows] }),
      );
    },
    async measured() {
      await act(async () => {
        screen.getByRole("list").style.height = "2120px";
        await Promise.resolve(); // deliver the real MutationObserver before rAF
      });
    },
  };
}
it("retains the saved anchor correction when cached rows are promoted before its frame", async () => {
  const h = mount();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
  scroll.toIndex.mockClear();
  await h.measured();
  h.promote();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
});
it("reader input cancels the queued correction even when cached rows are then promoted", async () => {
  const h = mount();
  await frame();
  scroll.toIndex.mockClear();
  await h.measured();
  fireEvent.wheel(
    screen.getByRole("region", { name: "Channel message history" }),
  );
  h.promote();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "local reveal retires restoration without canceling existing bottom follow=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    const calls = scroll.toIndex.mock.calls.length;
    await h.measured();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    expect(scroll.toIndex.mock.calls.length).toBe(calls + 1);
  },
);

it.each(["none", "wheel", "key"])(
  "a reveal on mount follows late measurements unless reader input=%s",
  async (input) => {
    const h = mount(false, true);
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    scroll.toIndex.mockClear();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    if (input === "key") fireEvent.keyDown(feed, { key: "PageUp" });
    await h.measured();
    await frame();
    if (input === "none") {
      expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
      h.unmount();
      expect(readView("scope", "scroll:c", null)).toMatchObject({
        bottom: true,
      });
    } else expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it.each(["wheel", "key"])(
  "reader input before the reveal frame stays authoritative after a row refresh or prepend: %s",
  async (input) => {
    const h = mount();
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    if (input === "wheel") fireEvent.wheel(feed);
    else fireEvent.keyDown(feed, { key: "PageUp" });
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    // A later echo/edit replaces rows; it must not revive the canceled reveal.
    h.refreshSent();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    // Nor may an older-history page, which reruns the effect as a prepend.
    h.prependOlder();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "an older-history prepend before the reveal frame still reveals the sent row, read up first=%s",
  async (readUp) => {
    const h = mount(true);
    await frame();
    await frame();
    if (readUp) {
      fireEvent.wheel(
        screen.getByRole("region", { name: "Channel message history" }),
      );
      await frame();
    }
    scroll.toIndex.mockClear();
    h.reveal();
    // The prepend cancels the reveal frame before it runs; the rerun must
    // reschedule the reveal at the sent row's new index, not lose it.
    h.prependOlder();
    await frame();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(2, { align: "end" });
    expect(scroll.toIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  },
);

it.each([false, true])(
  "a completed reveal is not rescheduled by a later older-history prepend, bottom=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    scroll.toIndex.mockClear();
    // The reveal is recorded only once its scroll runs. A page landing after
    // that must find it complete, not reschedule it at the sent row's new index.
    h.prependOlder();
    await frame();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
  },
);

it("waits for a sent row to arrive without restoring over its reveal", async () => {
  const h = mount();
  await frame();
  h.awaitReveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalledWith(1, { align: "end" });
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  h.reveal();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

it.each([false, true])(
  "the first intermediate bottom-follow scroll retains intent unless reader input=%s",
  async (readerInput) => {
    const h = mount(true);
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Virtua can deliver an intermediate offset before measuring its final range.
    feed.scrollTop = 162;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    scroll.toIndex.mockClear();
    await h.measured();
    await frame();
    if (readerInput) expect(scroll.toIndex).not.toHaveBeenCalled();
    else expect(scroll.toIndex).toHaveBeenLastCalledWith(0, { align: "end" });
  },
);

it("a resize before the local reveal scroll event cannot revive the prior reading anchor", async () => {
  const h = mount();
  await frame();
  h.reveal();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  scroll.toIndex.mockClear();
  // Composer/sidebar layout may resize before the browser delivers scroll.
  await act(async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    for (const resize of resizes) resize();
  });
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
  expect(scroll.toIndex).not.toHaveBeenCalledWith(0, {
    align: "start",
    offset: -42,
  });
});

it.each([false, true])(
  "a scroll before any visible virtual row mounts retains restoration unless reader input=%s",
  async (readerInput) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // The virtualizer has accepted the offset, but its mounted range is still
    // offscreen. No paragraph or row is available to replace the saved anchor.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? -200 : 0, 800, 100);
      },
    );
    feed.scrollTop = 900;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(
      readerInput ? { offset: 900, bottom: false } : h.saved,
    );
  },
);

it.each([false, true])(
  "does not turn cold clamps into reader follow intent, repeated=%s",
  async (repeat) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // Cold estimated row heights can clamp the restoring viewport to the bottom.
    // The saved row is mounted, so this is not the anchorless-range case above.
    let rowY = 84;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? rowY : 0, 800, 100);
      },
    );
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    if (repeat) {
      feed.scrollTop = 1200;
      rowY = 284;
      fireEvent.scroll(feed);
      feed.scrollTop = 1400;
      rowY = 84;
      fireEvent.scroll(feed);
    }
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(h.saved);
  },
);

it.each(["converged", "gesture", "removed"])(
  "allows bottom follow after restoration is superseded: %s",
  async (boundary) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? 42 : 0, 800, 100);
      },
    );
    if (boundary === "converged") {
      feed.scrollTop = 900;
      fireEvent.scroll(feed);
    } else if (boundary === "gesture") {
      fireEvent.pointerDown(feed);
    } else {
      h.replaceAnchor();
      await frame();
    }
    feed.scrollTop = 1400;
    fireEvent.scroll(feed);
    h.unmount();
    expect(
      readView<{ bottom: boolean }>("scope", "scroll:c", { bottom: false })
        .bottom,
    ).toBe(true);
  },
);

// Intent and native/virtualizer shrink can arrive in one scroll observation.
it.each([
  "wheel",
  "touch",
  "keyboard",
  "link",
  "button",
  "command up",
  "option up",
  "control up",
  "control home",
  "nested top",
  "contained top",
  "no overscroll",
] as const)(
  "%s reader input wins over shrink in the same observation",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    if (input === "wheel") fireEvent.wheel(region, { deltaY: -200 });
    if (input === "keyboard") fireEvent.keyDown(region, { key: "PageUp" });
    if (
      [
        "link",
        "button",
        "command up",
        "option up",
        "control up",
        "control home",
        "nested top",
        "contained top",
        "no overscroll",
      ].includes(input)
    ) {
      const control = document.createElement(
        input === "button" ? "button" : "a",
      );
      if (control instanceof HTMLAnchorElement)
        control.href = "https://example.com";
      control.textContent = "Message control";
      region.append(control);
      if (["nested top", "contained top", "no overscroll"].includes(input)) {
        const inner = document.createElement("div");
        inner.style.overflowY = "auto";
        inner.style.overscrollBehaviorY =
          input === "contained top"
            ? "contain"
            : input === "no overscroll"
              ? "none"
              : "auto";
        region.append(inner);
        inner.append(control);
        inner.scrollTop = 0;
      }
      control.focus();
      fireEvent.keyDown(control, {
        key: input.endsWith("up")
          ? "ArrowUp"
          : input === "control home"
            ? "Home"
            : "PageUp",
        metaKey: input === "command up",
        altKey: input === "option up",
        ctrlKey: input.startsWith("control"),
      });
    }
    if (input === "touch") {
      fireEvent.touchStart(region, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(region, { touches: [{ clientY: 300 }] });
    }
    // No intermediate stable-height scroll: native clamp, virtualizer correction
    // and the reader's movement are first seen together.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 400;
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    await h.measured();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
    });
  },
);
it.each(["keyboard", "wheel", "scrollbar"])(
  "%s movement survives a frame and shrink during the same gesture",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    if (input === "keyboard") fireEvent.keyDown(region, { key: "PageUp" });
    if (input === "wheel") fireEvent.wheel(region, { deltaY: -300 });
    if (input === "scrollbar") fireEvent.pointerDown(region);
    // The first event has not yet crossed the near-bottom threshold. A native
    // smooth scroll / drag continues after this rendering opportunity.
    region.scrollTop -= 40;
    fireEvent.scroll(region);
    await frame();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1920,
    );
    region.scrollTop -= 340; // 80px shrink plus 260px continued reader movement.
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    await h.measured();
    await frame();
    expect(scroll.toIndex).not.toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({
      bottom: false,
    });
  },
);

it.each(["auto", "contain", "none"])(
  "retires an unconsumed %s inner-top PageUp before a later layout-only shrink",
  async (containment) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    inner.style.overscrollBehaviorY = containment;
    const control = document.createElement("a");
    control.href = "https://example.com";
    inner.append(control);
    region.append(inner);
    control.focus();
    fireEvent.keyDown(control, { key: "PageUp" });
    // WebKit can consume this key without moving either scrollport. No scroll or
    // scrollend follows; let that rendering opportunity pass before later reflow.
    await frame();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 800;
    fireEvent.scroll(region);
    scroll.toIndex.mockClear();
    h.promote();
    await frame();
    expect(scroll.toIndex).toHaveBeenCalled();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  },
);

it("a finished near-bottom wheel does not taint a later layout-only shrink", async () => {
  const h = mount(true);
  await frame();
  const region = screen.getByRole("region", {
    name: "Channel message history",
  });
  region.scrollTop = 1400;
  fireEvent.scroll(region);
  fireEvent.wheel(region, { deltaY: -1 });
  region.scrollTop -= 1;
  fireEvent.scroll(region);
  fireEvent(region, new Event("scrollend"));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1600);
  region.scrollTop = 600;
  fireEvent.scroll(region);
  h.promote();
  await frame();
  h.unmount();
  expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
});

it.each([
  "editable",
  "nested scroll",
  "prevented",
  "button activation",
  "modified page up",
] as const)(
  "%s keyboard input does not claim history scrolling during shrink",
  async (input) => {
    const h = mount(true);
    await frame();
    const region = screen.getByRole("region", {
      name: "Channel message history",
    });
    region.scrollTop = 1400;
    fireEvent.scroll(region);
    const control = document.createElement(
      input === "editable" ? "textarea" : "button",
    );
    region.append(control);
    if (input === "nested scroll") {
      const inner = document.createElement("div");
      inner.style.overflowY = "auto";
      region.append(inner);
      inner.append(control);
      inner.scrollTop = 100;
    }
    if (input === "prevented")
      control.addEventListener("keydown", (event) => event.preventDefault());
    control.focus();
    fireEvent.keyDown(control, {
      key: input === "button activation" ? " " : "PageUp",
      shiftKey: input === "button activation",
      altKey: input === "modified page up",
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      1600,
    );
    region.scrollTop = 400;
    fireEvent.scroll(region);
    h.promote();
    await frame();
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toMatchObject({ bottom: true });
  },
);
