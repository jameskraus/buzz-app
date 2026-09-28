import { getLogger, setLogLevel } from "../developer/logging";
import { assert, afterEach, expect, it, vi } from "vitest";
import {
  createLiveAdmission,
  liveChannels,
  subscribeRelayTraffic,
  type LiveCallbacks,
} from "./live";
import { keypair, message, roster, signed, scriptedTransport } from "./testing";
import { createRelaySession } from "./session";
class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
  requests() {
    return this.sent.filter((entry) => entry[0] === "REQ") as [
      string,
      string,
      {
        kinds: number[];
        "#h"?: string[];
        "#p"?: string[];
        since: number;
        limit: number;
      },
    ][];
  }
  async auth() {
    await this.receive(["AUTH", "challenge"]);
    const event = this.sent.find((entry) => entry[0] === "AUTH")?.[1] as {
      id: string;
    };
    await this.receive(["OK", event.id, true]);
  }
}
afterEach(() => vi.useRealTimers());
function setup(channels = ["a", "b"]) {
  const key = keypair(),
    sockets: Socket[] = [];
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  } satisfies LiveCallbacks;
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    callbacks,
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  owner.update(channels);
  const first = sockets[0];
  assert.exists(first);
  return { key, sockets, callbacks, owner, first };
}
it("uses independent explicit channel routes and self-p globals; equal interests do not restart", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests().map((r) => r[2])).toEqual([
    { kinds: [0, 10100, 30177], since: expect.any(Number), limit: 500 },
    {
      kinds: [44100, 44101],
      "#p": [h.key.pubkey],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([
        20002, 9, 40002, 40008, 40003, 7, 39002, 40099,
      ]),
      "#h": ["a"],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: expect.arrayContaining([9]),
      "#h": ["b"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  const before = h.first.sent.length;
  h.owner.update(["b", "a", "a"]);
  expect(h.first.sent).toHaveLength(before);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(keypair(), "a", "incoming", 1700000000);
  await h.first.receive(["EVENT", request[1], event]);
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
    channelId: "a",
  });
  await h.first.receive(["EVENT", request[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "live",
    channelId: "a",
  });
  expect(h.callbacks.established).toHaveBeenCalledWith("a");
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find(
      (r) => r.channelId === "a",
    ),
  ).toMatchObject({ status: "live", replay: "unknown" });
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("isolates denial, fences removed/readded routes and late sockets, and disposes retries", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const a = h.first.requests()[2],
    b = h.first.requests()[3];
  assert.exists(a);
  assert.exists(b);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.denied).toHaveBeenCalledWith(
    "a",
    "restricted: not a channel member",
  );
  expect(h.first.readyState).toBe(1);
  await h.first.receive(["EOSE", b[1]]);
  h.owner.update(["b"]);
  h.owner.update(["a", "b"]);
  await vi.advanceTimersByTimeAsync(250);
  const fresh = h.first.requests().at(-1);
  assert.exists(fresh);
  expect(fresh[1]).not.toBe(a[1]);
  await h.first.receive(["EVENT", a[1], message(h.key, "a", "stale", 1)]);
  await h.first.receive(["CLOSED", a[1], "restricted: not a channel member"]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  expect(h.callbacks.denied).toHaveBeenCalledTimes(1);
  h.first.close();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.sockets).toHaveLength(2);
  await h.first.receive(["EVENT", b[1], message(h.key, "b", "old socket", 2)]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  h.owner.dispose();
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.sockets).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("times out individual setup, releases queue slots and never calls capped replay complete", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b", "c", "d"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  expect(h.first.requests()).toHaveLength(4);
  const a = h.first.requests()[2];
  assert.exists(a);
  const event = message(h.key, "a", "echo", 1);
  for (let i = 0; i < 500; i++) await h.first.receive(["EVENT", a[1], event]);
  await h.first.receive(["EOSE", a[1]]);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.first.requests()).toHaveLength(5);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.replay,
  ).toBe("limited");
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.first.requests()).toHaveLength(6);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "b")
      ?.status,
  ).toBe("error");
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("bounds interests and exposes every omitted ID without exceeding 1024 subscriptions", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 1024 },
    (_, i) => `channel-${i.toString().padStart(4, "0")}`,
  );
  const h = setup(ids);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  let index = 0;
  while (index < 1024) {
    if (index >= h.first.requests().length)
      await vi.advanceTimersByTimeAsync(250);
    const request = h.first.requests()[index++];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
  }
  expect(h.first.requests()).toHaveLength(1024);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes
      .filter((r) => r.status === "limited")
      .map((r) => r.channelId),
  ).toEqual(ids.slice(1022));
  expect(() => liveChannels([...ids, "excess"])).toThrow();
  for (const invalid of [[""], ["a b"], ["x".repeat(129)], [9], {}])
    expect(() => liveChannels(invalid)).toThrow();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("surfaces invalid signatures and terminal auth failure without an automatic policy loop", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const request = h.first.requests()[2];
  assert.exists(request);
  const event = message(h.key, "a", "valid", 1);
  await h.first.receive([
    "EVENT",
    request[1],
    { ...event, content: "tampered" },
  ]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.status,
  ).toBe("error");
  h.owner.dispose();
  const key = keypair(),
    socket = new Socket(),
    state = vi.fn();
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    keypair().pubkey,
    { state, receive: vi.fn(), established: vi.fn(), denied: vi.fn() },
    () => socket as unknown as WebSocket,
  );
  await socket.receive(["AUTH", "challenge"]);
  expect(state.mock.lastCall?.[0]).toMatchObject({
    status: "error",
    error: "Live signer does not match viewer",
  });
  expect(socket.sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it("bounds outstanding setup by the supplied concurrency", async () => {
  const key = keypair();
  const socket = new Socket();
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => signed(key, event),
    key.pubkey,
    { receive() {}, state() {}, established() {}, denied() {} },
    () => socket as unknown as WebSocket,
    undefined,
    16,
  );
  owner.update(Array.from({ length: 40 }, (_, i) => `channel-${i}`));
  await socket.auth();
  expect(socket.requests()).toHaveLength(16);
  const first = socket.requests()[0];
  assert.exists(first);
  await socket.receive(["EOSE", first[1]]);
  expect(socket.requests()).toHaveLength(17);
  owner.dispose();
});
it("refills setup immediately on EOSE; quota CLOSED pauses the whole queue and only retries refused routes", async () => {
  vi.useFakeTimers();
  const h = setup(Array.from({ length: 80 }, (_, i) => `channel-${i}`));
  await h.first.auth();
  // Each completion immediately frees one of four outstanding setup slots.
  for (let i = 0; i < 20; i++) {
    expect(h.first.requests()).toHaveLength(i + 4);
    const request = h.first.requests()[i];
    assert.exists(request);
    await h.first.receive(["EOSE", request[1]]);
    expect(h.first.requests()).toHaveLength(i + 5);
    expect(performance.now()).toBe(0);
  }
  const refused = h.first.requests()[20];
  assert.exists(refused);
  const before = h.first.requests().length;
  await h.first.receive([
    "CLOSED",
    refused[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  await vi.advanceTimersByTimeAsync(2999);
  expect(h.first.requests()).toHaveLength(before);
  // Explicit retry keeps established routes and cannot bypass the shared cooldown.
  h.owner.retry();
  expect(h.sockets).toHaveLength(1);
  expect(h.first.requests()).toHaveLength(before);
  await vi.advanceTimersByTimeAsync(1);
  const retry = h.first.requests().at(-1);
  assert.exists(retry);
  expect(retry[2]).toEqual(refused[2]);
  expect(retry[1]).not.toBe(refused[1]);
  await h.first.receive(["EOSE", refused[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(20);
  await h.first.receive(["EOSE", retry[1]]);
  expect(
    h.callbacks.state.mock.lastCall?.[0].routes.filter(
      (r) => r.status === "live",
    ),
  ).toHaveLength(21);
  expect(h.callbacks.denied).not.toHaveBeenCalled();
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves host cooldown across subscription replacement and stops bounded quota retries", async () => {
  vi.useFakeTimers();
  const key = keypair();
  const admission = createLiveAdmission();
  const callbacks = {
    receive: vi.fn(),
    state: vi.fn<LiveCallbacks["state"]>(),
    established: vi.fn(),
    denied: vi.fn(),
  };
  const open = () => {
    const socket = new Socket();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (e) => signed(key, e),
      key.pubkey,
      callbacks,
      () => socket as unknown as WebSocket,
      admission,
    );
    owner.update(["a", "b"]);
    return { socket, owner };
  };
  const first = open();
  await first.socket.auth();
  const request = first.socket.requests()[0];
  assert.exists(request);
  await first.socket.receive([
    "CLOSED",
    request[1],
    "rate-limited: quota exceeded; retry in 2s",
  ]);
  first.owner.dispose();
  const second = open();
  await second.socket.auth();
  expect(second.socket.requests()).toHaveLength(0);
  second.owner.retry();
  await vi.advanceTimersByTimeAsync(2999);
  expect(second.socket.requests()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 4; i++) {
    const pending = second.socket.requests().at(-1);
    assert.exists(pending);
    await second.socket.receive([
      "CLOSED",
      pending[1],
      "rate-limited: quota exceeded; retry in 2s",
    ]);
    await vi.advanceTimersByTimeAsync(3000);
  }
  const count = second.socket.requests().length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(second.socket.requests()).toHaveLength(count);
  expect(
    callbacks.state.mock.lastCall?.[0].routes.every(
      (r) => r.status === "error",
    ),
  ).toBe(true);
  expect(callbacks.denied).not.toHaveBeenCalled();
  second.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["61", "9007199254740992"])(
  "an unsupported %s-second hint stops the unsent queue instead of draining it",
  async (seconds) => {
    vi.useFakeTimers();
    const h = setup(["a", "b", "c", "d"]);
    await h.first.auth();
    const request = h.first.requests()[0];
    assert.exists(request);
    await h.first.receive([
      "CLOSED",
      request[1],
      `rate-limited: quota exceeded; retry in ${seconds}s`,
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(4);
    expect(
      h.callbacks.state.mock.lastCall?.[0].routes.filter(
        (r) => r.status === "error",
      ).length,
    ).toBe(3);
    h.owner.retry();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.first.requests()).toHaveLength(4);
    h.owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("disposal from a live state notification fences the following established callback", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  const request = h.first.requests()[0];
  assert.exists(request);
  h.callbacks.state.mockImplementation((snapshot) => {
    if (snapshot.routes.some((r) => r.status === "live")) h.owner.dispose();
  });
  await h.first.receive(["EOSE", request[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

// Reentrant remove/re-add control contributed by Brain.
it("EOSE from a removed incarnation cannot establish its replacement", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(500);
    const old = h.first.requests()[2];
    assert.exists(old);
    let replaced = false;
    h.callbacks.state.mockImplementation((snapshot) => {
      if (
        !replaced &&
        snapshot.routes.find((r) => r.channelId === "a")?.status === "live"
      ) {
        replaced = true;
        h.owner.update(["b"]);
        h.owner.update(["a", "b"]);
      }
    });
    await h.first.receive(["EOSE", old[1]]);
    expect(replaced).toBe(true);
    expect(h.callbacks.established).not.toHaveBeenCalledWith("a");
    await vi.advanceTimersByTimeAsync(500);
    const fresh = h.first
      .requests()
      .find((r) => r[2]["#h"]?.[0] === "a" && r[1] !== old[1]);
    assert.exists(fresh);
    await h.first.receive(["EOSE", fresh[1]]);
    expect(h.callbacks.established).toHaveBeenCalledWith("a");
  } finally {
    h.owner.dispose();
  }
});

it("prioritizes a demanded tail channel after globals, without bypassing cooldown or adding interests", async () => {
  vi.useFakeTimers();
  const ids = Array.from(
    { length: 128 },
    (_, i) => `channel-${String(i).padStart(3, "0")}`,
  );
  const h = setup(ids);
  try {
    h.owner.prioritize?.([ids[127] as string, "unowned"]);
    await h.first.auth();
    expect(h.first.requests()[2]?.[2]["#h"]).toEqual([ids[127]]);
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    h.owner.prioritize?.([ids[126] as string]);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.first.requests()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await h.first.receive(["EOSE", h.first.requests().at(-1)?.[1]]);
    expect(h.first.requests().at(-1)?.[2]["#h"]).toEqual([ids[126]]);
    expect(h.first.requests().some((r) => r[2]["#h"]?.[0] === "unowned")).toBe(
      false,
    );
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("retains quota recovery evidence through automatic and manual retries until fresh EOSE", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    const error = "rate-limited: quota exceeded; retry in 0s";
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (r) => r.id === "profiles",
      );
    await h.first.receive(["CLOSED", first[1], error]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await vi.advanceTimersByTimeAsync(1000);
    const retry = h.first.requests().at(-1);
    assert.exists(retry);
    // Force an unrelated notification after retry dispatch: old error must not
    // disappear just because the new REQ was sent, or because stale EOSE arrives.
    h.owner.prioritize?.(["a"]);
    await h.first.receive(["EOSE", first[1]]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    await h.first.receive(["EOSE", retry[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
    // Exhaust the same route's remaining automatic attempts.
    for (let i = 0; i < 3; i++) {
      const latest = h.first
        .requests()
        .filter((r) => r[2].kinds?.includes(0))
        .at(-1);
      assert.exists(latest);
      await h.first.receive(["CLOSED", latest[1], error]);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    h.owner.prioritize?.(["b"]);
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds?.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("replaces unconfirmed quota recovery with a timeout and retains nonquota manual failures", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    const first = h.first.requests()[0];
    assert.exists(first);
    await h.first.receive([
      "CLOSED",
      first[1],
      "rate-limited: quota exceeded; retry in 0s",
    ]);
    await vi.advanceTimersByTimeAsync(11000);
    const profiles = () =>
      h.callbacks.state.mock.lastCall?.[0].routes.find(
        (route) => route.id === "profiles",
      );
    const error = "Live subscription setup timed out; retry available";
    expect(profiles()).toMatchObject({ status: "error", error });
    h.owner.retry();
    expect(profiles()).toMatchObject({ status: "pending", error });
    const manual = h.first
      .requests()
      .filter((r) => r[2].kinds.includes(0))
      .at(-1);
    assert.exists(manual);
    await h.first.receive(["EOSE", manual[1]]);
    expect(profiles()).toMatchObject({ status: "live" });
    expect(profiles()).not.toHaveProperty("error");
  } finally {
    h.owner.dispose();
  }
});

it("requests statuses and community emoji on the profile route and delivers verified updates", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  await h.first.auth();
  const req = h.first.sent.find((entry) => entry[0] === "REQ");
  expect(req?.slice(2)).toEqual([
    { kinds: [0, 10100, 30177], since: expect.any(Number), limit: 500 },
    {
      kinds: [30315],
      "#d": ["general"],
      since: expect.any(Number),
      limit: 500,
    },
    {
      kinds: [30030],
      "#d": ["buzz:custom-emoji"],
      since: expect.any(Number),
      limit: 500,
    },
  ]);
  const event = signed(h.key, {
    kind: 30030,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ["emoji", "party", "https://x.test/p"],
    ],
  });
  await h.first.receive(["EVENT", req?.[1], event]);
  expect(h.callbacks.receive).toHaveBeenCalledWith([event], {
    phase: "replay",
  });
  h.owner.dispose();
});

it("a reconnect starts a new replay phase even for previously established routes", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const request = h.first.requests()[2];
  assert.exists(request);
  await h.first.receive(["EOSE", request[1]]);
  const event = message(keypair(), "a", "live", 1700000000);
  await h.first.receive(["EVENT", request[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "live",
    channelId: "a",
  });
  h.first.close();
  await vi.advanceTimersByTimeAsync(500);
  const socket = h.sockets[1];
  assert.exists(socket);
  await socket.auth();
  await vi.advanceTimersByTimeAsync(750);
  const replay = socket.requests()[2];
  assert.exists(replay);
  await socket.receive(["EVENT", replay[1], event]);
  expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
    phase: "replay",
    channelId: "a",
  });
  h.owner.dispose();
});

it("live channel provenance excludes observer telemetry while preserving membership traffic", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first.requests()[2];
    assert.exists(route);
    await h.first.receive(["EOSE", route[1]]);
    const telemetry = signed(h.key, {
      kind: 24200,
      content: "opaque",
      tags: [],
    });
    await h.first.receive(["EVENT", route[1], telemetry]);
    expect(h.callbacks.receive).not.toHaveBeenCalled();
    const membership = signed(h.key, {
      kind: 40099,
      content: "{}",
      tags: [["h", "a"]],
    });
    await h.first.receive(["EVENT", route[1], membership]);
    expect(h.callbacks.receive).toHaveBeenCalledExactlyOnceWith([membership], {
      phase: "live",
      channelId: "a",
    });
  } finally {
    h.owner.dispose();
  }
});

it("observer route is optional, live-only at dispatch/retry, separately fenced and never ordinary replay", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const h = setup([]);
  const telemetry = vi.fn();
  Object.assign(h.callbacks, { telemetry });
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(500);
  const globals = h.first.requests().map((request) => request[1]);
  h.owner.observe?.(1);
  await vi.advanceTimersByTimeAsync(250);
  const first = h.first.requests().at(-1);
  assert.exists(first);
  expect(first[2]).toEqual({
    kinds: [24200],
    "#p": [h.key.pubkey],
    since: Math.floor(Date.now() / 1000),
  });
  const event = signed(h.key, {
    kind: 24200,
    content: "opaque",
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  });
  await h.first.receive(["EVENT", first[1], event]);
  expect(telemetry).toHaveBeenCalledWith(event, 1);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EOSE", first[1]]);
  expect(h.callbacks.established).not.toHaveBeenCalled();
  await h.first.receive(["CLOSED", first[1], "temporary: unavailable"]);
  await vi.advanceTimersByTimeAsync(3000);
  h.owner.retry();
  const retried = h.first.requests().at(-1);
  assert.exists(retried);
  expect(retried[2].since).toBeGreaterThan(first[2].since);
  h.owner.observe?.(2);
  await vi.advanceTimersByTimeAsync(250);
  await h.first.receive(["EVENT", first[1], event]);
  await h.first.receive(["EVENT", retried[1], event]);
  expect(telemetry).toHaveBeenCalledTimes(1);
  h.owner.observe?.(null);
  expect(
    h.first.sent
      .filter((entry) => entry[0] === "CLOSE")
      .some((entry) => globals.includes(entry[1] as string)),
  ).toBe(false);
  expect(h.sockets).toHaveLength(1);
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("presence holds its receipt without delaying ordinary setup and shares correlated cooldown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  expect(
    await h.owner.publishPresence?.("online", new AbortController().signal),
  ).toBeNull();
  await h.first.auth();
  // No EOSE: ordinary setup is still pending.
  const abort = new AbortController();
  const result = h.owner.publishPresence?.("online", abort.signal);
  await vi.advanceTimersByTimeAsync(0);
  const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
    id: string;
    content: string;
  };
  assert.exists(event);
  expect(event.content).toBe("online");
  h.owner.update(["foreground"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.first.requests().at(-1)?.[2]["#h"]).toEqual(["foreground"]);
  abort.abort(); // Keep the receipt correlation after cancellation, to honor late quota.
  await h.first.receive(["OK", "unrelated", true]);
  await h.first.receive([
    "OK",
    event.id,
    false,
    "rate-limited: quota exceeded; retry in 3s",
  ]);
  expect(await result).toBe(false);
  const count = h.first.requests().length;
  h.owner.update(["foreground", "next"]);
  expect(h.first.requests()).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(4000);
  expect(h.first.requests()).toHaveLength(count + 1);
  h.owner.dispose();
});

it("an outstanding presence signer pins its principal flight across socket replacement", async () => {
  vi.useFakeTimers();
  const key = keypair(),
    sockets: Socket[] = [];
  const admission = createLiveAdmission();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const callbacks = { receive() {}, state() {}, established() {}, denied() {} };
  const owner = subscribeRelayTraffic(
    "wss://relay.test",
    async (event) => {
      if (event.kind === 20001) await gate;
      return signed(key, event);
    },
    key.pubkey,
    callbacks,
    () => {
      const s = new Socket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    admission,
  );
  const first = sockets[0];
  assert.exists(first);
  await first.auth();
  await vi.advanceTimersByTimeAsync(500);
  for (const [, id] of first.requests()) await first.receive(["EOSE", id]);
  const result = owner.publishPresence?.("away", new AbortController().signal);
  expect(admission.presenceIdle()).toBe(false);
  first.close();
  await vi.advanceTimersByTimeAsync(500);
  const next = sockets[1];
  assert.exists(next);
  await next.auth();
  await vi.advanceTimersByTimeAsync(500);
  for (const [, id] of next.requests()) await next.receive(["EOSE", id]);
  expect(
    await owner.publishPresence?.("online", new AbortController().signal),
  ).toBeNull();
  release();
  expect(await result).toBeNull();
  expect(
    sockets.flatMap((s) => s.sent).filter(([kind]) => kind === "EVENT"),
  ).toEqual([]);
  expect(admission.presenceIdle()).toBe(true);
  owner.dispose();
});

it("admits signed typing only on its authenticated channel route, without extra subscriptions", async () => {
  vi.useFakeTimers();
  const h = setup();
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const requests = h.first.requests();
  expect(requests).toHaveLength(4);
  const route = requests[2];
  assert.exists(route);
  expect(route[2].kinds).toContain(20002);
  const event = signed(keypair(), {
    kind: 20002,
    content: "",
    tags: [["h", "a"]],
  });
  await h.first.receive(["EVENT", requests[0]?.[1], event]);
  await h.first.receive(["EVENT", requests[3]?.[1], event]);
  expect(h.callbacks.receive).not.toHaveBeenCalled();
  await h.first.receive(["EVENT", route[1], event]);
  expect(h.callbacks.receive).toHaveBeenCalledExactlyOnceWith([event], {
    channelId: "a",
    phase: "replay",
  });
  await h.first.receive([
    "EVENT",
    route[1],
    { ...event, sig: "0".repeat(128) },
  ]);
  expect(h.callbacks.receive).toHaveBeenCalledTimes(1);
  h.owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps misrouted activity out of accessible conversations; session rejects ambiguous scope", async () => {
  vi.useFakeTimers();
  const h = setup();
  const relay = keypair();
  const wire = scriptedTransport(h.key.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      h.callbacks.receive.mockImplementation(callbacks.receive);
      h.callbacks.state.mockImplementation(callbacks.state);
      return h.owner;
    },
  });
  // Establish both accessible channels before starting their live routes.
  h.callbacks.receive([
    roster(relay, "a", [h.key.pubkey]),
    roster(relay, "b", [h.key.pubkey]),
  ]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const requests = h.first.requests();
  const a = requests.find((r) => r[2]["#h"]?.includes("a"));
  const b = requests.find((r) => r[2]["#h"]?.includes("b"));
  assert.exists(a);
  assert.exists(b);
  const agent = keypair();
  const activity = (tags: string[][]) =>
    signed(agent, {
      kind: 20002,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags,
    });
  const pulse = activity([["h", "b"]]);
  const snapshot = owner.session.typing.snapshot;
  for (const route of [requests[0], requests[1], a]) {
    await h.first.receive(["EVENT", route?.[1], pulse]);
    expect(snapshot()).toEqual([]);
  }
  for (const tags of [
    [],
    [["h"]],
    [["h", "bad channel"]],
    [["h", "denied"]],
    [
      ["h", "b"],
      ["h", "b"],
    ],
    [
      ["h", "b"],
      ["h", "a"],
    ],
    [
      ["h", "b"],
      ["e", "bad", "", "reply"],
    ],
  ]) {
    const event = activity(tags);
    await h.first.receive(["EVENT", b[1], event]);
    expect(snapshot()).toEqual([]);
    // Even a host that has already discarded route metadata cannot activate these.
    h.callbacks.receive([event]);
    expect(snapshot()).toEqual([]);
  }
  await h.first.receive(["EVENT", b[1], pulse]);
  expect(snapshot()).toEqual([{ channelId: "b", pubkey: agent.pubkey }]);
  // Once route metadata is gone, the session can only use the event's own scope.
  const other = activity([["h", "a"]]);
  await h.first.receive(["EVENT", b[1], other]);
  expect(snapshot()).toHaveLength(1);
  h.callbacks.receive([other]);
  expect(snapshot()).toEqual([
    { channelId: "b", pubkey: agent.pubkey },
    { channelId: "a", pubkey: agent.pubkey },
  ]);
  owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("gates publication on AUTH, shares admission with live routes, and accepts only matching OK", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    const event = message(h.key, "a", "outgoing", 1700000000);
    assert.exists(h.owner.publish);
    const done = vi.fn();
    const result = h.owner
      .publish(event, new AbortController().signal)
      .then(done, done);
    await h.first.receive(["OK", event.id, true, "early"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.first.sent).toEqual([]);
    await h.first.auth();
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toEqual([
      ["EVENT", JSON.parse(JSON.stringify(event))],
    ]);
    expect(h.first.requests()).toHaveLength(4);
    await h.first.receive(["OK", "f".repeat(64), true, "wrong"]);

    expect(done).not.toHaveBeenCalled();
    expect(h.first.requests()).toHaveLength(4);
    expect(performance.now()).toBe(100);
    await h.first.receive(["OK", event.id, true, "private-result"]);
    await result;
    expect(done).toHaveBeenCalledWith("private-result");
    expect(h.callbacks.receive).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["restricted: not a member", false],
  ["invalid: event rejected", false],
  ["error: internal server error", true],
  ["unknown failure", true],
])("preserves publication uncertainty for %s", async (reason, sent) => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    const event = message(h.key, "a", "command", 1700000000);
    assert.exists(h.owner.publish);
    const result = h.owner
      .publish(event, new AbortController().signal)
      .catch((e) => e);
    await h.first.auth();
    await h.first.receive(["OK", event.id, false, reason]);
    expect(await result).toMatchObject({ sent });
  } finally {
    h.owner.dispose();
  }
});

it.each(["abort", "dispose", "disconnect"])(
  "settles queued versus sent publications on %s without replay",
  async (action) => {
    vi.useFakeTimers();
    for (const dispatched of [false, true]) {
      const h = setup([]);
      try {
        const event = message(h.key, "a", "outgoing", 1700000000);
        const cancel = new AbortController();
        assert.exists(h.owner.publish);
        const result = h.owner.publish(event, cancel.signal).catch((e) => e);
        if (dispatched) await h.first.auth();
        if (action === "abort") cancel.abort();
        else if (action === "dispose") h.owner.dispose();
        else h.first.close();
        expect(await result).toMatchObject({ sent: dispatched });
        if (action === "disconnect") {
          await vi.advanceTimersByTimeAsync(500);
          const next = h.sockets[1];
          assert.exists(next);
          await next.auth();
          await h.first.receive(["OK", event.id, true, "late"]);
          expect(next.sent.filter((f) => f[0] === "EVENT")).toEqual([]);
        }
      } finally {
        h.owner.dispose();
      }
    }
  },
);

it("bounds pending IDs, receipts and timeout; a socket send exception remains unknown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    assert.exists(h.owner.publish);
    const event = message(h.key, "a", "outgoing", 1700000000);
    const result = h.owner
      .publish(event, new AbortController().signal)
      .catch((e) => e);
    await expect(
      h.owner.publish(event, new AbortController().signal),
    ).rejects.toMatchObject({ sent: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toMatchObject({ sent: false });
  } finally {
    h.owner.dispose();
  }
  const second = setup([]);
  try {
    assert.exists(second.owner.publish);
    await second.first.auth();
    second.first.send = () => {
      throw new Error("interrupted");
    };
    const result = second.owner
      .publish(
        message(second.key, "a", "outgoing", 1700000000),
        new AbortController().signal,
      )
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ sent: true });
  } finally {
    second.owner.dispose();
  }
});

it("publication quota pauses both writes and live REQs without replaying the refused event", async () => {
  vi.useFakeTimers();
  const h = setup(["a", "b", "c"]);
  try {
    assert.exists(h.owner.publish);
    const a = message(h.key, "a", "first", 1700000000);
    const b = message(h.key, "a", "second", 1700000001);
    const first = h.owner
      .publish(a, new AbortController().signal)
      .catch((e) => e);
    await h.first.auth();
    await h.first.receive([
      "OK",
      a.id,
      false,
      "rate-limited: quota exceeded; retry in 1s",
    ]);
    const second = h.owner
      .publish(b, new AbortController().signal)
      .catch((e) => e);
    await h.first.receive(["EOSE", h.first.requests()[0]?.[1]]);
    expect(await first).toMatchObject({ sent: false });
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toHaveLength(1);
    expect(h.first.requests()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.first.sent.filter((f) => f[0] === "EVENT")).toHaveLength(2);
    await h.first.receive(["OK", b.id, true, ""]);
    expect(await second).toBe("");
    expect(h.first.requests()).toHaveLength(5);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  ["OK", true],
  ["OK", true, "x".repeat(16385)],
  ["OK", "true", ""],
])(
  "rejects malformed/bounded receipt (%j) without acceptance",
  async (...frame) => {
    vi.useFakeTimers();
    const h = setup([]);
    try {
      assert.exists(h.owner.publish);
      const event = message(h.key, "a", "outgoing", 1700000000);
      const result = h.owner
        .publish(event, new AbortController().signal)
        .catch((e) => e);
      await h.first.auth();
      await h.first.receive([frame[0], event.id, ...frame.slice(1)]);
      expect(await result).toMatchObject({
        sent: true,
        message: "Invalid publication receipt",
      });
    } finally {
      h.owner.dispose();
    }
  },
);

it("fills three publication slots at one clock instant and refills on matching OK without a timer", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    assert.exists(h.owner.publish);
    const events = Array.from({ length: 4 }, (_, i) =>
      message(h.key, "a", `burst-${i}`, 1700000000 + i),
    );
    const publish = h.owner.publish;
    const results = events.map((event) =>
      publish(event, new AbortController().signal),
    );
    await h.first.auth();
    const writes = () => h.first.sent.filter((f) => f[0] === "EVENT");
    expect(writes()).toHaveLength(3);
    expect(performance.now()).toBe(0);
    await h.first.receive(["OK", events[0]?.id, true, ""]);
    expect(writes()).toHaveLength(4);
    expect(performance.now()).toBe(0);
    for (const event of events.slice(1))
      await h.first.receive(["OK", event.id, true, ""]);
    await Promise.all(results);
  } finally {
    h.owner.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("presence and ordinary publications correlate independently and share only real cooldown", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    assert.exists(h.owner.publish);
    assert.exists(h.owner.publishPresence);
    const presenceDone = vi.fn();
    const presence = h.owner
      .publishPresence("online", new AbortController().signal)
      .then(presenceDone);
    await vi.advanceTimersByTimeAsync(0);
    const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
      id: string;
    };
    assert.exists(event);
    const chat = message(h.key, "a", "ordinary", 1700000000);
    const ordinaryDone = vi.fn();
    const ordinary = h.owner
      .publish(chat, new AbortController().signal)
      .then(ordinaryDone);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.first.sent.filter(([kind]) => kind === "EVENT")).toHaveLength(2);
    expect(performance.now()).toBe(0);
    await h.first.receive(["OK", event.id, true, ""]);
    await presence;
    expect(presenceDone).toHaveBeenCalledWith(true);
    expect(ordinaryDone).not.toHaveBeenCalled();
    await h.first.receive(["OK", chat.id, true, "chat accepted"]);
    await ordinary;
    expect(ordinaryDone).toHaveBeenCalledWith("chat accepted");
    await vi.advanceTimersByTimeAsync(5000);
    const refused = message(h.key, "a", "refused", 1700000001);
    const result = h.owner
      .publish(refused, new AbortController().signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    await h.first.receive([
      "OK",
      refused.id,
      false,
      "rate-limited: quota exceeded; retry in 1s",
    ]);
    expect(await result).toMatchObject({ sent: false });
    expect(
      await h.owner.publishPresence("away", new AbortController().signal),
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    const renewal = h.owner.publishPresence(
      "away",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    const last = h.first.sent
      .filter(([kind]) => kind === "EVENT")
      .at(-1)?.[1] as { id: string; content: string };
    expect(last.content).toBe("away");
    await h.first.receive(["OK", last.id, true, ""]);
    expect(await renewal).toBe(true);
    expect(h.sockets).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it("publishes manual Offline on the authenticated presence socket with a correlated receipt", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    const result = h.owner.publishPresence?.(
      "offline",
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    const event = h.first.sent.find(([kind]) => kind === "EVENT")?.[1] as {
      id: string;
      kind: number;
      content: string;
      tags: string[][];
    };
    assert.exists(event);
    expect(event).toMatchObject({ kind: 20001, content: "offline", tags: [] });
    await h.first.receive(["OK", event.id, true]);
    expect(await result).toBe(true);
  } finally {
    h.owner.dispose();
  }
});

it("receives public agent metadata on the existing profile route without another subscription", async () => {
  vi.useFakeTimers();
  const h = setup([]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    const route = h.first
      .requests()
      .find((request) => request[2].kinds.includes(10100));
    assert.exists(route);
    expect(route[2].kinds).toEqual([0, 10100, 30177]);
    expect(h.first.requests()).toHaveLength(2);
    await h.first.receive(["EOSE", route[1]]);
    for (const kind of [10100, 30177]) {
      const event = signed(h.key, {
        kind,
        content: "{}",
        tags: [],
        created_at: 10,
      });
      await h.first.receive(["EVENT", route[1], event]);
      expect(h.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase: "live",
      });
    }
  } finally {
    h.owner.dispose();
  }
});

it("logs every real transport frame without payloads and applies level changes to an open socket", async () => {
  vi.useFakeTimers();
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([{ log: (value) => lines.push(value.args.join(" ")) }]);
  setLogLevel("debug");
  const h = setup(["a"]);
  try {
    await h.first.auth();
    await vi.advanceTimersByTimeAsync(750);
    expect(lines.some((line) => line.includes("← AUTH"))).toBe(true);
    expect(lines.some((line) => line.includes("→ AUTH"))).toBe(true);
    expect(lines.some((line) => line.includes("→ REQ"))).toBe(true);
    const request = h.first.requests().find((r) => r[2]["#h"]?.[0] === "a");
    assert.exists(request);
    const incoming = message(keypair(), "a", "secret message", 1700000000);
    lines.length = 0;
    for (let i = 0; i < 20; i++)
      await h.first.receive(["EVENT", request[1], incoming]);
    expect(lines).toHaveLength(20);
    expect(
      lines.every(
        (line) => line.includes("← EVENT") && line.includes("kind=9"),
      ),
    ).toBe(true);
    expect(lines.join(" ")).not.toContain("secret message");
    expect(h.callbacks.receive).toHaveBeenCalledTimes(20);
    setLogLevel("info");
    await h.first.receive(["EVENT", request[1], incoming]);
    expect(lines).toHaveLength(20);
    expect(h.callbacks.receive).toHaveBeenCalledTimes(21);
  } finally {
    h.owner.dispose();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});

it("logs authentication failure and retry reasons at Info without server payloads", async () => {
  vi.useFakeTimers();
  const logger = getLogger("relay-ws");
  const reporters = [...logger.options.reporters];
  const lines: string[] = [];
  logger.setReporters([
    { log: (value) => lines.push(`${value.type} ${value.args.join(" ")}`) },
  ]);
  setLogLevel("info");
  const rejected = setup([]);
  let timedOut: ReturnType<typeof setup> | undefined;
  try {
    await rejected.first.receive(["AUTH", "private challenge"]);
    const auth = rejected.first.sent.find(
      (frame) => frame[0] === "AUTH",
    )?.[1] as { id: string };
    await rejected.first.receive(["OK", auth.id, false, "private rejection"]);
    expect(
      lines.filter((line) =>
        line.includes("Relay rejected live authentication"),
      ),
    ).toEqual(["error relay.test Relay rejected live authentication"]);
    timedOut = setup([]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(
      lines.filter((line) => line.includes("Live authentication timed out")),
    ).toEqual(["warn relay.test Live authentication timed out"]);
    expect(lines.join(" ")).not.toContain("private");
  } finally {
    rejected.owner.dispose();
    timedOut?.owner.dispose();
    logger.setReporters(reporters);
    setLogLevel("info");
  }
});
it("plugin row kinds re-issue established channel routes as fresh routes and reject host kinds", async () => {
  vi.useFakeTimers();
  const h = setup(["a"]);
  await h.first.auth();
  await vi.advanceTimersByTimeAsync(750);
  const [, wire] = required(h.first.requests().find((r) => r[2]["#h"]));
  const event = message(h.key, "a", "echo", 1);
  for (let i = 0; i < 500; i++) await h.first.receive(["EVENT", wire, event]);
  await h.first.receive(["EOSE", wire]);
  const replay = () =>
    h.callbacks.state.mock.lastCall?.[0].routes.find((r) => r.channelId === "a")
      ?.replay;
  expect(replay()).toBe("limited");
  const before = h.first.requests().length;
  vi.setSystemTime(Date.now() + 3_600_000);
  h.owner.kinds?.([40006, 40006]);
  expect(h.first.sent).toContainEqual(["CLOSE", wire]);
  const reissued = h.first.requests().slice(before);
  expect(reissued).toHaveLength(1);
  expect(reissued[0]?.[2]).toMatchObject({
    kinds: expect.arrayContaining([9, 40006]),
    "#h": ["a"],
    since: Math.floor(Date.now() / 1000) - 300,
  });
  expect(reissued[0]?.[1]).not.toBe(wire);
  await h.first.receive(["EOSE", required(reissued[0])[1]]);
  expect(replay()).toBe("unknown");
  const sent = h.first.sent.length;
  h.owner.kinds?.([40006]);
  expect(h.first.sent).toHaveLength(sent);
  expect(() => h.owner.kinds?.([7])).toThrow();
  h.owner.dispose();
});
function required<T>(value: T | undefined): T {
  assert.exists(value);
  return value;
}
