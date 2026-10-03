// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactElement, type ReactNode } from "react";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import type { ChannelMessage } from "../relay/contracts";
import { createRelaySession } from "../relay/session";
import { scriptedTransport } from "../relay/testing";
import { ChannelTimeline, type ChannelTimelineProps } from "./ChannelTimeline";

// Model only Virtua's mounted range and pin contract. Real React, rows and
// session subscriptions remain mounted; browser tests own scroll geometry.
const range = vi.hoisted(() => ({
  visible: undefined as number[] | undefined,
}));
vi.mock("virtua", async () => {
  const { Children, forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        keepMounted = [],
      }: {
        children: ReactNode;
        keepMounted?: readonly number[];
      },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return (
        <ol>
          {Children.toArray(children).map((child, index) =>
            !range.visible ||
            range.visible.includes(index) ||
            keepMounted.includes(index) ? (
              <li key={(child as ReactElement).key}>{child}</li>
            ) : null,
          )}
        </ol>
      );
    }),
  };
});

stubAvatarBrowserApis();
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  range.visible = undefined;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const author = "a".repeat(64);
const profileName = `View ${author.slice(0, 10)} profile`;
const allow = () => true;
const ignoreLink = () => false;
function message(id: string, seconds = 0): ChannelMessage {
  return {
    id,
    channelId: "c",
    authorId: author,
    content: `Message ${id}`,
    createdAt: new Date(2026, 8, 28, 12).getTime() / 1000 + seconds,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
}
function row(id: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-message-id="${id}"]`,
  );
  if (!element) throw new Error(`Missing message ${id}`);
  return element;
}
function mount(
  rows: readonly ChannelMessage[],
  changes: Partial<ChannelTimelineProps> = {},
) {
  const owner = createRelaySession(null);
  owners.push(owner);
  let props: ChannelTimelineProps = {
    channelId: "c",
    scope: "scope",
    queries: owner.session,
    window: {
      channelId: "c",
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      error: undefined,
      rows,
    },
    onOpenLink: ignoreLink,
    canOpenLink: allow,
    ...changes,
  };
  const tree = () => (
    <StrictMode>
      <ChannelTimeline {...props} />
      <button type="button">Outside history</button>
    </StrictMode>
  );
  const view = render(tree());
  return {
    update(change: Partial<ChannelTimelineProps> = {}) {
      props = { ...props, ...change };
      view.rerender(tree());
    },
    removeThreadCallback() {
      delete props.onOpenThread;
      view.rerender(tree());
    },
    rows(next: readonly ChannelMessage[]) {
      props = { ...props, window: { ...props.window, rows: next } };
      view.rerender(tree());
    },
  };
}

it("uses current same-channel callbacks and link capability while rows stay unchanged", async () => {
  const user = userEvent.setup();
  const targetId = "1".repeat(64);
  const firstLink = vi.fn(() => true),
    nextLink = vi.fn(() => true);
  const firstThread = vi.fn(),
    nextThread = vi.fn();
  const h = mount([{ ...message(targetId), replyCount: 1 }], {
    onOpenLink: firstLink,
    onOpenThread: firstThread,
  });
  const profile = () =>
    within(row(targetId)).getByRole("button", { name: profileName });
  const thread = () =>
    within(row(targetId)).getByRole("button", { name: "View thread: 1 reply" });
  await user.click(profile());
  await user.click(thread());

  // Change one dependency at a time: a different prop cannot mask a stale memo.
  h.update({ onOpenLink: nextLink });
  await user.click(profile());
  expect(nextLink).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^nostr:npub1/),
  );
  expect(firstLink).toHaveBeenCalledTimes(1);
  h.update({ onOpenThread: nextThread });
  await user.click(thread());
  expect(nextThread).toHaveBeenCalledExactlyOnceWith(targetId, targetId);
  expect(firstThread).toHaveBeenCalledTimes(1);

  h.update({ canOpenLink: () => false });
  expect(
    within(row(targetId)).queryByRole("button", { name: profileName }),
  ).toBeNull();
  h.update({ canOpenLink: allow });
  expect(profile()).toBeInTheDocument();
  h.removeThreadCallback();
  expect(
    within(row(targetId)).queryByRole("button", { name: /View thread:/ }),
  ).toBeNull();
});

it("uses the current media-review callback and session media for unchanged rows", async () => {
  const transport = () => scriptedTransport(author, "b".repeat(64)).transport;
  const first = createRelaySession(transport());
  const next = createRelaySession({
    ...transport(),
    media: () => "https://fixture.test/current-session.png",
  });
  owners.push(first, next);
  const attachment = {
    kind: "image" as const,
    url: "https://fixture.test/photo.png",
  };
  const firstOpen = vi.fn(),
    nextOpen = vi.fn();
  const h = mount([{ ...message("media"), attachments: [attachment] }], {
    queries: first.session,
    continuityKey: "media-view",
    onOpenMediaReview: firstOpen,
  });
  const opener = () =>
    within(row("media")).getByRole("link", {
      name: "Open image attachment",
    });
  const user = userEvent.setup();
  expect(opener().querySelector("img")).toHaveAttribute("src", attachment.url);
  await user.click(opener());
  expect(firstOpen).toHaveBeenCalledExactlyOnceWith(
    "media",
    attachment,
    0,
    false,
  );
  h.update({ onOpenMediaReview: nextOpen });
  await user.click(opener());
  expect(nextOpen).toHaveBeenCalledExactlyOnceWith(
    "media",
    attachment,
    0,
    false,
  );
  expect(firstOpen).toHaveBeenCalledTimes(1);

  h.update({ queries: next.session });
  expect(opener().querySelector("img")).toHaveAttribute(
    "src",
    "https://fixture.test/current-session.png",
  );
  await user.click(opener());
  expect(nextOpen).toHaveBeenCalledTimes(2);
  expect(firstOpen).toHaveBeenCalledTimes(1);
});

it("updates membership attribution when only the current viewer changes", () => {
  const actor = "b".repeat(64);
  const membership = {
    ...message("membership"),
    membership: { type: "member_joined" as const, actor, target: author },
  };
  const h = mount([membership], { viewer: actor });
  expect(
    within(row("membership")).getByText("aaaaaaaaaa added by you"),
  ).toBeInTheDocument();
  h.update({ viewer: author });
  expect(
    within(row("membership")).getByText("You were added by bbbbbbbbbb"),
  ).toBeInTheDocument();
  expect(
    within(row("membership")).queryByText("aaaaaaaaaa added by you"),
  ).toBeNull();
});

it("updates day and author grouping after reorder, and replaces edited content under the same key", () => {
  const first = message("first"),
    second = message("second", 60);
  const h = mount([first, second]);
  const day = "Monday, September 28, 2026";
  expect(within(row("first")).getByText(day)).toBeInTheDocument();
  expect(within(row("second")).queryByText(day)).toBeNull();
  expect(
    within(row("second")).queryByRole("button", { name: profileName }),
  ).toBeNull();

  h.rows([second, first]);
  expect(within(row("second")).getByText(day)).toBeInTheDocument();
  expect(within(row("first")).queryByText(day)).toBeNull();
  expect(
    within(row("first")).getByRole("button", { name: profileName }),
  ).toBeInTheDocument();
  h.rows([
    {
      ...second,
      content: "Edited message",
      reactions: [
        {
          content: "👍",
          events: [{ id: "reaction", authorId: author }],
        },
      ],
    },
  ]);
  expect(screen.queryByText("Message first")).toBeNull();
  expect(screen.queryByText("Message second")).toBeNull();
  expect(within(row("second")).getByText("Edited message")).toBeInTheDocument();
  expect(within(row("second")).getByText("👍 1")).toBeInTheDocument();
});

it("retains the focused row across range eviction and reordering, then releases it on focus exit", async () => {
  const first = message("first"),
    second = message("second", 600);
  const h = mount([first, second]);
  const target = row("first");
  const trigger = within(target).getByRole("button", { name: profileName });
  act(() => trigger.focus());
  range.visible = [1];
  h.update();
  expect(row("first")).toBe(target);

  range.visible = [0];
  h.rows([second, first]);
  expect(row("first")).toBe(target);
  expect(trigger).toHaveFocus();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Outside history" }));
  expect(document.querySelector('[data-message-id="first"]')).toBeNull();
  expect(row("second")).toBeInTheDocument();
});
