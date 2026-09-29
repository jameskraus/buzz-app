import { Context } from "@deepseek-ai/cordis";
import { assert, afterEach, expect, it, vi } from "vitest";
import { createCommunities } from "./service";
import { communityDestination } from "./destination";
import * as destinations from "./destination";
import { flush } from "../relay/testing";
import { recordReaction } from "../messages/quick-reactions";
import { readView, writeView } from "../../shared/view-state";

const viewer = "a".repeat(64);
const roots: Context[] = [];
const requests: string[] = [];
function setup(saved?: unknown, savedViewer = viewer, openRelay = "") {
  const storage = new Map<string, string>();
  // A string is stored verbatim so cases can pin the exact stored text.
  if (saved !== undefined)
    storage.set(
      `buzz-client.v1:${savedViewer}`,
      typeof saved === "string" ? saved : JSON.stringify(saved),
    );
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      if (input.endsWith("/identity")) return Response.json({ viewer });
      if (input.endsWith("/session")) {
        const destination = input.split("/")[3];
        assert.exists(destination);
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          relayUrl: communityDestination(decodeURIComponent(destination)).url,
        });
      }
      return Response.json([]);
    }),
  );
  const ctx = new Context();
  roots.push(ctx);
  return createCommunities(ctx, true, undefined, openRelay);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  requests.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("opens an identity without touching a community and saves a local profile independently", async () => {
  const client = setup();
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  client.saveProfile({ name: "Local name", picture: "" });
  expect(client.snapshot().profile.name).toBe("Local name");
  expect(requests).toHaveLength(1);
});
it("retains separate sessions on A→B→A, and personal space does not reset them", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const a = client.relay.snapshot();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Different", picture: "" },
  );
  await flush();
  const b = client.relay.snapshot();
  expect(a.session).not.toBe(b.session);
  expect(a.scope).not.toBe(b.scope);
  client.select(null);
  expect(client.relay.snapshot().status).toBe("disconnected");
  client.select("primary");
  expect(client.relay.snapshot()).toBe(a);
  client.select("secondary");
  expect(client.relay.snapshot()).toBe(b);
  expect(client.snapshot().profile.name).toBe("Local");
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(2);
});
it("does not reuse another identity's memberships; draft and view keys include community and identity", async () => {
  const client = setup(
    {
      profile: { name: "Someone else", picture: "" },
      memberships: [{ id: "primary", name: "Primary" }],
      selected: "primary",
    },
    "c".repeat(64),
  );
  await flush();
  expect(client.snapshot().memberships).toEqual([]);
  expect(client.snapshot().profile.name).toBe("");
  writeView("community-a:identity-a", "draft:same-channel", "draft A");
  writeView("community-b:identity-a", "draft:same-channel", "draft B");
  expect(readView("community-a:identity-a", "draft:same-channel", "")).toBe(
    "draft A",
  );
  expect(readView("community-b:identity-a", "draft:same-channel", "")).toBe(
    "draft B",
  );
  expect(readView("community-a:identity-b", "draft:same-channel", "")).toBe("");
});
it("restores only the selected membership on launch", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "secondary", name: "Secondary" },
    ],
    selected: "secondary",
  });
  await flush();
  await flush();
  expect(client.snapshot().selected).toBe("secondary");
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/secondary/session",
  ]);
});

it("a failing community does not replace its healthy sibling or the local profile", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const healthy = client.relay.snapshot();
  vi.mocked(fetch).mockImplementationOnce(async () =>
    Response.json({ error: "Unavailable" }, { status: 503 }),
  );
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Community", picture: "" },
  );
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(client.snapshot().profile.name).toBe("Local");
  client.select("primary");
  expect(client.relay.snapshot()).toBe(healthy);
});

it("keeps local actions and completed joins usable when storage writes fail", async () => {
  const client = setup();
  await flush();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Storage quota exceeded");
  });
  client.saveProfile({ name: "Local", picture: "" });
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Remote", picture: "" },
  );
  await flush();
  expect(client.snapshot()).toMatchObject({
    profile: { name: "Local" },
    selected: "primary",
    memberships: [{ id: "primary" }],
  });
  expect(client.relay.snapshot().status).toBe("ready");
  client.select(null);
  expect(client.snapshot().selected).toBeNull();
});

it("ignores invalid and duplicate memberships without discarding a valid local profile", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      null,
      { id: "primary", name: "Primary" },
      { id: "primary", name: "Duplicate" },
      { id: "secondary", name: "Secondary" },
    ],
    selected: "secondary",
  });
  await flush();
  expect(client.snapshot().profile.name).toBe("Local");
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "primary",
    "secondary",
  ]);
  expect(client.snapshot().selected).toBe("secondary");
});

it("persists arbitrary canonical origins, preserves legacy aliases, and restores only the selected one", async () => {
  const client = setup();
  await flush();
  for (const id of [
    "primary",
    "wss://THIRD.example:443/",
    "https://fourth.example",
    "wss://fifth.example:8443",
  ]) {
    client.joined({ id, name: id }, { name: "Local", picture: "" });
    await flush();
  }
  client.joined(
    { id: "https://third.example/", name: "Third renamed" },
    { name: "Other", picture: "" },
  );
  await flush();
  expect(client.snapshot().memberships).toHaveLength(4);
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(client.relay.snapshot().scope).toContain("https://third.example");
  const persisted = localStorage.getItem(`buzz-client.v1:${viewer}`);
  assert.exists(persisted);
  const saved = JSON.parse(persisted);
  requests.length = 0;
  const restored = setup(saved);
  await flush();
  await flush();
  expect(restored.snapshot()).toMatchObject({ ...saved, status: "ready" });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  expect(requests.indexOf("/api/relay/register")).toBeLessThan(
    requests.indexOf("/api/relay/https%3A%2F%2Fthird.example/session"),
  );
});

it("normalizes old and new stored spellings without duplicates or unsafe automatic connections", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "primary", name: "Primary" },
      { id: "WSS://PRIMARY.EXAMPLE:443/", name: "Duplicate" },
      { id: "wss://THIRD.example/", name: "Third" },
      { id: "https://third.example", name: "Duplicate third" },
      { id: "http://unsafe.example", name: "Unsafe" },
      { id: "https://user:secret@unsafe.example", name: "Credentials" },
    ],
    selected: "wss://THIRD.example:443/",
  });
  await flush();
  await flush();
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "primary",
    "https://third.example",
  ]);
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  const before = client.snapshot();
  expect(() =>
    client.joined(
      { id: "https://bad.example/path", name: "Bad" },
      { name: "Other", picture: "" },
    ),
  ).toThrow();
  expect(client.snapshot()).toBe(before);
});

it("does not acquire a session after rejected registration and registers again on retry", async () => {
  const client = setup();
  await flush();
  vi.mocked(fetch).mockImplementationOnce(async () =>
    Response.json({ error: "Registration rejected" }, { status: 403 }),
  );
  client.joined(
    { id: "wss://third.example", name: "Third" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(client.relay.snapshot().status).toBe("error");
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(0);
  client.relay.retry();
  await flush();
  await flush();
  expect(client.relay.snapshot().status).toBe("ready");
  expect(
    requests.filter(
      (url) => url.endsWith("/register") || url.endsWith("/session"),
    ),
  ).toEqual([
    "/api/relay/register",
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
});

it("selects alternate URL spellings through the canonical retained session", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "wss://third.example", name: "Third" },
    { name: "Local", picture: "" },
  );
  await flush();
  await flush();
  const original = client.relay.snapshot();
  const connections = requests.filter((url) => url.endsWith("/session")).length;
  client.select(null);
  client.select(" WSS://THIRD.example:443/ ");
  expect(client.snapshot().selected).toBe("https://third.example");
  expect(client.relay.snapshot()).toBe(original);
  expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(
    connections,
  );
});

it("preserves unresolved saved aliases across profile saves and reloads without connecting", async () => {
  const membership = {
    id: "unconfigured-old",
    name: "Saved community",
    icon: "https://images.example/icon.png",
  };
  const saved = {
    profile: { name: "Before", picture: "" },
    memberships: [membership],
    selected: membership.id,
  };
  const client = setup(saved);
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(() => client.select(membership.id)).toThrow();
  client.saveProfile({ name: "After", picture: "" });
  const persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted).toEqual({
    ...saved,
    profile: { name: "After", picture: "" },
  });
  const reloaded = setup(persisted);
  await flush();
  reloaded.saveProfile({ name: "After reload", picture: "" });
  const again = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(again.memberships).toEqual([membership]);
  expect(again.selected).toBe(membership.id);
  expect(requests).toEqual(["/api/relay/identity", "/api/relay/identity"]);
  // Model a restart with the original deployment mapping restored.
  const resolve = destinations.communityDestination;
  const aliases = destinations.parseCommunityAliases(
    '{"unconfigured-old":"https://restored.example"}',
  );
  vi.spyOn(destinations, "communityDestination").mockImplementation((value) =>
    resolve(value, aliases),
  );
  const restored = setup(again);
  await flush();
  expect(restored.snapshot()).toMatchObject({
    memberships: [membership],
    selected: membership.id,
  });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/unconfigured-old/session",
  ]);
  expect(restored.relay.snapshot().scope).toBe(
    `https://restored.example:${viewer}`,
  );
});

it("retains unresolved memberships but honors an explicit Personal selection or a new join", async () => {
  const membership = { id: "unconfigured-old", name: "Saved community" };
  const client = setup({
    profile: { name: "Before", picture: "" },
    memberships: [membership],
    selected: membership.id,
  });
  await flush();
  client.select(null);
  let persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([membership]);
  expect(persisted.selected).toBeNull();
  client.joined(
    { id: "primary", name: "New community" },
    { name: "After", picture: "" },
  );
  await flush();
  persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([
    { id: "primary", name: "New community" },
    membership,
  ]);
  expect(persisted.selected).toBe("primary");
  expect(requests.some((url) => url.includes("unconfigured-old"))).toBe(false);
});

it("keeps only valid unique unresolved aliases and never carries them to another identity", async () => {
  const saved = {
    profile: { name: "Before", picture: "" },
    memberships: [
      { id: "unconfigured-old", name: "Saved" },
      { id: "unconfigured-old", name: "Duplicate" },
      { id: "bad/id", name: "Invalid" },
      { id: "https://user:secret@private.example", name: "Invalid" },
      { id: "constructor", name: "Invalid" },
      { id: "prototype", name: "Invalid" },
      { id: "__proto__", name: "Invalid" },
    ],
    selected: "constructor",
  };
  const client = setup(saved);
  await flush();
  client.saveProfile({ name: "After", picture: "" });
  const persisted = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null",
  );
  expect(persisted.memberships).toEqual([
    { id: "unconfigured-old", name: "Saved" },
  ]);
  expect(persisted.selected).toBeNull();
  const other = setup(saved, "c".repeat(64));
  await flush();
  other.saveProfile({ name: "Other", picture: "" });
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null")
      .memberships,
  ).toEqual([]);
});

it("opens the configured relay for an identity without a saved record and remembers it", async () => {
  const client = setup(undefined, viewer, "https://third.example");
  await flush();
  await flush();
  const membership = { id: "https://third.example", name: "third.example" };
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    profile: { name: "", picture: "" },
    memberships: [membership],
    selected: membership.id,
  });
  expect(requests.filter((url) => url.endsWith("/session"))).toEqual([
    "/api/relay/https%3A%2F%2Fthird.example/session",
  ]);
  const persisted = localStorage.getItem(`buzz-client.v1:${viewer}`);
  assert.exists(persisted);
  expect(JSON.parse(persisted)).toEqual({
    profile: { name: "", picture: "", about: "" },
    memberships: [membership],
    selected: membership.id,
  });
  // A configured alias for the relay origin is honored like any other join.
  const aliased = setup(undefined, "c".repeat(64), "wss://primary.example");
  await flush();
  expect(aliased.snapshot().memberships).toEqual([
    { id: "primary", name: "primary.example" },
  ]);
  expect(aliased.snapshot().selected).toBe("primary");
});

it("does not seed the configured relay over a stored falsy record", async () => {
  const client = setup("null", viewer, "https://third.example");
  await flush();
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe("null");
});

it("does not seed the configured relay over a stored malformed record", async () => {
  const client = setup('{"memberships":', viewer, "https://third.example");
  await flush();
  await flush();
  expect(client.snapshot()).toMatchObject({
    status: "ready",
    memberships: [],
    selected: null,
  });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe(
    '{"memberships":',
  );
});

it("keeps a saved record, including Personal space, instead of the configured relay", async () => {
  const saved = {
    profile: { name: "Local", picture: "" },
    memberships: [{ id: "primary", name: "Primary" }],
    selected: null,
  };
  const client = setup(saved, viewer, "https://third.example");
  await flush();
  await flush();
  expect(client.snapshot()).toMatchObject({ ...saved, status: "ready" });
  expect(requests).toEqual(["/api/relay/identity"]);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe(
    JSON.stringify(saved),
  );
});

it("leave forgets the selected community: Personal space, a disposed session and purged device state", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.select("primary");
  const primaryScope = `${communityDestination("primary").url}:${viewer}`;
  const secondaryScope = `${communityDestination("secondary").url}:${viewer}`;
  writeView(primaryScope, "draft:general", "unsent");
  writeView(primaryScope, "channel", "general");
  writeView(secondaryScope, "draft:general", "kept");
  const sessions = () => requests.filter((url) => url.endsWith("/session"));
  const before = sessions().length;
  // Every store cleared, so there is nothing to report.
  expect(await client.leave("primary")).toEqual([]);
  expect(client.snapshot()).toMatchObject({
    selected: null,
    memberships: [{ id: "secondary", name: "Secondary" }],
  });
  expect(client.relay.snapshot().status).toBe("disconnected");
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null"),
  ).toMatchObject({
    memberships: [{ id: "secondary", name: "Secondary" }],
    selected: null,
  });
  // Only the left community's partition is gone.
  expect(readView(primaryScope, "draft:general", "")).toBe("");
  expect(readView(primaryScope, "channel", "")).toBe("");
  expect(readView(secondaryScope, "draft:general", "")).toBe("kept");
  // The retained session was disposed: rejoining connects afresh.
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  await flush();
  expect(sessions()).toHaveLength(before + 1);
  expect(sessions().at(-1)).toBe("/api/relay/primary/session");
  expect(client.relay.snapshot().status).toBe("ready");
});

it("leave of an inactive community keeps the selection and its session; unknown ids are a no-op", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const active = client.relay.snapshot();
  await client.leave("primary");
  expect(client.snapshot()).toMatchObject({
    selected: "secondary",
    memberships: [{ id: "secondary" }],
  });
  expect(client.relay.snapshot()).toBe(active);
  const state = client.snapshot();
  const persisted = localStorage.getItem(`buzz-client.v1:${viewer}`);
  expect(await client.leave("https://unknown.example")).toEqual([]);
  expect(client.snapshot()).toBe(state);
  expect(localStorage.getItem(`buzz-client.v1:${viewer}`)).toBe(persisted);
});

it("leave still forgets the community when a store will not clear, and logs and returns what remained", async () => {
  const client = setup();
  await flush();
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  const origin = communityDestination("primary").url;
  recordReaction(`${origin}:${viewer}`, "🎉");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Key enumeration is what the view and channel-setup sweeps rely on.
  const denied = new Error("denied");
  vi.spyOn(localStorage, "key").mockImplementation(() => {
    throw denied;
  });
  const failures = await client.leave("primary");
  expect(client.snapshot()).toMatchObject({ selected: null, memberships: [] });
  expect(client.relay.snapshot().status).toBe("disconnected");
  // The stores that could be cleared were; the rest are named for the caller.
  expect(
    localStorage.getItem(`buzz.quick-reactions.v1:${origin}:${viewer}`),
  ).toBeNull();
  expect(failures).toEqual([
    { store: "view state", error: denied },
    { store: "channel setups", error: denied },
  ]);
  expect(warn).toHaveBeenCalledWith(
    `Couldn't clear view state for ${origin} on this device`,
    denied,
  );
  expect(warn).toHaveBeenCalledWith(
    `Couldn't clear channel setups for ${origin} on this device`,
    denied,
  );
});

it("leaving the last community lands on Personal space with an empty saved record", async () => {
  const client = setup({
    profile: { name: "Local", picture: "" },
    memberships: [{ id: "primary", name: "Primary" }],
    selected: "primary",
  });
  await flush();
  await flush();
  expect(client.relay.snapshot().status).toBe("ready");
  // Alternate spellings resolve to the saved canonical id.
  await client.leave("wss://PRIMARY.example:443/");
  expect(client.snapshot()).toMatchObject({ memberships: [], selected: null });
  expect(client.relay.snapshot().status).toBe("disconnected");
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null"),
  ).toEqual({
    profile: { name: "Local", picture: "", about: "" },
    memberships: [],
    selected: null,
  });
});

it("hydrates presence intent before acquiring a retained session and keeps it across communities", async () => {
  const client = setup();
  localStorage.setItem(`buzz-presence.v1:${viewer}`, "offline");
  await flush();
  expect(client.presence.status()).toBe("offline");
  client.joined(
    { id: "primary", name: "Primary" },
    { name: "Local", picture: "" },
  );
  await flush();
  client.joined(
    { id: "secondary", name: "Secondary" },
    { name: "Local", picture: "" },
  );
  await flush();
  expect(client.presence.status()).toBe("offline");
  client.presence.setPreference("away");
  client.select("primary");
  expect(client.presence.status()).toBe("away");
  expect(localStorage.getItem(`buzz-presence.v1:${viewer}`)).toBe("away");
});

it("hydrates native public identity without contacting the development broker", async () => {
  const nativeViewer = "c".repeat(64);
  const saved = {
    profile: { name: "Native", picture: "" },
    memberships: [{ id: "https://native.example", name: "Native community" }],
    selected: "https://native.example",
  };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) =>
      key === `buzz-client.v1:${nativeViewer}` ? JSON.stringify(saved) : null,
    setItem: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Broker must not be contacted");
    }),
  );
  const ctx = new Context();
  roots.push(ctx);
  let resolve!: (viewer: string) => void;
  const ready = new Promise<string>((done) => {
    resolve = done;
  });
  const client = createCommunities(ctx, false, undefined, "", undefined, ready);
  expect(client.snapshot().status).toBe("loading");
  resolve(nativeViewer);
  await flush();
  expect(client.snapshot()).toMatchObject({
    ...saved,
    viewer: nativeViewer,
    status: "ready",
    relayAvailable: false,
  });
  client.select(saved.selected);
  client.relay.retry();
  await flush();
  expect(fetch).not.toHaveBeenCalled();
  expect(client.relay.snapshot().status).not.toBe("ready");
});
