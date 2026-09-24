import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createServices, type AppServices } from "./services";
import type { AgentControl } from "../features/agents/control";

// Real Agents plugin, Cordis, manager, community services, projection and IPC
// adapter. Only the two host transports are synthetic; no live app or relay.
vi.mock("../bundled", async () => ({
  bundledPlugins: [
    {
      manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
      module: await import("../bundled/agents"),
    },
  ],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));
let services: AppServices;
let enabled: boolean;
const viewer = "a".repeat(64);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  enabled = true;
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (cmd, args) => {
      // Desktop startup drains OS deep links; none arrive in this fixture.
      if (cmd === "deep_link_take") return [];
      if (cmd === "deep_link_watch") return undefined;
      if (cmd === "agent_control_snapshot" || cmd === "agent_control_action")
        return { agents: [], runtimeAvailable: false, importAvailable: false };
      if (cmd === "plugin_change")
        enabled = (args as { action: string }).action === "enable";
      if (cmd === "plugin_catalog" || cmd === "plugin_change")
        return {
          status: "ready",
          externalPluginsPaused: false,
          catalog: {
            profile: "fixture",
            location: "fixture",
            plugins: [
              {
                manifest: { id: "buzz.agents", name: "Agents", apiVersion: 1 },
                source: "bundled",
                revision: "bundled",
                enabled,
                previous: null,
                reloadable: false,
                error: null,
              },
            ],
          },
        };
      throw new Error(`Unexpected IPC: ${cmd}`);
    });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith("/identity")) return Response.json({ viewer });
      if (url.endsWith("/register")) return Response.json({});
      if (url.endsWith("/session"))
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          live: true,
          relayUrl: url.includes("/primary/")
            ? "https://primary.test"
            : "https://other.test",
        });
      if (url.endsWith("/stream"))
        return new Response(
          new ReadableStream({
            start(controller) {
              options.signal?.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      return new Promise<Response>(() => {});
    }),
  );
  services = createServices();
});
afterEach(async () => {
  await services.dispose();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("retains working injected control across Agents disable/re-enable and community switching without native actions", async () => {
  await vi.advanceTimersByTimeAsync(0);
  const control = services.agentControl;
  const injectedControl = () => {
    const page = services.pages
      .snapshot()
      .find((entry) => entry.pluginId === "buzz.agents");
    // The production registration wrapper passes its injected capability as props.
    const component = page?.component as unknown as () => {
      props: {
        control: AgentControl;
        communities: Pick<
          typeof services.communities,
          "snapshot" | "subscribe"
        >;
      };
    };
    const props = component().props;
    expect(Object.keys(props.communities).sort()).toEqual([
      "snapshot",
      "subscribe",
    ]);
    expect(props.communities.snapshot()).toBe(services.communities.snapshot());
    return props.control;
  };
  expect(injectedControl()).toBe(control);
  await control.refresh();
  expect(control.snapshot().status).toBe("ready");
  // Positive control: explicit process intent reaches the captured IPC boundary.
  await control.action("synthetic", "stop");
  expect(invoke).toHaveBeenCalledWith("agent_control_action", {
    id: "synthetic",
    action: "stop",
  });
  vi.mocked(invoke).mockClear();

  await services.plugins.change("disable", "buzz.agents");
  await vi.advanceTimersByTimeAsync(0);
  expect(services.pages.snapshot()).toHaveLength(0);
  await control.refresh();
  expect(control.snapshot().status).toBe("ready");
  await services.plugins.change("enable", "buzz.agents");
  await vi.advanceTimersByTimeAsync(0);
  expect(injectedControl()).toBe(control);

  const sessions = [];
  for (const id of ["primary", "secondary"]) {
    services.communities.joined(
      { id, name: id },
      { name: "Fixture", picture: "" },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(services.relay.snapshot().status).toBe("ready");
    sessions.push(services.relay.snapshot().session);
  }
  expect(sessions[0]).not.toBe(sessions[1]);
  for (const [id, session] of [
    ["primary", sessions[0]],
    ["secondary", sessions[1]],
  ] as const) {
    services.communities.select(id);
    expect(services.relay.snapshot().session).toBe(session);
    expect(services.agentControl).toBe(control);
    expect(injectedControl()).toBe(control);
    await control.refresh();
    expect(control.snapshot().status).toBe("ready");
  }
  services.communities.select(null);
  expect(services.relay.snapshot().status).toBe("disconnected");
  expect(injectedControl()).toBe(control);
  await control.refresh();
  expect(control.snapshot().status).toBe("ready");

  await services.dispose();
  const reads = vi.mocked(invoke).mock.calls.length;
  await control.refresh();
  expect(invoke).toHaveBeenCalledTimes(reads); // Root disposal fences projection.
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd.startsWith("agent_control_")),
    // Only four explicit reads: this fixture loads Agents without Identity Naming.
  ).toEqual(Array.from({ length: 4 }, () => ["agent_control_snapshot"]));
});
