// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarUnread, type UnreadDmPreview } from "./SidebarUnread";

// Controlled geometry tests the production projection, not browser layout.
// Real scrolling, clipping and collapsed-section geometry remain browser checks.
let frameId = 0;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = this.tagName === "NAV" ? 100 : Number(this.dataset.top ?? 0);
      const height = this.tagName === "NAV" ? 200 : 20;
      return {
        top,
        bottom: top + height,
        left: 0,
        right: 240,
        width: 240,
        height,
        x: 0,
        y: top,
        toJSON() {},
      };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function measure() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}
const preview = (name: string): UnreadDmPreview => ({ name });
const avatars = (button: HTMLElement) =>
  [...button.querySelectorAll<HTMLElement>("[data-unread-dm]")].map(
    (el) => el.dataset.unreadDm,
  );
function row(id: string, top: number, onClick = vi.fn()) {
  return (
    <button
      key={`${id}-${top}`}
      type="button"
      data-channel-id={id}
      data-top={top}
      onClick={onClick}
    >
      {id}
      <span data-channel-unread="" />
      <span data-channel-activity="" />
    </button>
  );
}

it.each([0, 1, 3, 5])(
  "previews at most three of %i eligible DMs without changing the conversation count",
  async (count) => {
    const previews = new Map(
      Array.from({ length: count }, (_, i) => [
        `dm-${i}`,
        preview(`Person ${i}`),
      ]),
    );
    render(
      <SidebarUnread dmPreviews={previews}>
        {row("ordinary", 310)}
        {Array.from(previews.keys(), (id, i) => row(id, 340 + 30 * i))}
      </SidebarUnread>,
    );
    await measure();
    const pill = screen.getByRole("button", {
      name: `${count + 1} unread ${count ? "conversations" : "conversation"} below`,
    });
    expect(pill).toHaveTextContent(`${count + 1} unread`);
    expect(avatars(pill)).toEqual([...previews.keys()].slice(0, 3));
    expect(pill.querySelectorAll("[role=img]")).toHaveLength(0);
    expect(pill).not.toHaveTextContent(/\+\d/);
  },
);

it("orders each stack nearest-first while revealing the nearest conversation, not a farther DM", async () => {
  const selected = vi.fn();
  const previews = new Map(
    ["far-above", "near-above", "near-below", "far-below"].map((id) => [
      id,
      preview(id),
    ]),
  );
  render(
    <SidebarUnread dmPreviews={previews}>
      {row("far-above", 0)}
      {row("near-above", 40)}
      {row("ordinary-above", 70, selected)}
      {row("visible", 150)}
      {row("ordinary-below", 310, selected)}
      {row("near-below", 340)}
      {row("far-below", 400)}
    </SidebarUnread>,
  );
  await measure();
  const above = screen.getByRole("button", {
    name: "3 unread conversations above",
  });
  const below = screen.getByRole("button", {
    name: "3 unread conversations below",
  });
  expect(avatars(above)).toEqual(["near-above", "far-above"]);
  expect(avatars(below)).toEqual(["near-below", "far-below"]);
  fireEvent.click(above);
  await measure();
  expect(screen.getByRole("button", { name: "ordinary-above" })).toHaveFocus();
  fireEvent.click(below);
  await measure();
  expect(screen.getByRole("button", { name: "ordinary-below" })).toHaveFocus();
  expect(selected).not.toHaveBeenCalled();
});

it("counts each destination once and suppresses any with a partly visible copy", async () => {
  render(
    <SidebarUnread>
      {row("visible-copy", 0)}
      {row("visible-copy", 90)}
      {row("duplicate", 310)}
      {row("duplicate", 350)}
      {row("thread-and-message", 400)}
    </SidebarUnread>,
  );
  await measure();
  expect(
    screen.queryByRole("button", { name: /conversations? above/ }),
  ).not.toBeInTheDocument();
  const pill = screen.getByRole("button", {
    name: "2 unread conversations below",
  });
  fireEvent.click(pill);
  await measure();
  expect(screen.getAllByRole("button", { name: "duplicate" })[0]).toHaveFocus();
});

it("refreshes artwork and shapes without waiting for geometry or adding unread state", async () => {
  const children = [row("dm", 340), row("group-dm", 370), row("self-dm", 400)];
  const view = render(
    <SidebarUnread dmPreviews={new Map([["dm", preview("Alice")]])}>
      {children}
    </SidebarUnread>,
  );
  await measure();
  const pill = screen.getByRole("button", {
    name: "3 unread conversations below",
  });
  expect(avatars(pill)).toEqual(["dm"]);
  expect(pill.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(pill.querySelector("[data-unread-dm]")).toHaveTextContent("A");
  view.rerender(
    <SidebarUnread
      dmPreviews={
        new Map([
          ["dm", { name: "Agent", src: "/new-avatar.png", isAgent: true }],
        ])
      }
    >
      {children}
    </SidebarUnread>,
  );
  expect(pill.querySelector("img")).toHaveAttribute("src", "/new-avatar.png");
  expect(pill.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  const image = pill.querySelector("img");
  if (!image) throw new Error("Updated avatar image is missing");
  fireEvent.error(image);
  expect(pill.querySelector("[data-unread-dm]")).toHaveTextContent("A");
  view.rerender(
    <SidebarUnread dmPreviews={new Map()}>{children}</SidebarUnread>,
  );
  expect(avatars(pill)).toEqual([]);
  expect(pill).toHaveTextContent("3 unread");
});

it("removes both counts and previews when unread markers disappear", async () => {
  const previews = new Map([["dm", preview("Alice")]]);
  const view = render(
    <SidebarUnread dmPreviews={previews}>{row("dm", 340)}</SidebarUnread>,
  );
  await measure();
  const cue = screen.getByRole("button", {
    name: "1 unread conversation below",
  });
  const surface = cue.closest("[data-visible]");
  expect(surface).toHaveAttribute("data-visible", "true");
  expect(surface).not.toHaveAttribute("inert");
  view.rerender(
    <SidebarUnread dmPreviews={previews}>
      <button type="button" data-channel-id="dm" data-top="340">
        dm
      </button>
    </SidebarUnread>,
  );
  fireEvent.scroll(screen.getByRole("navigation"));
  await measure();
  expect(
    screen.queryByRole("button", { name: /unread conversation/ }),
  ).not.toBeInTheDocument();
  // Keep the surface for its exit transition, but exclude hidden controls.
  expect(surface).toBeInTheDocument();
  expect(surface).toHaveAttribute("inert");
  expect(surface).toHaveAttribute("aria-hidden", "true");
  expect(surface).toHaveAttribute("data-visible", "false");
  view.rerender(
    <SidebarUnread dmPreviews={previews}>{row("dm", 340)}</SidebarUnread>,
  );
  fireEvent.scroll(screen.getByRole("navigation"));
  await measure();
  expect(
    screen.getByRole("button", {
      name: "1 unread conversation below",
    }),
  ).toBe(cue);
  expect(surface).not.toHaveAttribute("inert");
  expect(surface).toHaveAttribute("data-visible", "true");
});

it("updates reused destinations after attribute changes, including a now-visible duplicate", async () => {
  const view = render(
    <SidebarUnread>
      {row("visible", 150)}
      {row("near", 340)}
      {row("far", 400)}
    </SidebarUnread>,
  );
  await measure();
  const near = screen.getByRole("button", { name: "near" });
  const navigation = screen.getByRole("navigation");
  // Attribute changes reuse the actual row and marker nodes. The next frame
  // must see them even if the mutation callback has not run yet.
  near.querySelector("[data-channel-activity]")?.remove();
  screen
    .getByRole("button", { name: "far" })
    .querySelector("[data-channel-activity]")
    ?.remove();
  fireEvent.scroll(navigation);
  await measure();
  const cue = screen.getByRole("button", {
    name: "2 unread conversations below",
  });
  expect(cue).toHaveAttribute("data-attention", "false");
  near.setAttribute("data-channel-type", "dm");
  fireEvent.scroll(navigation);
  await measure();
  expect(cue).toHaveAttribute("data-attention", "true");
  near.removeAttribute("data-channel-type");
  near
    .querySelector("[data-channel-unread]")
    ?.setAttribute("data-priority", "true");
  fireEvent.scroll(navigation);
  await measure();
  expect(cue).toHaveAttribute("data-attention", "true");
  near.setAttribute("data-channel-id", "visible");
  fireEvent.scroll(navigation);
  await measure();
  expect(cue).toHaveAccessibleName("1 unread conversation below");
  expect(cue).toHaveAttribute("data-attention", "false");
  fireEvent.click(cue);
  await measure();
  expect(screen.getByRole("button", { name: "far" })).toHaveFocus();
  view.unmount();
  expect(frames.size).toBe(0);
});

it("uses current placement at activation before a pending measurement, then follows disclosure changes", async () => {
  const selected = vi.fn();
  render(
    <SidebarUnread>
      <section data-sidebar-section="group">
        <details open>
          <summary data-top="50">Group</summary>
          {row("near", 340, selected)}
        </details>
      </section>
      {row("far", 400, selected)}
    </SidebarUnread>,
  );
  await measure();
  const near = screen.getByRole("button", { name: "near" });
  const far = screen.getByRole("button", { name: "far" });
  const cue = screen.getByRole("button", {
    name: "2 unread conversations below",
  });
  // Move an existing node, then activate synchronously before either observer
  // delivery or a frame. Focus must use the current DOM order.
  near.parentElement?.insertBefore(far, near);
  fireEvent.click(cue);
  await measure();
  expect(far).toHaveFocus();
  expect(selected).not.toHaveBeenCalled();
  const disclosure = document.querySelector("details");
  if (!disclosure) throw new Error("Missing disclosure");
  disclosure.open = false;
  fireEvent.scroll(screen.getByRole("navigation"));
  await measure();
  expect(
    screen.getByRole("button", { name: "2 unread conversations above" }),
  ).toBeInTheDocument();
  expect(cue).toHaveAccessibleName("0 unread conversations below");
  const section = disclosure.parentElement;
  section?.removeAttribute("data-sidebar-section");
  fireEvent.scroll(screen.getByRole("navigation"));
  await measure();
  expect(cue).toHaveAccessibleName("2 unread conversations below");
  section?.setAttribute("data-sidebar-section", "group");
  disclosure.open = true;
  // A resize/scroll changes geometry without changing the destination nodes.
  far.dataset.top = "150";
  fireEvent.scroll(screen.getByRole("navigation"));
  await measure();
  expect(cue).toHaveAccessibleName("1 unread conversation below");
  fireEvent.click(cue);
  await measure();
  expect(near).toHaveFocus();
});
