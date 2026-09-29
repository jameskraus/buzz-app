// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { UnreadCapability } from "../relay/unread";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { CommunityRail } from "./CommunityRail";
import { INVITES_SECTION } from "./CommunityRailItem";
import { MEMBERSHIP_KIND, type Role } from "./roster";
import {
  createCommunities,
  type Communities,
  type ClientSnapshot,
} from "./service";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
const viewer = "a".repeat(64);
const relayKey = "f".repeat(64);
const primary = "https://primary.example";
const secondary = "https://secondary.example";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A rail over two saved communities; only the selected one has a session. */
function harness({
  selected = primary,
  role = "owner" as Role,
  status = "ready" as RelaySnapshot["status"],
  capability = "frontier-sync" as UnreadCapability["sync"] extends () => {
    capability: infer C;
  }
    ? C
    : never,
} = {}) {
  let snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    viewer,
    selected,
    memberships: [
      { id: primary, name: "Primary" },
      { id: secondary, name: "Secondary" },
    ],
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const select = vi.fn((id: string | null) => {
    snapshot = { ...snapshot, selected: id };
    notify();
  });
  const read = vi.fn(async () => [
    {
      id: "e".repeat(64),
      kind: MEMBERSHIP_KIND,
      pubkey: relayKey,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["-"], ["member", viewer, role]],
    },
  ]);
  const markAllChannelsRead = vi.fn(async () => []);
  const session = {
    read,
    unread: {
      sync: () => ({ capability }),
      subscribeSync: () => () => {},
      markAllChannelsRead,
    },
  };
  const connection = {
    status,
    generation: 1,
    scope: `${selected}:${viewer}`,
    viewer,
    session,
  } as unknown as RelaySnapshot;
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const communities = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    relay,
  } as unknown as Communities;
  const fetch = vi.fn(async (url: string) =>
    String(url).endsWith("/session")
      ? Response.json({ relayAuthor: relayKey })
      : Response.json({}, { status: 404 }),
  );
  vi.stubGlobal("fetch", fetch);
  const onOpenTarget = vi.fn();
  return {
    communities,
    select,
    read,
    fetch,
    markAllChannelsRead,
    onOpenTarget,
    update(change: Partial<ClientSnapshot>) {
      act(() => {
        snapshot = { ...snapshot, ...change };
        notify();
      });
    },
  };
}

const button = (name: string) =>
  screen.getByRole("button", { name: `Switch to ${name}` });
async function openMenu(name: string) {
  fireEvent.contextMenu(button(name), { clientX: 20, clientY: 20 });
  return await screen.findByRole("menu", { name: `Actions for ${name}` });
}
const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);
/** Roster lookups start with the broker session route; icon discovery is separate. */
const sessionRequests = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.endsWith("/session"));

it("switches using the shared membership owner without acquiring other sessions on render", () => {
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  expect(h.select).not.toHaveBeenCalled();
  expect(
    screen.getByRole("navigation", { name: "Communities" }),
  ).toBeInTheDocument();
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  fireEvent.click(button("Secondary"));
  expect(h.select).toHaveBeenCalledWith(secondary);
  expect(button("Secondary")).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "Personal space" }));
  expect(h.select).toHaveBeenCalledWith(null);
  expect(
    screen.getByRole("button", { name: "Personal space" }),
  ).toHaveAttribute("aria-current", "true");
  const add = screen.getByRole("button", { name: "Add a community" });
  fireEvent.click(add);
  expect(
    screen.getByRole("heading", { name: "Add a community" }),
  ).toBeInTheDocument();
  expect(h.select).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(button("Primary")).toBeInTheDocument();

  h.update({ memberships: [{ id: secondary, name: "Secondary" }] });
  expect(
    screen.queryByRole("button", { name: "Switch to Primary" }),
  ).not.toBeInTheDocument();
  // Without host navigation there is no Settings to open, so no roster was read
  // for a rail that only switches communities.
  expect(h.read).not.toHaveBeenCalled();
  expect(sessionRequests(h.fetch)).toEqual([]);
});

it("offers the original's actions on the selected community and only reads its roster", async () => {
  const h = harness();
  render(
    <CommunityRail communities={h.communities} onOpenTarget={h.onOpenTarget} />,
  );
  const menu = await openMenu("Primary");
  await within(menu).findByRole("menuitem", { name: "Invite to community" });
  expect(items(menu)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Invite to community",
    "Community settings",
  ]);
  expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  expect(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  ).not.toHaveAttribute("aria-disabled");
  // Role comes from the relay-signed roster, exactly as the Invites card reads it.
  expect(h.read).toHaveBeenCalledWith(
    [{ kinds: [MEMBERSHIP_KIND], authors: [relayKey], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  const requests = sessionRequests(h.fetch);
  expect(requests.length).toBeGreaterThan(0);
  for (const url of requests)
    expect(url).toBe(`/api/relay/${encodeURIComponent(primary)}/session`);
  expect(h.select).not.toHaveBeenCalled();
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // An inactive community exposes the same menu without a session behind it.
  const reads = h.read.mock.calls.length;
  const inactive = await openMenu("Secondary");
  expect(items(inactive)).toEqual([
    "Mark all as read",
    "Copy community URL",
    "Community settings",
  ]);
  const markAll = within(inactive).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(
    "Only the selected community can be marked as read.",
  );
  fireEvent.click(markAll);
  expect(h.markAllChannelsRead).not.toHaveBeenCalled();
  expect(h.read).toHaveBeenCalledTimes(reads);
  expect(sessionRequests(h.fetch)).toEqual(requests);
  expect(h.select).not.toHaveBeenCalled();
});

it.each(["ContextMenu", "F10"])(
  "opens from the keyboard with %s and returns focus to the community",
  async (key) => {
    const h = harness();
    render(
      <CommunityRail
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
      />,
    );
    const target = button("Secondary");
    target.focus();
    fireEvent.keyDown(target, { key, shiftKey: key === "F10" });
    const menu = await screen.findByRole("menu", {
      name: "Actions for Secondary",
    });
    expect(h.select).not.toHaveBeenCalled();
    // Anchored beside the rail item, not at a cursor point.
    expect(menu).toHaveAttribute("data-side", "right");
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(target));
  },
);

it("keeps the keyboard anchor when a synthesised contextmenu event re-enters the open", async () => {
  const h = harness();
  render(
    <CommunityRail communities={h.communities} onOpenTarget={h.onOpenTarget} />,
  );
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  const target = button("Primary");
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  expect(menu).toHaveAttribute("data-side", "right");
  // Chromium and Firefox synthesise a contextmenu event for Shift+F10 unless the
  // keydown is cancelled; Base UI turns it into a second open request. The
  // roster re-read shows that request reached the rail item.
  fireEvent.contextMenu(target, { clientX: 20, clientY: 20 });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(3));
  await act(async () => {});
  expect(menu).toHaveAttribute("data-side", "right");
  fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(target));
});

it("re-reads the roster for a keyboard open exactly as for a pointer open", async () => {
  const h = harness();
  render(
    <CommunityRail communities={h.communities} onOpenTarget={h.onOpenTarget} />,
  );
  // The selected community's roster is read once on mount.
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
  const target = button("Primary");
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  await within(menu).findByRole("menuitem", { name: "Invite to community" });
  fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openMenu("Primary");
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(3));
});

it("returns focus after a pointer open to where it was, not to the rail", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const h = harness();
  render(
    <>
      <input aria-label="Composer" />
      <CommunityRail communities={h.communities} />
    </>,
  );
  const composer = screen.getByRole("textbox", { name: "Composer" });
  composer.focus();
  const menu = await openMenu("Primary");
  expect(menu).toHaveAttribute("data-side", "bottom");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  // Right-clicking a community while typing must not move the caret to the rail.
  await waitFor(() => expect(composer).toHaveFocus());
  expect(button("Primary")).not.toHaveFocus();
});

it("copies the canonical community origin and reports the outcome", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("denied"));
  const h = harness({ selected: secondary });
  render(<CommunityRail communities={h.communities} />);
  let menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  expect(write).toHaveBeenCalledWith(primary);
  const copied = await screen.findByText("Community URL copied.");
  expect(copied.closest(".buzz-toast")).not.toBeNull();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy community URL" }),
  );
  await screen.findByText("Couldn’t copy the community URL.");
  expect(write).toHaveBeenCalledTimes(2);
  // Copying an inactive community's URL never acquired its session.
  expect(h.read).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
});

it("marks every channel read through the selected session and reports failures", async () => {
  const user = userEvent.setup();
  const h = harness();
  h.markAllChannelsRead
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("disk full"));
  render(<CommunityRail communities={h.communities} />);
  let menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  );
  expect(h.markAllChannelsRead).toHaveBeenCalledTimes(1);
  await screen.findByText("Marked all as read.");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  menu = await openMenu("Primary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Mark all as read" }),
  );
  await screen.findByText("Couldn’t mark everything as read.");
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  {
    name: "the connection is not ready",
    options: { status: "connecting" as const },
    note: "Waiting for Primary to connect.",
  },
  {
    name: "read state cannot sync",
    options: { capability: "unsupported" as const },
    note: "Read state can’t sync on this connection.",
  },
])("disables Mark all as read while $name", async ({ options, note }) => {
  const h = harness(options);
  render(<CommunityRail communities={h.communities} />);
  const menu = await openMenu("Primary");
  const markAll = within(menu).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(note);
  fireEvent.click(markAll);
  expect(h.markAllChannelsRead).not.toHaveBeenCalled();
});

it("opens Invites and Community settings scoped to the community", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(
    <CommunityRail communities={h.communities} onOpenTarget={h.onOpenTarget} />,
  );
  let menu = await openMenu("Primary");
  await user.click(
    await within(menu).findByRole("menuitem", { name: "Invite to community" }),
  );
  expect(h.onOpenTarget).toHaveBeenLastCalledWith({
    version: 1,
    kind: "settings",
    section: INVITES_SECTION,
    scope: { viewer, communityOrigin: primary },
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // Settings for an inactive community: the scoped target selects it on the
  // way, so the rail itself neither selects nor connects.
  menu = await openMenu("Secondary");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Community settings" }),
  );
  expect(h.onOpenTarget).toHaveBeenLastCalledWith({
    version: 1,
    kind: "settings",
    section: "profile",
    scope: { viewer, communityOrigin: secondary },
  });
  expect(h.onOpenTarget).toHaveBeenCalledTimes(2);
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  { role: "admin" as const, invites: true },
  { role: "member" as const, invites: false },
])(
  "shows Invite to community for a $role: $invites",
  async ({ role, invites }) => {
    const h = harness({ role });
    render(
      <CommunityRail
        communities={h.communities}
        onOpenTarget={h.onOpenTarget}
      />,
    );
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    const menu = await openMenu("Primary");
    if (invites)
      await within(menu).findByRole("menuitem", {
        name: "Invite to community",
      });
    else {
      await within(menu).findByRole("menuitem", { name: "Community settings" });
      expect(
        within(menu).queryByRole("menuitem", { name: "Invite to community" }),
      ).toBeNull();
    }
  },
);

it("does not discover saved community icons without a relay host", async () => {
  const viewer = "e".repeat(64);
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Local", picture: "" },
      memberships: [{ id: "https://saved.example", name: "Saved" }],
      selected: "https://saved.example",
    }),
  );
  const ctx = new Context();
  vi.stubGlobal("fetch", vi.fn());
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    render(<CommunityRail communities={communities} />);
    expect(
      screen.getByRole("button", { name: "Switch to Saved" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add a community" }));
    expect(
      screen.getByText(/connecting to communities is not available/),
    ).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
  }
});
