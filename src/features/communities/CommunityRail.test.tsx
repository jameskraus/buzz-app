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
import type { PurgeFailure } from "./device-state";
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

const accepted = () =>
  Response.json({ accepted: true, event_id: "1".repeat(64), message: "" });

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
  /** What the community's relay answers to the broker leave route. */
  leaveResponse = accepted as () => Response | Promise<Response>,
  /** Stores the service could not clear after forgetting the community. */
  leaveResidue = [] as PurgeFailure[],
  /** The service's own failure to save the device record, before it changes. */
  leaveError = undefined as Error | undefined,
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
  // Mirrors the service: the membership goes, and a left selection lands on
  // Personal space without the rail selecting anything. Only the save can
  // throw, and it does so before anything changes.
  const leave = vi.fn(async (id: string) => {
    if (leaveError) throw leaveError;
    snapshot = {
      ...snapshot,
      memberships: snapshot.memberships.filter((m) => m.id !== id),
      selected: snapshot.selected === id ? null : snapshot.selected,
    };
    notify();
    return leaveResidue;
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
    leave,
    relay,
  } as unknown as Communities;
  const fetch = vi.fn(async (url: string) => {
    const path = String(url);
    if (path.endsWith("/session"))
      return Response.json({ relayAuthor: relayKey });
    if (path === "/api/relay/register") return Response.json({});
    if (path.endsWith("/leave")) return leaveResponse();
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  const onOpenTarget = vi.fn();
  // The host's selection path: selects through the service, then navigates.
  const onSelect = vi.fn((id: string | null) => select(id));
  return {
    communities,
    select,
    leave,
    read,
    fetch,
    markAllChannelsRead,
    onOpenTarget,
    onSelect,
    leaveRequests: () =>
      fetch.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.endsWith("/leave")),
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
    "Leave community",
  ]);
  expect(within(menu).getAllByRole("separator")).toHaveLength(2);
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
    "Leave community",
  ]);
  expect(within(inactive).getAllByRole("separator")).toHaveLength(2);
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

/** Opens the community's menu, picks Leave and waits for the confirmation. */
async function askToLeave(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const menu = await openMenu(name);
  expect(items(menu).at(-1)).toBe("Leave community");
  await user.click(
    within(menu).getByRole("menuitem", { name: "Leave community" }),
  );
  const dialog = await screen.findByRole("alertdialog", {
    name: `Leave ${name}?`,
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return dialog;
}
const confirmLeave = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Leave community" });

it("leaves an inactive community after confirming: the relay releases it before the device forgets it", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  expect(dialog).toHaveTextContent(
    "removes Secondary from this device along with its saved drafts and reading positions",
  );
  // Nothing is sent until the viewer confirms.
  expect(h.leaveRequests()).toEqual([]);
  expect(h.leave).not.toHaveBeenCalled();
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Secondary.");
  const route = `/api/relay/${encodeURIComponent(secondary)}/leave`;
  expect(h.leaveRequests()).toEqual([route]);
  expect(h.fetch).toHaveBeenCalledWith(
    route,
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
  expect(h.leave).toHaveBeenCalledWith(secondary);
  const published =
    h.fetch.mock.invocationCallOrder[
      h.fetch.mock.calls.findIndex(([url]) => String(url) === route)
    ] ?? Infinity;
  expect(h.leave.mock.invocationCallOrder[0]).toBeGreaterThan(published);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    screen.queryByRole("button", { name: "Switch to Secondary" }),
  ).toBeNull();
  // The request went to the relay by origin; the community was never acquired
  // and the selection was never touched.
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
  expect(h.onSelect).not.toHaveBeenCalled();
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  // Focus follows the selection, which stayed put; Personal space is only
  // right when a left selection actually landed there.
  await waitFor(() => expect(button("Primary")).toHaveFocus());
  expect(
    screen.getByRole("button", { name: "Personal space" }),
  ).not.toHaveFocus();
});

it("leaving the selected community tells the host to select Personal space; an inactive one does not", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} onSelect={h.onSelect} />);
  let dialog = await askToLeave(user, "Primary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Primary.");
  // The service owns the store state; the host adds the navigation and ingress
  // recovery that clicking Personal space would, so a Settings card scoped to
  // the gone community is not left open.
  expect(h.leave).toHaveBeenCalledWith(primary);
  expect(h.onSelect).toHaveBeenCalledTimes(1);
  expect(h.onSelect).toHaveBeenCalledWith(null);
  expect(h.leave.mock.invocationCallOrder[0]).toBeLessThan(
    h.onSelect.mock.invocationCallOrder[0] ?? 0,
  );
  const personal = screen.getByRole("button", { name: "Personal space" });
  expect(personal).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(personal).toHaveFocus());

  h.update({ selected: secondary });
  dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Secondary.");
  expect(h.onSelect).toHaveBeenCalledTimes(2);
  expect(h.onSelect).toHaveBeenLastCalledWith(null);

  // Leaving a community that is not selected changes nothing about selection.
  h.update({
    memberships: [
      { id: primary, name: "Primary" },
      { id: secondary, name: "Secondary" },
    ],
    selected: primary,
  });
  dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  // The earlier "Left Secondary." toast is still showing, so wait on the
  // leave itself rather than on a second copy of the same text.
  await waitFor(() => expect(h.leave).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await screen.findAllByText("Left Secondary.")).toHaveLength(2);
  expect(h.onSelect).toHaveBeenCalledTimes(2);
  expect(button("Primary")).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(button("Primary")).toHaveFocus());
});

it("cancelling the confirmation keeps the membership and returns focus to the community", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  let dialog = await askToLeave(user, "Secondary");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(button("Secondary")).toHaveFocus());
  // Escape cancels the same way.
  dialog = await askToLeave(user, "Secondary");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(h.leaveRequests()).toEqual([]);
  expect(h.leave).not.toHaveBeenCalled();
  expect(button("Secondary")).toBeInTheDocument();
  expect(sessionRequests(h.fetch)).toEqual([]);
  expect(h.select).not.toHaveBeenCalled();
});

it.each([
  {
    name: "the relay is unreachable",
    response: () => Response.json({ error: "upstream" }, { status: 503 }),
    toast: "Couldn’t leave Secondary. Check your connection and try again.",
  },
  {
    name: "the relay rejects the request for an unknown reason",
    response: () =>
      Response.json(
        { error: "invalid: database error: secret" },
        { status: 400 },
      ),
    toast: "Couldn’t leave Secondary. Check your connection and try again.",
  },
  {
    name: "the viewer owns the relay",
    response: () =>
      Response.json(
        { error: "invalid: relay owner cannot leave" },
        { status: 400 },
      ),
    toast: "The relay owner can’t leave Secondary.",
  },
  {
    name: "the request times out",
    response: () =>
      Promise.reject(new DOMException("timed out", "TimeoutError")),
    toast: "Couldn’t leave Secondary. Check your connection and try again.",
  },
])(
  "keeps the membership when $name and leaves the item usable",
  async ({ response, toast }) => {
    const user = userEvent.setup();
    const h = harness({ leaveResponse: response });
    render(<CommunityRail communities={h.communities} />);
    const dialog = await askToLeave(user, "Secondary");
    await user.click(confirmLeave(dialog));
    await screen.findByText(toast);
    expect(h.leaveRequests()).toHaveLength(1);
    expect(h.leave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(button("Secondary")).toBeInTheDocument();
    await waitFor(() => expect(button("Secondary")).toHaveFocus());
    // The item is back to its resting label for a retry.
    const menu = await openMenu("Secondary");
    const item = within(menu).getByRole("menuitem", {
      name: "Leave community",
    });
    expect(item).not.toHaveAttribute("aria-disabled");
    expect(sessionRequests(h.fetch)).toEqual([]);
  },
);

const absent =
  "You were no longer a member of Secondary, so it was removed from this device.";
it.each([
  { error: "invalid: you are not a relay member", toast: absent },
  { error: "invalid: relay membership is not enabled", toast: absent },
  {
    // The relay refuses a banned identity before any leave handler runs, so
    // there is nothing a retry could achieve: access is already severed.
    error: "blocked: you are banned from this community",
    toast:
      "Your access to Secondary was revoked, so it was removed from this device.",
  },
])(
  "forgets a community whose relay answers $error and says so",
  async ({ error, toast }) => {
    const user = userEvent.setup();
    const h = harness({
      leaveResponse: () => Response.json({ error }, { status: 400 }),
    });
    render(<CommunityRail communities={h.communities} />);
    const dialog = await askToLeave(user, "Secondary");
    await user.click(confirmLeave(dialog));
    const notice = await screen.findByText(toast);
    expect(notice.closest(".buzz-toast")).not.toBeNull();
    expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "info");
    expect(h.leave).toHaveBeenCalledWith(secondary);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Switch to Secondary" }),
      ).toBeNull(),
    );
    expect(sessionRequests(h.fetch)).toEqual([]);
  },
);

it("reports a device that could not finish forgetting a left community without blaming the connection", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveError: new Error(
      "Could not save this community on this device. Try again.",
    ),
  });
  render(<CommunityRail communities={h.communities} onSelect={h.onSelect} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  const notice = await screen.findByText(
    "Left Secondary, but this device couldn’t finish cleaning up. Leave it again to finish.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "error");
  expect(
    screen.queryByText(
      "Couldn’t leave Secondary. Check your connection and try again.",
    ),
  ).toBeNull();
  // The relay released the membership; only the device record failed, so the
  // community stays in the rail for the retry that reaches the absent path.
  expect(h.leaveRequests()).toHaveLength(1);
  expect(h.leave).toHaveBeenCalledWith(secondary);
  expect(h.onSelect).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(button("Secondary")).toBeInTheDocument();
  await waitFor(() => expect(button("Secondary")).toHaveFocus());
});

it("says when some saved data outlived the purge", async () => {
  const user = userEvent.setup();
  const h = harness({
    leaveResidue: [{ store: "outbox", error: new Error("blocked") }],
  });
  render(<CommunityRail communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  const notice = await screen.findByText(
    "Left Secondary. Some saved data couldn’t be cleared.",
  );
  expect(notice.closest(".buzz-toast")).toHaveAttribute("data-type", "success");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Switch to Secondary" }),
    ).toBeNull(),
  );
});

it("shows the leave in flight on the dialog and the menu item until the relay answers", async () => {
  const user = userEvent.setup();
  let release!: (response: Response) => void;
  const h = harness({
    leaveResponse: () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  });
  render(<CommunityRail communities={h.communities} />);
  const dialog = await askToLeave(user, "Secondary");
  const confirm = confirmLeave(dialog);
  await user.click(confirm);
  await waitFor(() => expect(h.leaveRequests()).toHaveLength(1));
  expect(confirm).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  // Closing is refused while the request runs.
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  // The modal hides the rail from assistive tech; should the menu open
  // regardless, its item reports the flight and does not start another request.
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Switch to Secondary", hidden: true }),
    { clientX: 20, clientY: 20 },
  );
  const menu = await screen.findByRole("menu", {
    name: "Actions for Secondary",
    hidden: true,
  });
  const item = within(menu).getByRole("menuitem", {
    name: "Leaving…",
    hidden: true,
  });
  expect(item).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(item);
  expect(h.leaveRequests()).toHaveLength(1);
  release(accepted());
  await screen.findByText("Left Secondary.");
  expect(h.leave).toHaveBeenCalledTimes(1);
});

it("leaving the selected community lands on Personal space, and the last one leaves only Personal space and Add", async () => {
  const user = userEvent.setup();
  const h = harness();
  render(<CommunityRail communities={h.communities} />);
  let dialog = await askToLeave(user, "Primary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Primary.");
  expect(h.leave).toHaveBeenCalledWith(primary);
  const personal = screen.getByRole("button", { name: "Personal space" });
  expect(personal).toHaveAttribute("aria-current", "true");
  await waitFor(() => expect(personal).toHaveFocus());
  // The service owns the fallback; the rail itself selected nothing.
  expect(h.select).not.toHaveBeenCalled();

  dialog = await askToLeave(user, "Secondary");
  await user.click(confirmLeave(dialog));
  await screen.findByText("Left Secondary.");
  const rail = screen.getByRole("navigation", { name: "Communities" });
  await waitFor(() =>
    expect(
      within(rail)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Personal space", "Add a community"]),
  );
  expect(h.leaveRequests()).toEqual([
    `/api/relay/${encodeURIComponent(primary)}/leave`,
    `/api/relay/${encodeURIComponent(secondary)}/leave`,
  ]);
});

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
