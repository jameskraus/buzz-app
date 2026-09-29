// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { nativeIdentityEnabled } from "../identity/service";
import { CommunityRail } from "./CommunityRail";
import type { Communities, ClientSnapshot } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("unexpected native call");
  }),
  isTauri: () => true,
}));

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
const viewer = "a".repeat(64);
const primary = "https://primary.example";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "");
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("hides Invite to community and disables Mark all as read in a native build", async () => {
  expect(nativeIdentityEnabled()).toBe(true);
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    profile: { name: "", picture: "" },
    viewer,
    selected: primary,
    memberships: [{ id: primary, name: "Primary" }],
  };
  const read = vi.fn(async () => []);
  const markAllChannelsRead = vi.fn(async () => []);
  const connection = {
    status: "ready",
    generation: 1,
    scope: `${primary}:${viewer}`,
    viewer,
    session: {
      read,
      unread: {
        // Native builds have no read-state host, so the capability never syncs.
        sync: () => ({ capability: "unsupported" }),
        subscribeSync: () => () => {},
        markAllChannelsRead,
      },
    },
  } as unknown as RelaySnapshot;
  const communities = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    select: vi.fn(),
    relay: {
      snapshot: () => connection,
      subscribe: () => () => {},
    } as unknown as RelayData,
  } as unknown as Communities;
  const onOpenTarget = vi.fn();
  render(
    <CommunityRail communities={communities} onOpenTarget={onOpenTarget} />,
  );
  fireEvent.contextMenu(
    screen.getByRole("button", { name: "Switch to Primary" }),
    {
      clientX: 20,
      clientY: 20,
    },
  );
  const menu = await screen.findByRole("menu", { name: "Actions for Primary" });
  await within(menu).findByRole("menuitem", { name: "Community settings" });
  expect(
    within(menu).queryByRole("menuitem", { name: "Invite to community" }),
  ).toBeNull();
  const markAll = within(menu).getByRole("menuitem", {
    name: "Mark all as read",
  });
  expect(markAll).toHaveAttribute("aria-disabled", "true");
  expect(markAll).toHaveAccessibleDescription(
    "Read state can’t sync on this connection.",
  );
  // No invite means no roster to gate on, so nothing was read for the menu.
  expect(read).not.toHaveBeenCalled();
});
