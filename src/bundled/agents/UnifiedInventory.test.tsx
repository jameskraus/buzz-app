// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import type { ClientSnapshot } from "../../features/communities/service";
import * as communityApi from "../../features/communities/api";
import * as destinations from "../../features/communities/destination";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import type { ReadTransport } from "../../features/relay/transport";
import type { RelaySnapshot } from "../../features/relay/service";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { UnifiedInventory } from "./UnifiedInventory";
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});
function setup(
  mode: string,
  configure: (f: ReturnType<typeof controlFixture>) => void,
  identities = ["cd".repeat(32)],
  definitions: { id: string; name: string }[] = [],
  client?: ClientSnapshot,
  transport: Partial<ReadTransport> = {},
  naming = false,
) {
  const f = controlFixture();
  configure(f);
  if (!vi.isMockFunction(communityApi.communityRequest))
    vi.spyOn(communityApi, "communityRequest").mockImplementation(
      async (_id, route, body, signal) =>
        route === "query"
          ? (transport.query?.(
              body as Parameters<ReadTransport["query"]>[0],
              signal ?? new AbortController().signal,
            ) ?? [])
          : { identities },
    );
  const owned = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    readAgentLibrary: async () => ({
      definitions,
      identities: [
        {
          pubkey: "cd".repeat(32),
          name: "Not imported",
          definitionId: "linked",
        },
      ],
    }),
    query: async () => [],
    media: () => undefined,
    ...transport,
  });
  const control = createAgentControl(f.host);
  disposals.push(() => {
    owned.dispose();
    control.dispose();
  });
  const boundNames = naming
    ? bindNames(owned.session, {
        snapshot: () => [createAgentDirectory(control)],
        subscribe: () => () => {},
      })
    : undefined;
  if (boundNames) disposals.push(() => boundNames.dispose());
  const session = {
    ...owned.session,
    names: boundNames ?? owned.session.names,
  };
  let connection: RelaySnapshot = {
    status: mode === "disconnected" ? "disconnected" : "ready",
    viewer: "de".repeat(32),
    ...(mode === "disconnected"
      ? {}
      : { scope: `wss://relay.example.test:${"de".repeat(32)}` }),
    generation: 1,
    session:
      mode === "archived"
        ? {
            ...session,
            archives: {
              ...owned.session.archives,
              state: () => "archived" as const,
            },
          }
        : session,
  };
  const view = () => (
    <UnifiedInventory
      state={{ ...control.snapshot(), status: "ready", data: f.data }}
      control={control}
      connection={connection}
      client={client}
      edit={() => {}}
      importedId={null}
      onUseHere={() => {}}
      onImport={() => {}}
    />
  );
  const mounted = render(view());
  return {
    f,
    library: owned.session.agentLibrary,
    changeClient(next: ClientSnapshot) {
      client = next;
      mounted.rerender(view());
    },
    changeScope(scope: string, generation: number) {
      connection = { ...connection, scope, generation };
      mounted.rerender(view());
    },
  };
}
it("does not let late inventory from the previous community expose Use here", async () => {
  let finish!: (value: { identities: string[] }) => void;
  const pending = new Promise<{ identities: string[] }>((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (destination) => {
      if (destination === "https://relay.example.test") return pending;
      return { identities: [] };
    });
  const { changeScope } = setup("connected", (fixture) => {
    fixture.data.parked = [
      { pubkey: "cd".repeat(32), name: "Source", sources: ["installed"] },
    ];
    fixture.host.cloneSettings = async () => ({
      name: "Source",
      systemPrompt: "Instructions",
    });
  });
  await waitFor(() => expect(request).toHaveBeenCalled());
  act(() => changeScope(`wss://second.example:${"de".repeat(32)}`, 2));
  try {
    await waitFor(() =>
      expect(
        request.mock.calls.some((call) => call[0] === "https://second.example"),
      ).toBe(true),
    );
  } finally {
    await act(async () => {
      finish({ identities: ["cd".repeat(32)] });
      await pending;
    });
  }
  const card = await screen.findByRole("article", {
    name: "Agent Source",
  });
  expect(within(card).queryByRole("button", { name: "Use here" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Import" })).toBeEnabled();
});

it("retries failed inventory without offering import for relay-only identities", async () => {
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockRejectedValueOnce(Error("unavailable"))
    .mockResolvedValue({ identities: ["cd".repeat(32)] });
  setup("connected", (fixture) => {
    fixture.data.parked = [];
  });
  await screen.findByText(/Community inventory could not be checked/);
  expect(screen.queryByRole("button", { name: "Use here" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  const group = await screen.findByRole("region", {
    name: "Relay-only agents",
  });
  expect(
    within(group).getByRole("article", { name: "Agent Not imported" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, route]) => route === "agent-inventory"),
    ).toHaveLength(2),
  );
  expect(within(group).queryByRole("button", { name: "Import" })).toBeNull();
  expect(within(group).queryByText(/No import source confirmed/)).toBeNull();
});

it("preserves placement and independent setup and Clone after a read failure", async () => {
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockResolvedValue({ identities: ["cd".repeat(32)] });
  setup("connected", (fixture) => {
    fixture.data.agents.push({
      ...fixture.agent,
      id: "retained",
      pubkey: "cd".repeat(32),
      configured: false,
      enabled: false,
      status: "stopped",
    });
  });
  await screen.findByRole("button", { name: "Use here" });
  request.mockRejectedValue(Error("Access denied"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await screen.findByText(/Community inventory could not be checked/);
  expect(
    screen.getByRole("region", { name: "Local agents in this community" }),
  ).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Clone" })).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Use here" })).toBeEnabled();
});
it("retains multiple verified associations and renders inventory keys absent from profiles", async () => {
  const key = "fe".repeat(32);
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockResolvedValue({ identities: [key] });
  const { changeScope } = setup("connected", () => {});
  await screen.findByRole("region", { name: "Relay-only agents" });
  act(() => changeScope(`wss://second.example:${"de".repeat(32)}`, 2));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, route]) => route === "agent-inventory"),
    ).toHaveLength(2),
  );
  await screen.findByRole("region", { name: "Relay-only agents" });
  request.mockResolvedValue({ identities: [] });
  act(() => changeScope(`wss://third.example:${"de".repeat(32)}`, 3));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, route]) => route === "agent-inventory"),
    ).toHaveLength(3),
  );
  for (const community of ["relay.example.test", "second.example"]) {
    const group = await screen.findByRole("region", {
      name: "Relay-only agents",
    });
    const card = within(group).getByRole("article", {
      name: `Agent ${key.slice(0, 12)}`,
    });
    expect(
      within(group).getByRole("region", { name: "https://relay.example.test" }),
    ).toContainElement(card);
    expect(
      within(group).queryByRole("region", { name: "https://second.example" }),
    ).toBeNull();
    const details = card.querySelector("details");
    if (!details?.open)
      fireEvent.click(
        within(card).queryByText("Identity & sources") ??
          within(card).getByLabelText(/^Details for /),
      );
    expect(within(card).getByText(`https://${community}`)).toBeVisible();
    expect(
      screen.getAllByRole("article", { name: `Agent ${key.slice(0, 12)}` }),
    ).toHaveLength(1);
    expect(within(card).queryByRole("button", { name: "Import" })).toBeNull();
    expect(within(group).queryByText(/No import source confirmed/)).toBeNull();
  }
});

it("filters archived identities after all discovery joins while retaining local controls", async () => {
  setup("archived", (f) => {
    f.data.parked = [
      { pubkey: "cd".repeat(32), name: "Hidden", sources: ["installed"] },
    ];
  });
  await waitFor(() => expect(communityApi.communityRequest).toHaveBeenCalled());
  await screen.findByRole("button", { name: "Stop" });
  expect(screen.queryByRole("article", { name: "Agent Hidden" })).toBeNull();
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
  expect(
    screen.getByRole("article", { name: "Agent Fixture agent" }),
  ).toBeVisible();
});
it("omits redundant profile text and uses configured names for native WSS setups in an HTTPS session", async () => {
  const { changeScope } = setup(
    "connected",
    (f) => {
      f.agent.pubkey = "cd".repeat(32);
      f.agent.name = "Raw local fallback";
    },
    ["cd".repeat(32)],
    [{ id: "linked", name: "Reusable profile" }],
  );
  act(() => changeScope(`https://relay.example.test:${"de".repeat(32)}`, 1));
  const card = await screen.findByRole("article", {
    name: "Agent Raw local fallback",
  });
  expect(within(card).queryByText(/^Profile:/)).toBeNull();
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).not.toBeVisible();
  fireEvent.click(
    within(card).queryByText("Identity & sources") ??
      within(card).getByLabelText(/^Details for /),
  );
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).toBeVisible();
  expect(within(card).getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(
    screen.queryByRole("article", { name: "Agent Not imported" }),
  ).toBeNull();
});
it("keeps exact local controls while disconnected and after switching to another community", async () => {
  const { changeScope } = setup("disconnected", (f) => {
    f.data.parked = [];
  });
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(card).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  ).toBeVisible();
  act(() => changeScope(`wss://other.example.test:${"de".repeat(32)}`, 2));
  const switched = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(switched).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(
    within(switched).getByRole("button", { name: "Actions for Fixture agent" }),
  ).toBeVisible();
});

it("shows source failures without claiming a missing import source was proved", async () => {
  setup("connected", (f) => {
    f.data.parked = [];
    f.data.inventoryWarnings = ["Development Buzz could not be read."];
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Development Buzz could not be read.",
  );
  const card = await screen.findByRole("article", {
    name: "Agent Not imported",
  });
  expect(screen.queryByText(/No import source confirmed/)).toBeNull();
  expect(within(card).queryByRole("button", { name: "Import" })).toBeNull();
});

const joined = (ids: string[], viewer = "de".repeat(32)): ClientSnapshot => ({
  status: "ready",
  relayAvailable: true,
  viewer,
  profile: { name: "", picture: "" },
  selected: null,
  memberships: ids.map((id) => ({ id, name: id })),
});
it("discovers an unselected configured membership alias by its origin", async () => {
  const resolve = destinations.communityDestination;
  vi.spyOn(destinations, "communityDestination").mockImplementation((id) =>
    resolve(id, { primary: "https://unvisited.example" }),
  );
  const key = "fa".repeat(32);
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (_id, route) =>
      route === "query" ? [] : { identities: [key] },
    );
  const client = joined(["primary", "wss://unvisited.example"]);
  setup(
    "connected",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    client,
  );
  expect(
    await screen.findByRole("article", { name: `Agent ${key.slice(0, 12)}` }),
  ).toBeVisible();
  expect(
    request.mock.calls
      .filter(([, route]) => route === "agent-inventory")
      .map(([id]) => id),
  ).toEqual(["https://unvisited.example"]);
  expect(client.memberships[0]?.id).toBe("primary");
  expect(client.selected).toBeNull();
});
it("reads unvisited joined communities, deduplicates identities, and retries only discovery after partial failure", async () => {
  const key = "fa".repeat(32);
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (id, route) => {
      if (route === "query") return [];
      if (id === "https://failed.example") throw Error("unavailable");
      return { identities: [key] };
    });
  const { f } = setup(
    "connected",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    joined([
      "https://relay.example.test",
      "wss://unvisited.example",
      "https://failed.example",
    ]),
  );
  await screen.findByText(/could not be checked for https:\/\/failed.example/);
  const card = await screen.findByRole("article", {
    name: `Agent ${key.slice(0, 12)}`,
  });
  expect(
    screen.getAllByRole("article", { name: `Agent ${key.slice(0, 12)}` }),
  ).toHaveLength(1);
  fireEvent.click(within(card).getByLabelText(/^Details for /));
  expect(within(card).getByText("https://unvisited.example")).toBeVisible();
  expect(within(card).getByText("https://relay.example.test")).toBeVisible();
  expect(within(card).queryByRole("button", { name: "Import" })).toBeNull();
  expect(within(card).queryByRole("button", { name: "Use here" })).toBeNull();
  expect(
    request.mock.calls
      .filter(([, route]) => route === "agent-inventory")
      .map(([id]) => id)
      .sort(),
  ).toEqual([
    "https://failed.example",
    "https://relay.example.test",
    "https://unvisited.example",
  ]);
  request.mockImplementation(async (_id, route) =>
    route === "query" ? [] : { identities: [key] },
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh agents" }));
  await waitFor(() =>
    expect(screen.queryByText(/could not be checked/)).toBeNull(),
  );
  const refreshed = await screen.findByRole("region", {
    name: "https://failed.example",
  });
  expect(
    within(refreshed).getByRole("article", {
      name: `Agent ${key.slice(0, 12)}`,
    }),
  ).toBeVisible();
  expect(
    f.calls.some(({ action }) => action === "preview" || action === "import"),
  ).toBe(false);
});
it("discards late results across viewers and removes departed communities without opening a selected session", async () => {
  const oldKey = "fa".repeat(32),
    newKey = "fb".repeat(32);
  let finish!: (value: { identities: string[] }) => void;
  const late = new Promise<{ identities: string[] }>((resolve) => {
    finish = resolve;
  });
  const request = vi
    .spyOn(communityApi, "communityRequest")
    .mockImplementation(async (id, route) =>
      route === "query"
        ? []
        : id === "https://old.example"
          ? late
          : { identities: [newKey] },
    );
  const { changeClient } = setup(
    "disconnected",
    (f) => {
      f.data.agents = [];
      f.data.parked = [];
    },
    [],
    [],
    joined(["https://old.example"]),
  );
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  act(() => changeClient(joined(["https://new.example"], "ee".repeat(32))));
  await screen.findByRole("article", { name: `Agent ${newKey.slice(0, 12)}` });
  await act(async () => {
    finish({ identities: [oldKey] });
    await late;
  });
  expect(
    screen.queryByRole("article", { name: `Agent ${oldKey.slice(0, 12)}` }),
  ).toBeNull();
  expect(request.mock.calls[0]?.[3]?.aborted).toBe(true);
  act(() => changeClient(joined([], "ee".repeat(32))));
  expect(
    screen.queryByRole("article", { name: `Agent ${newKey.slice(0, 12)}` }),
  ).toBeNull();
});
