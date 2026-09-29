// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, assert } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRelaySession } from "../relay/session";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import type { SidebarPreferences } from "../relay/sidebar-preferences";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { ChannelList } from "../relay/contracts";
import type { Navigation } from "../navigation/controller";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelNavigationProvider } from "./ChannelNavigationState";

const { rowRender, menuRender } = vi.hoisted(() => ({
  rowRender: vi.fn(),
  menuRender: vi.fn(),
}));
// Observe the real row below ChannelSidebarItem's production memo boundary.
// React hooks, the parent, the item and the row implementation remain real.
vi.mock("../../bundled/channels/ChannelSidebarRow", async (original) => {
  const actual =
    await original<typeof import("../../bundled/channels/ChannelSidebarRow")>();
  return {
    ...actual,
    ChannelSidebarRow: (
      props: Parameters<typeof actual.ChannelSidebarRow>[0],
    ) => {
      rowRender(props);
      return <actual.ChannelSidebarRow {...props} />;
    },
  };
});
// Observe the real row menu provider and popup the same way.
vi.mock("../../shared/design-system/ui/Menu", async (original) => {
  const actual =
    await original<typeof import("../../shared/design-system/ui/Menu")>();
  return {
    ...actual,
    ContextMenuRoot: (props: Parameters<typeof actual.ContextMenuRoot>[0]) => {
      menuRender("root", props);
      return <actual.ContextMenuRoot {...props} />;
    },
    MenuPopup: (props: Parameters<typeof actual.MenuPopup>[0]) => {
      menuRender("popup", props);
      return <actual.MenuPopup {...props} />;
    },
  };
});
beforeEach(() => {
  // jsdom has no layout; browser journeys own geometry. Only supply the API.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const noProviders: [] = [];
const providers = {
  snapshot: () => noProviders,
  subscribe: () => () => {},
  register: () => {},
};

function fixture(
  sidebarPreferences?: ReturnType<
    typeof createSidebarPreferencesStore
  >["queries"],
  status: RelaySnapshot["status"] = "ready",
) {
  const owner = createRelaySession(null);
  owners.push(owner);
  const list: ChannelList = {
    status: "ready",
    channels: ["alpha", "beta", "gamma"].map((id) => ({
      id,
      name: id,
      channelType: "stream",
    })),
  };
  const live = {
    ...owner.session.live.snapshot(),
    roster: { state: "verified" as const },
  };
  const session = {
    ...owner.session,
    ...(sidebarPreferences ? { sidebarPreferences } : {}),
    live: { ...owner.session.live, snapshot: () => live },
    channels: { ...owner.session.channels, list: () => list, ensureList() {} },
  };
  const snapshot: RelaySnapshot = {
    status,
    ...(status === "ready"
      ? { scope: "https://relay.test:viewer", viewer: "viewer" }
      : {}),
    generation: 1,
    session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  } satisfies RelayData;
  const navigator = { open: vi.fn() } as unknown as Navigation;
  const view = (id: string, sessionsEnabled = true) => (
    <ChannelNavigationProvider relay={relay}>
      <ChannelSidebar
        relay={relay}
        navigator={navigator}
        providers={providers}
        target={{
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: { viewer: "viewer", communityOrigin: "https://relay.test" },
        }}
        sessionsEnabled={sessionsEnabled}
      >
        <nav aria-label="Pages">
          <button type="button">Projects</button>
        </nav>
      </ChannelSidebar>
    </ChannelNavigationProvider>
  );
  return { view, navigator, snapshot, list, session };
}

it("does not rebuild unchanged rows on channel switches and refreshes session action eligibility", async () => {
  const h = fixture();
  const mounted = render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  rowRender.mockClear();
  menuRender.mockClear();
  mounted.rerender(h.view("beta"));
  expect(rowRender.mock.calls.map(([props]) => props.channel.id)).not.toContain(
    "gamma",
  );
  // Unchanged rows keep their menu provider and popup behind the memo too.
  expect(
    menuRender.mock.calls.filter(([, props]) =>
      String(props["aria-label"] ?? "").includes("gamma"),
    ),
  ).toEqual([]);
  expect(
    menuRender.mock.calls.filter(([kind]) => kind === "root"),
  ).toHaveLength(rowRender.mock.calls.length);
  expect(screen.getByRole("button", { name: "beta" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("button", { name: "alpha" })).not.toHaveAttribute(
    "aria-current",
  );
  const alpha = rowRender.mock.calls.find(
    ([props]) => props.channel.id === "alpha",
  )?.[0];
  expect(alpha).toBeDefined();
  // Disable session creation without changing selection: the callback must update.
  rowRender.mockClear();
  mounted.rerender(h.view("beta", false));
  const disabled = rowRender.mock.calls.find(
    ([props]) => props.channel.id === "alpha",
  )?.[0];
  expect(disabled.onNewSession).not.toBe(alpha.onNewSession);
  disabled.onNewSession("alpha");
  expect(h.navigator.open).not.toHaveBeenCalled();
  // Ordinary selection still uses the current session and navigator.
  fireEvent.click(screen.getByRole("button", { name: "gamma" }));
  expect(h.navigator.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "gamma" }),
  );
});

async function failedMoveFixture(groupSource?: "personal") {
  const data: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { beta: "work" },
    starred: [],
    muted: [],
    ...(groupSource ? { groupSource } : {}),
  };
  const read = vi.fn(async () => data);
  const write = vi.fn(async () => {
    throw new Error("offline");
  });
  const star = vi.fn(async () => []);
  const owner = createSidebarPreferencesStore(read, true, write, star);
  const prefs = owner.queries;
  await prefs.ensure();
  await expect(prefs.assign("beta")).rejects.toThrow("offline");
  const h = fixture(prefs);
  const mounted = render(h.view("alpha"), { wrapper: ToastProvider });
  const notice = await screen.findByRole("alert");
  expect(notice).toHaveTextContent("Couldn’t save the move for beta. offline");
  return { ...h, owner, prefs, read, write, star, data, notice, mounted };
}

it.each([undefined, "personal"] as const)(
  "updates the move notice when retry is rejected after group source %s changes",
  async (source) => {
    const h = await failedMoveFixture(source);
    try {
      const { groupSource: _source, ...data } = h.data;
      h.read.mockResolvedValue({
        ...data,
        ...(source ? {} : { groupSource: "personal" as const }),
      });
      await act(() => h.prefs.refresh());
      fireEvent.click(
        within(h.notice).getByRole("button", { name: "Retry move" }),
      );
      expect(h.notice).toHaveTextContent(
        "The active group source changed; dismiss this move and choose its destination again",
      );
      expect(h.notice).not.toHaveTextContent("offline");
      expect(h.write).toHaveBeenCalledOnce();
      expect(h.star).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
    }
  },
);

it("explains and disables unavailable move retries, then enables them after preference recovery", async () => {
  const h = await failedMoveFixture();
  try {
    h.read.mockRejectedValueOnce(new Error("refresh failed"));
    await act(() => h.prefs.refresh());
    const retry = within(h.notice).getByRole("button", { name: "Retry move" });
    expect(retry).toBeDisabled();
    expect(h.notice).toHaveTextContent(
      "Refresh saved sidebar preferences before retrying this move.",
    );
    // Direct/stale callers also publish their rejection, not just a rejected promise.
    await act(async () => {
      await expect(h.prefs.retryMove("beta")).rejects.toThrow(
        "refresh saved sidebar preferences before retrying",
      );
    });
    expect(h.notice).not.toHaveTextContent("offline");
    expect(h.notice).toHaveTextContent("Sidebar group moves are unavailable");
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.star).not.toHaveBeenCalled();
    await act(() => h.prefs.refresh());
    expect(retry).toBeEnabled();
    expect(h.notice).not.toHaveTextContent(
      "Refresh saved sidebar preferences before retrying this move.",
    );
  } finally {
    h.owner.dispose();
  }
});

it.each(["ready", "connecting", "error"] as const)(
  "keeps the supplied page navigation while the relay is %s",
  (status) => {
    const h = fixture(undefined, status);
    render(h.view("alpha"));
    const pages = screen.getByRole("navigation", { name: "Pages" });
    expect(
      within(pages).getByRole("button", { name: "Projects" }),
    ).toBeVisible();
  },
);

it("opens creation from a legacy subgroup + with that destination selected and retained in the create input", async () => {
  const preferences = createSidebarPreferencesStore(
    async () => ({
      sections: [{ id: "laptop", name: "Laptop", order: 0 }],
      assignments: { beta: "laptop" },
      starred: [],
      muted: [],
    }),
    true,
    async () => ({
      sections: [{ id: "laptop", name: "Laptop", order: 0 }],
      assignments: {},
    }),
    async () => [],
  );
  await preferences.queries.ensure();
  const h = fixture(preferences.queries);
  const create = vi.fn(async () => "new-channel");
  h.session.channelKit = {
    ...h.session.channelKit,
    available: true,
    ensure() {},
  };
  h.session.channelCreation = {
    ...h.session.channelCreation,
    available: true,
    create,
  };
  try {
    render(h.view("alpha"));
    await screen.findByRole("button", { name: /Laptop/ });
    // Scope to the section header rather than the Channels +.
    const header = screen.getByRole("button", { name: /Laptop/ }).parentElement;
    assert.exists(header);
    fireEvent.click(
      within(header).getByRole("button", { name: "Create channel" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Destination group" }),
    ).toHaveTextContent("Laptop");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "New laptop channel" },
    });
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Create a channel" }),
      ).getByRole("button", {
        name: "Create channel",
      }),
    );
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "New laptop channel",
        visibility: "open",
        setup: {
          agents: [],
          canvas: "",
          templateId: "",
          groupId: "laptop",
          groupSource: "legacy",
        },
      }),
    );
  } finally {
    preferences.dispose();
  }
});
