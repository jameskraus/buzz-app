// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { createRelaySession } from "../../features/relay/session";
import { inventoryIdentities } from "./inventory-model";
import { InventoryIdentityCard } from "./InventoryIdentityCard";
import { inventoryDecision } from "./inventory-decisions";
import { useState } from "react";
import type { ImportSource } from "../../features/agents/control";
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
) {
  const f = controlFixture();
  configure(f);
  const owned = createRelaySession({
    viewer: "de".repeat(32),
    relayAuthor: "ef".repeat(32),
    scope: "wss://relay.example.test",
    query: async () => [],
    media: () => undefined,
  });
  const control = createAgentControl(f.host);
  disposals.push(() => {
    owned.dispose();
    control.dispose();
  });
  const rows = inventoryIdentities(
    mode === "disconnected"
      ? []
      : [
          {
            pubkey: "cd".repeat(32),
            name: "Not imported",
            definitionId: "linked",
          },
        ],
    f.data,
    (_key, fallback) => fallback,
  );
  if (mode !== "disconnected") {
    for (const key of identities) {
      const row = rows.get(key);
      if (row)
        row.knownCommunities = new Set([
          ...row.knownCommunities,
          "https://relay.example.test",
        ]);
    }
  }
  const onImport = vi.fn();
  const onUseHere = vi.fn();
  function Cards() {
    const [sources, setSources] = useState<Record<string, ImportSource>>({});
    const destination =
      mode === "disconnected" ? "" : "https://relay.example.test";
    return (
      <>
        {[...rows.values()].map((row) => (
          <InventoryIdentityCard
            key={row.pubkey}
            row={row}
            decision={inventoryDecision(row, destination)}
            state={{ ...control.snapshot(), status: "ready", data: f.data }}
            control={control}
            session={owned.session}
            destination={destination}
            publicProfiles={new Map()}
            edit={() => {}}
            importedId={null}
            onUseHere={onUseHere}
            onImport={onImport}
            selectedSource={sources[row.pubkey]}
            onSourceChange={(source) =>
              setSources((saved) => ({ ...saved, [row.pubkey]: source }))
            }
          />
        ))}
      </>
    );
  }
  render(<Cards />);
  return { f, onImport, onUseHere };
}
it("browses durable parked identities while disconnected without reading old files or keys", async () => {
  const { f } = setup("disconnected", (fixture) => {
    fixture.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Saved offline",
        sources: ["development"],
      },
    ];
  });
  const card = await screen.findByRole("article", {
    name: "Agent Saved offline",
  });
  expect(
    within(card).queryByText(/^(Not imported|Imported locally)$/),
  ).toBeNull();
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).not.toBeVisible();
  fireEvent.click(
    within(card).queryByText("Identity & sources") ??
      within(card).getByText("Identity & sources"),
  );
  expect(within(card).getByText(npubEncode("cd".repeat(32)))).toBeVisible();
  expect(within(card).getByText("Development Buzz")).toBeVisible();
  expect(
    f.calls.some(
      (call) => call.action === "preview" || call.action === "import",
    ),
  ).toBe(false);
  expect(within(card).getByRole("button", { name: "Import" })).toBeEnabled();
  expect(within(card).queryByRole("button", { name: "Use here" })).toBeNull();
  expect(f.calls.some((call) => call.action === "preview")).toBe(false);
});

it("offers Clone for a configured other-community setup and keeps its exact controls", async () => {
  setup("connected", (f) => {
    f.agent.relayUrl = "wss://elsewhere.example";
    f.agent.status = "stopped";
    f.agent.enabled = true;
  });
  const card = await screen.findByRole("article", {
    name: "Agent Fixture agent",
  });
  expect(within(card).getByText("Identity & sources")).toBeVisible();
  // The app runs this setup, so its lifecycle and settings stay reachable here.
  expect(within(card).getByRole("button", { name: "Start" })).toBeVisible();
  expect(
    within(card).getByRole("button", { name: "Actions for Fixture agent" }),
  ).toBeVisible();
  expect(within(card).getByRole("button", { name: "Clone" })).toBeEnabled();
  expect(
    within(card).queryByRole("button", { name: /^(Import|Use here)$/ }),
  ).toBeNull();
  expect(
    within(card).queryByText("Configured locally · community shown below"),
  ).toBeNull();
  expect(
    within(card).queryByText(/Connect to a destination|Imported locally/),
  ).toBeNull();
});

it("makes Import primary and explains how secondary Clone creates a different identity", async () => {
  setup("connected", (fixture) => {
    fixture.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Not imported",
        sources: ["development"],
      },
    ];
    fixture.host.cloneSettings = async () => ({
      name: "Reviewed agent",
      systemPrompt: "Instructions",
    });
  });
  const card = screen.getByRole("article", {
    name: "Agent Not imported",
  });
  const importButton = within(card).getByRole("button", { name: "Import" });
  expect(within(card).getByRole("button", { name: "Clone" })).not.toBeVisible();
  fireEvent.click(within(card).getByText("Identity & sources"));
  const cloneButton = within(card).getByRole("button", { name: "Clone" });
  expect(importButton).toBeEnabled();
  expect(cloneButton).toBeEnabled();
  expect(importButton).toHaveAttribute("data-variant", "prominent");
  expect(cloneButton).toHaveAttribute("data-variant", "subtle");
  const user = userEvent.setup();
  await user.hover(importButton);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "existing identity and key",
  );
  expect(importButton).toHaveAccessibleDescription(/It stays stopped/);
  await user.unhover(importButton);
  await user.hover(cloneButton);
  await waitFor(() =>
    expect(cloneButton).toHaveAccessibleDescription(
      /new identity and key.*Memories and history are not copied/,
    ),
  );
});

it.each([
  [false, false, false, false, false],
  [false, false, true, true, true],
  [false, true, false, false, true],
  [false, true, true, false, true],
  [true, false, false, false, false],
  [true, false, true, true, true],
  [true, true, false, false, true],
  [true, true, true, false, true],
])(
  "card actions: community=%s local=%s oldBuzz=%s => Import=%s Clone=%s",
  async (community, local, oldBuzz, showImport, showClone) => {
    const pubkey = "cd".repeat(32);
    setup(
      "connected",
      (f) => {
        f.data.agents = local
          ? [
              {
                ...f.agent,
                pubkey,
                configured: false,
                relayUrl: "wss://elsewhere.example",
              },
            ]
          : [];
        f.data.parked = oldBuzz
          ? [{ pubkey, name: "Not imported", sources: ["installed"] }]
          : [];
      },
      community ? [pubkey] : [],
    );
    const card = screen.getByRole("article", { name: "Agent Not imported" });
    expect(!!within(card).queryByRole("button", { name: "Import" })).toBe(
      showImport,
    );
    fireEvent.click(within(card).getByText("Identity & sources"));
    expect(!!within(card).queryByRole("button", { name: "Clone" })).toBe(
      showClone,
    );
    expect(screen.queryByText(/No import source confirmed/)).toBeNull();
  },
);

it("dispatches the chosen source and exact key without importing credentials", () => {
  const { f, onImport, onUseHere } = setup("connected", (f) => {
    f.host.cloneSettings = vi.fn(async () => ({
      name: "Reviewed agent",
      systemPrompt: "Instructions",
    }));
    f.data.parked = [
      {
        pubkey: "cd".repeat(32),
        name: "Shared source",
        sources: ["installed", "development"],
      },
    ];
  });
  const card = screen.getByRole("article", { name: "Agent Shared source" });
  expect(within(card).getByRole("button", { name: "Import" })).toBeDisabled();
  fireEvent.change(within(card).getByLabelText("Old Buzz installation"), {
    target: { value: "development" },
  });
  fireEvent.click(within(card).getByRole("button", { name: "Import" }));
  expect(onImport).toHaveBeenCalledWith("cd".repeat(32), "development");
  fireEvent.click(within(card).getByText("Identity & sources"));
  fireEvent.click(within(card).getByRole("button", { name: "Clone" }));
  expect(onUseHere).toHaveBeenCalledWith(
    "cd".repeat(32),
    "clone",
    "development",
  );
  expect(f.host.cloneSettings).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
});
