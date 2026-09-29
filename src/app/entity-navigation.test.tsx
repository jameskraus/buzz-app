// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { App } from "./App";
import { createServices, type AppServices } from "./services";
import { bindDeepLinks } from "../features/navigation/deep-links";
import { matchesEvent } from "../features/relay/projection";
import type { ReadFilter } from "../features/relay/events";
import { createAgentControl } from "../features/agents/control";
import { controlFixture } from "../features/agents/control-testing";

let agentFixture: ReturnType<typeof controlFixture> | undefined;
vi.mock("../features/agents/control-native", () => ({
  createNativeAgentControl: () =>
    createAgentControl(agentFixture?.host ?? null),
}));

vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.projects", name: "Projects", apiVersion: 1 },
      module: await import("../bundled/projects"),
    },
    {
      manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
      module: await import("../bundled/agents"),
    },
    {
      manifest: { id: "buzz.inbox", name: "Inbox", apiVersion: 1 },
      module: await import("../bundled/inbox"),
    },
    {
      manifest: { id: "buzz.bestie", name: "Bestie", apiVersion: 1 },
      module: await import("../bundled/bestie"),
    },
    {
      // A vended page without the primary flag: listed in search, no sidebar row.
      manifest: { id: "fixture.notes", name: "Notes", apiVersion: 1 },
      module: {
        inject: ["pages"],
        apply(ctx: import("@deepseek-ai/cordis").Context) {
          ctx.pages.register({
            id: "notes",
            title: "Fixture notes",
            component: () => null,
          });
        },
      },
    },
  ],
}));
const key = new Uint8Array(32).fill(6),
  viewer = getPublicKey(key),
  origin = "https://community.example";
const project = finalizeEvent(
  {
    kind: 30621,
    created_at: 1,
    content: "",
    tags: [
      ["d", "project"],
      ["name", "Recovered project"],
      ["description", "Actual recovered destination"],
    ],
  },
  key,
);
let services: AppServices | undefined;
let stop = () => {};
afterEach(async () => {
  cleanup();
  stop();
  await services?.dispose();
  services = undefined;
  agentFixture = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
it("keeps an OS entity intent through real community selection and Retry in App", async () => {
  // jsdom has no layout observer; App now keeps its real sidebar mounted here.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: null,
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/session"))
        return Response.json({ viewer, relayAuthor: viewer, relayUrl: origin });
      if (url.endsWith("/query")) {
        const filters = JSON.parse(String(options?.body)) as ReadFilter[];
        return Response.json(
          [project].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          ),
        );
      }
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  const queue = [`buzz://project?owner=${viewer}&d=project`];
  let ping = () => {};
  stop = bindDeepLinks(current.navigationHost, current.communities, {
    take: async () => queue.splice(0),
    watch(listener) {
      ping = listener;
      return () => {};
    },
  });
  render(<App services={current} />);
  await screen.findByRole("button", { name: "Retry navigation" });
  expect(current.navigation.snapshot()).toMatchObject({
    ingress: true,
    retryable: true,
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Switch to Fixture community" }),
  );
  expect(current.navigation.snapshot().ingress).toBe(true);
  await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
  await userEvent.click(
    screen.getByRole("button", { name: "Retry navigation" }),
  );
  await screen.findByText("Actual recovered destination");
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: {
      target: {
        kind: "page",
        pluginId: "buzz.projects",
        route: { params: { type: "project", dtag: "project" } },
      },
    },
  });
  await act(async () => {
    queue.push("buzz://unsupported");
    ping();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "invalid or unsupported",
  );
  expect(
    screen.queryByRole("button", { name: "Retry navigation" }),
  ).not.toBeInTheDocument();
});

it("reconnects a failed routed Agents edit from the shell and opens its exact editor", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  agentFixture = controlFixture();
  agentFixture.agent.relayUrl = "wss://community.example";
  agentFixture.data.agents.push({
    ...structuredClone(agentFixture.agent),
    id: "different-agent",
    pubkey: "cd".repeat(32),
    name: "Different agent",
  });
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "Fixture", picture: "" },
      memberships: [{ id: origin, name: "Fixture community" }],
      selected: origin,
    }),
  );
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/register")) return Response.json({});
      if (url.endsWith("/session")) {
        attempts++;
        return attempts === 1
          ? Response.json({ error: "relay offline" }, { status: 503 })
          : Response.json({
              viewer,
              relayAuthor: viewer,
              relayUrl: "wss://community.example",
            });
      }
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  const target = {
    version: 1 as const,
    kind: "page" as const,
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: { viewer, communityOrigin: origin },
    route: {
      version: 1 as const,
      params: { pubkey: agentFixture.agent.pubkey },
    },
  };
  render(<App services={current} />);
  await waitFor(() => expect(current.relay.snapshot().status).toBe("error"));
  void current.navigation.open(target);
  await screen.findByRole("button", { name: "Retry navigation" });
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "unavailable",
    entry: { target },
  });
  expect(screen.queryByRole("dialog", { name: "Edit agent" })).toBeNull();
  expect(attempts).toBe(1);

  await userEvent.click(
    screen.getByRole("button", { name: "Retry navigation" }),
  );
  await waitFor(() => expect(current.relay.snapshot().status).toBe("ready"));
  const dialog = await screen.findByRole("dialog", { name: "Edit agent" });
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Fixture agent");
  expect(within(dialog).getByLabelText("Agent instructions")).toHaveValue(
    "Help with the project.",
  );
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: { target },
  });
  expect(attempts).toBe(2);
});

it("lists only active primary pages in the channel sidebar", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom lacks scrollIntoView; the search palette scrolls its selection.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/query")) return Response.json([]);
      return Response.json({});
    }),
  );
  services = createServices();
  const current = services;
  render(<App services={current} />);
  const pages = await screen.findByRole("navigation", { name: "Pages" });
  await waitFor(() =>
    expect(
      within(pages)
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual(["Inbox", "Bestie", "Projects", "Agents"]),
  );

  // The fixture page is active and searchable but never a sidebar row.
  expect(current.pages.snapshot().map((page) => page.key)).toContain(
    "fixture.notes/notes",
  );

  await act(() => current.plugins.change("disable", "buzz.agents"));
  await waitFor(() =>
    expect(
      within(screen.getByRole("navigation", { name: "Pages" }))
        .getAllByRole("button")
        .map((row) => row.textContent),
    ).toEqual(["Inbox", "Bestie", "Projects"]),
  );

  await userEvent.click(screen.getByRole("button", { name: "Search Buzz" }));
  const search = await screen.findByRole("dialog", { name: "Search Buzz" });
  expect(
    within(search).getByRole("option", { name: "Fixture notes" }),
  ).toBeInTheDocument();
  expect(
    within(search).queryByRole("option", { name: "Agents" }),
  ).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");

  // Every primary page is optional; with none active the landmark goes too.
  for (const id of ["buzz.inbox", "buzz.bestie", "buzz.projects"])
    await act(() => current.plugins.change("disable", id));
  await waitFor(() =>
    expect(
      screen.queryByRole("navigation", { name: "Pages" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("complementary", { name: "Channel sidebar" }),
  ).toBeInTheDocument();
});
