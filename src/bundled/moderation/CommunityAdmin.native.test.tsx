// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeCommunityRequest } from "../../features/communities/native-api";
import { nativeIdentityEnabled } from "../../features/identity/service";
import type { RelayData } from "../../features/relay/service";
import { CommunityAdmin } from "./CommunityAdmin";
import { apply } from "./index";

const { relayKey } = vi.hoisted(() => ({ relayKey: "f".repeat(64) }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected native call");
  }),
  isTauri: () => true,
}));
// The packaged adapter answers the session contract; every other route is
// missing there, exactly as in native-api.ts.
vi.mock("../../features/communities/native-api", () => ({
  nativeCommunityRequest: vi.fn(async (_community: string, route: string) => {
    if (route === "session") return { relayAuthor: relayKey };
    throw new Error("This operation is unavailable on the packaged connection");
  }),
}));

const owner = "0".repeat(64);
const admin = "1".repeat(64);
const member = "2".repeat(64);
const snapshot = () => ({
  id: "e".repeat(64),
  kind: 13534,
  pubkey: relayKey,
  created_at: 1,
  content: "",
  sig: "",
  tags: [
    ["-"],
    ["member", owner, "owner"],
    ["member", admin, "admin"],
    ["member", member, "member"],
  ],
});

function relay(viewer: string) {
  const read = vi.fn(async () => [snapshot()]);
  const profiles = new Map<string, { name: string }>();
  const session = {
    read,
    viewer,
    media: () => undefined,
    directMessages: { people: async () => ({ people: [], hasMore: false }) },
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: async () => {},
    },
  };
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session,
  };
  return {
    read,
    relay: {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData,
  };
}

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  // Native builds ship no broker; any fetch would be a routing mistake.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected broker request");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(nativeCommunityRequest).mockClear();
});

it("keeps the Invites card registered in a native build", () => {
  expect(nativeIdentityEnabled()).toBe(true);
  const settingsCards = { register: vi.fn() };
  apply({ relay: {}, settingsCards } as unknown as Parameters<typeof apply>[0]);
  expect(settingsCards.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: "invites",
      title: "Invites",
      group: "Communities",
      component: expect.any(Function),
    }),
  );
});

it("shows owners the member list read-only, without invite or member controls", async () => {
  const user = userEvent.setup();
  expect(nativeIdentityEnabled()).toBe(true);
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  const list = await screen.findByRole("list", { name: "Members" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(
    screen.getByText(
      "This build can’t create invites or change members, so the member list is read-only here.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Invite to community" }),
  ).toBeNull();
  expect(screen.queryAllByRole("button", { name: /^Actions for / })).toEqual(
    [],
  );
  // The list stays live: Refresh re-reads the roster through the session.
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  // Only the session contract reached the packaged adapter: nothing minted,
  // nothing changed, and nothing went looking for a broker.
  expect(
    vi.mocked(nativeCommunityRequest).mock.calls.map(([, route]) => route),
  ).toEqual(["session", "session"]);
  expect(fetch).not.toHaveBeenCalled();
});
