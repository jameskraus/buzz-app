// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { Profiler, StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import type { AgentLibrary } from "../agents/library";
import { createNameProvider } from "../identity-names/directory";
import { resolveIdentityNames } from "../identity-names/policy";
import { bindNames } from "../identity-names/service";
import { profileTarget } from "../profiles/target";
import { useChannelWindow } from "../relay/react";
import { createRelaySession } from "../relay/session";
import type { LiveCallbacks } from "../relay/live";
import {
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  summary,
} from "../relay/testing";
import { ChannelTimeline } from "./ChannelTimeline";

// Count parent renders and independent descendant commits. The body and its
// React lifecycle stay real; this measures work, not a replacement renderer.
const bodies = vi.hoisted(() => vi.fn());
const bodyCommits = vi.hoisted(() => vi.fn());
vi.mock("./MessageMarkdown", async (original) => {
  const actual = await original<typeof import("./MessageMarkdown")>();
  return {
    ...actual,
    MessageMarkdown: (props: Parameters<typeof actual.MessageMarkdown>[0]) => {
      bodies(props.row.id);
      return (
        <Profiler id={props.row.id} onRender={bodyCommits}>
          <actual.MessageMarkdown {...props} />
        </Profiler>
      );
    },
  };
});
// Only layout is modeled here. Real virtualization and geometry are exercised
// in the signed browser fixture; subscriptions and row reconciliation stay real.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollOffset: 0,
        scrollSize: 0,
        viewportSize: 0,
        scrollTo() {},
        scrollToIndex() {},
      }));
      return <ol>{children}</ol>;
    }),
  };
});
stubAvatarBrowserApis();
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  bodies.mockClear();
  bodyCommits.mockClear();
  localStorage.clear();
});

function mount() {
  const relay = keypair(),
    viewer = keypair();
  const alice = keypair(),
    bob = keypair(),
    carol = keypair();
  const mentioned = keypair(),
    linked = keypair(),
    participant = keypair();
  let live!: LiveCallbacks;
  let library: AgentLibrary = { definitions: [], identities: [] };
  const provider = createNameProvider({
    id: "test",
    resolve: resolveIdentityNames,
  });
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
      readAgentLibrary: async () => library,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      identityNames: {
        register() {},
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [provider],
            subscribe: () => () => {},
          }),
      },
    },
  );
  owners.push(owner);
  const rows = [
    message(alice, "c", "Hello @Mention", 1, [["p", mentioned.pubkey]]),
    message(bob, "c", `See [@Original](${profileTarget(linked.pubkey)})`, 2),
    message(carol, "c", "Unchanged body", 3),
  ] as const;
  const profiles = [
    profile(alice, { name: "Alice" }),
    profile(bob, { name: "Bob" }),
    profile(carol, { name: "Carol" }),
    profile(mentioned, { name: "Mention" }),
    profile(linked, { name: "Linked" }),
    profile(participant, { name: "Participant" }),
  ];
  live.receive([
    roster(
      relay,
      "c",
      [viewer, alice, bob, carol, mentioned, linked, participant].map(
        (key) => key.pubkey,
      ),
    ),
    ...rows,
    ...profiles,
    summary(relay, "c", rows[0].id, {
      reply_count: 1,
      participants: [participant.pubkey],
    }),
  ]);
  const onOpenLink = vi.fn(() => true),
    onOpenThread = vi.fn();
  function Timeline() {
    const window = useChannelWindow(owner.session.channels, "c");
    return (
      <ChannelTimeline
        queries={owner.session}
        channelId="c"
        scope="identity-test"
        window={window}
        onOpenLink={onOpenLink}
        canOpenLink={onOpenLink}
        onOpenThread={onOpenThread}
      />
    );
  }
  const mounted = render(
    <StrictMode>
      <Timeline />
    </StrictMode>,
  );
  const row = (index: number) => {
    const element = document.querySelector<HTMLElement>(
      `[data-message-id="${rows[index]?.id}"]`,
    );
    if (!element) throw new Error("Missing fixture row");
    return element;
  };
  return {
    ...mounted,
    live,
    owner,
    rows,
    row,
    relay,
    alice,
    bob,
    carol,
    mentioned,
    linked,
    participant,
    async library(identities: AgentLibrary["identities"]) {
      library = { definitions: [], identities };
      await owner.session.agentLibrary.refresh();
    },
  };
}

it("isolates unrelated profiles and new history while preserving visible identity updates", async () => {
  const h = mount();
  await screen.findByText("Carol");
  await act(async () => {}); // complete initial empty query and retained naming inventory
  const existing = h.rows.map((_, index) => h.row(index));
  bodies.mockClear();
  bodyCommits.mockClear();
  await act(async () =>
    h.live.receive([profile(keypair(), { name: "Unrelated", is_agent: true })]),
  );
  expect(bodies).not.toHaveBeenCalled();
  expect(bodyCommits).not.toHaveBeenCalled();
  expect(h.rows.map((_, index) => h.row(index))).toEqual(existing);

  const newcomer = keypair();
  const appended = message(newcomer, "c", "New history row", 4);
  await act(async () =>
    h.live.receive([appended, profile(newcomer, { name: "Newcomer" })]),
  );
  expect(await screen.findByText("New history row")).toBeInTheDocument();
  expect(bodies.mock.calls.every(([id]) => id === appended.id)).toBe(true);
  expect(bodyCommits.mock.calls.every(([id]) => id === appended.id)).toBe(true);
  bodies.mockClear();

  await act(async () =>
    h.live.receive([
      profile(h.alice, { name: "Alicia", is_agent: true }, 1_700_000_001),
    ]),
  );
  expect(
    within(h.row(0)).getByRole("button", { name: "View Alicia profile" }),
  ).toBeInTheDocument();
  expect(
    h.row(0).querySelector('[data-avatar-shape="squircle"]'),
  ).toBeInTheDocument();
  expect(bodies.mock.calls.every(([id]) => id === h.rows[0].id)).toBe(true);
  bodies.mockClear();

  // Profile is not the author's; signed prose binding still needs its metadata.
  expect(
    within(h.row(0)).getByRole("button", { name: "View Mention profile" }),
  ).toBeInTheDocument();
  await act(async () =>
    h.live.receive([
      profile(h.mentioned, { name: "Mention", is_agent: true }, 1_700_000_001),
    ]),
  );
  expect(
    h.row(0).querySelector('[data-mention-kind="agent"]'),
  ).toBeInTheDocument();
  expect(bodies.mock.calls.every(([id]) => id === h.rows[0].id)).toBe(true);

  await act(async () =>
    h.live.receive([
      profile(
        h.participant,
        { name: "Renamed participant", is_agent: true },
        1_700_000_001,
      ),
    ]),
  );
  expect(
    h.row(0).querySelector('[title="Renamed participant"]'),
  ).toHaveAttribute("data-avatar-shape", "squircle");

  // Explicit profile links need not occur in signed p tags or rowProfileIds.
  bodies.mockClear();
  bodyCommits.mockClear();
  await act(async () =>
    h.live.receive([
      profile(
        h.linked,
        { name: "Renamed link", is_agent: true },
        1_700_000_001,
      ),
    ]),
  );
  expect(
    within(h.row(1)).getByRole("button", { name: "View Renamed link profile" }),
  ).toHaveAttribute("data-mention-kind", "agent");
  expect(bodies).not.toHaveBeenCalled();
  expect(bodyCommits).toHaveBeenCalled();
  expect(bodyCommits.mock.calls.every(([id]) => id === h.rows[1].id)).toBe(
    true,
  );

  // Removing relevant hints and profiles must not leave cached labels/shapes.
  await act(async () =>
    h.live.receive([profile(h.alice, { name: "Alice" }, 1_700_000_002)]),
  );
  expect(
    h.row(0).querySelector('[data-avatar-shape="circle"]'),
  ).toBeInTheDocument();
  h.unmount();
  await act(async () =>
    h.live.receive([
      profile(h.alice, { name: "After unmount" }, 1_700_000_003),
    ]),
  );
  expect(screen.queryByText("After unmount")).not.toBeInTheDocument();
});

it("keeps channel-wide namesake resolution when an off-row member changes", async () => {
  const h = mount();
  await screen.findByText("Carol");
  await act(async () => {});
  await act(async () =>
    h.live.receive([profile(h.linked, { name: "Alice" }, 1_700_000_001)]),
  );
  expect(
    within(h.row(0)).getByRole("button", { name: /^View Alice · .+ profile$/ }),
  ).toBeInTheDocument();
  await act(async () =>
    h.live.receive([
      profile(h.linked, { name: "Unique again" }, 1_700_000_002),
    ]),
  );
  expect(
    within(h.row(0)).getByRole("button", { name: "View Alice profile" }),
  ).toBeInTheDocument();
});

it("updates and clears agent appearance from the session's shared choices", async () => {
  const h = mount();
  await screen.findByText("Carol");
  await act(async () => {});
  await act(async () =>
    h.library([
      { pubkey: h.alice.pubkey, name: "Library Alice" },
      { pubkey: h.participant.pubkey, name: "Library participant" },
    ]),
  );
  expect(
    within(h.row(0)).getByRole("button", {
      name: "View Library Alice profile",
    }),
  ).toBeInTheDocument();
  expect(
    h.row(0).querySelector('[data-avatar-shape="squircle"]'),
  ).toBeInTheDocument();
  expect(
    h.row(0).querySelector('[title="Library participant"]'),
  ).toHaveAttribute("data-avatar-shape", "squircle");
  await act(async () => h.library([]));
  expect(
    within(h.row(0)).getByRole("button", { name: "View Alice profile" }),
  ).toBeInTheDocument();
  expect(
    h.row(0).querySelector('[data-avatar-shape="squircle"]'),
  ).not.toBeInTheDocument();
  expect(h.row(0).querySelector('[title="Participant"]')).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
});
