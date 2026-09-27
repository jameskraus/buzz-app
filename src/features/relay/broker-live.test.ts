// Regression controls contributed by Brain; see WS_RETRY_REVIEW_2026_09_09.
import { assert, afterEach, expect, it, vi } from "vitest";
import { keypair, message } from "./testing";
import { connectBrokerTransport } from "./transport";
function required<T>(value: T | undefined): T {
  assert.exists(value);
  return value;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const headers: ReturnType<typeof deferred<Response>>[] = [];
  const controls: ReturnType<typeof deferred<Response>>[] = [];
  const interests: ReturnType<typeof deferred<Response>>[] = [];
  const signals: AbortSignal[] = [];
  const snapshots: unknown[] = [];
  const bodyControllers: ReadableStreamDefaultController[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith("/session"))
        return Promise.resolve(
          Response.json({
            viewer: "a".repeat(64),
            relayAuthor: "b".repeat(64),
            live: true,
          }),
        );
      if (url.endsWith("/stream-interests")) {
        const d = deferred<Response>();
        interests.push(d);
        return d.promise;
      }
      if (
        url.endsWith("/stream-retry") ||
        url.endsWith("/stream-observer") ||
        url.endsWith("/stream-presence")
      ) {
        const d = deferred<Response>();
        controls.push(d);
        signals.push(init.signal as AbortSignal);
        return d.promise;
      }
      if (url.endsWith("/stream")) {
        const d = deferred<Response>();
        headers.push(d);
        return d.promise;
      }
      throw Error(`unexpected fetch ${url}`);
    }),
  );
  function accept(index: number) {
    const body = new ReadableStream({
      start(c) {
        bodyControllers[index] = c;
      },
    });
    required(headers[index]).resolve(
      new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "X-Buzz-Live-ID": String(index + 1).padStart(32, "0"),
        },
      }),
    );
  }
  function publish(
    index: number,
    snapshot: unknown = { status: "connected", routes: [] },
  ) {
    required(bodyControllers[index]).enqueue(
      new TextEncoder().encode(
        `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`,
      ),
    );
  }
  return {
    headers,
    controls,
    interests,
    disconnect(index: number) {
      required(bodyControllers[index]).error(new Error("fixture disconnect"));
    },
    signals,
    snapshots,
    accept,
    publish,
    frame(kind: string, value: unknown) {
      required(bodyControllers[0]).enqueue(
        new TextEncoder().encode(
          `event: ${kind}\ndata: ${JSON.stringify(value)}\n\n`,
        ),
      );
    },
    callbacks: {
      state(s: unknown) {
        snapshots.push(s);
      },
      receive: vi.fn(),
      established() {},
      denied() {},
    },
  };
}
it("rejects status snapshots beyond channel interests plus both globals and observer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0, {
      status: "connected",
      routes: Array.from({ length: 1028 }, (_, i) => ({
        id: `route-${i}`,
        status: "pending",
        replay: "unknown",
      })),
    });
    await tick();
    expect(f.snapshots.at(-1)).toEqual({
      status: "retrying",
      routes: [],
      error: "Invalid live broker status",
    });
  } finally {
    owner.dispose();
  }
});

it("pre-header clicks preserve in-progress POST; duplicate controls coalesce", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.retry();
    owner.retry();
    await tick();
    expect(f.headers).toHaveLength(1);
    expect(f.controls).toHaveLength(0);
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    owner.retry();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(1);
    expect(f.headers).toHaveLength(1);
    required(f.controls[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    owner.retry();
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(f.headers).toHaveLength(1);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});
for (const finish of ["replacement", "dispose"] as const)
  for (const outcome of ["status", "reject"] as const)
    it(`late retry ${outcome} cannot update ${finish}`, async () => {
      vi.useFakeTimers();
      const f = fixture();
      const t = await connectBrokerTransport();
      const owner = required(t.subscribe)(f.callbacks);
      try {
        f.accept(0);
        await tick();
        f.publish(0);
        await tick();
        owner.retry();
        await tick();
        expect(f.controls).toHaveLength(1);
        if (finish === "replacement") {
          f.disconnect(0);
          await vi.advanceTimersByTimeAsync(500);
          f.accept(1);
          await tick();
          f.publish(1);
          await tick();
        } else owner.dispose();
        expect(required(f.signals[0]).aborted).toBe(true);
        const before = f.snapshots.length;
        // Deliberately uncooperative completion despite abort, proving callback fence.
        if (outcome === "status")
          required(f.controls[0]).resolve(new Response(null, { status: 500 }));
        else
          required(f.controls[0]).reject(
            new Error("deliberately late network rejection"),
          );
        await tick();
        expect(f.snapshots).toHaveLength(before);
        expect(f.headers).toHaveLength(finish === "replacement" ? 2 : 1);
      } finally {
        owner.dispose();
      }
    });

it("late observer 404 from a retired stream cannot interrupt its replacement", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    required(owner.observe)(1);
    await tick();
    expect(f.controls).toHaveLength(1);
    f.disconnect(0);
    await vi.advanceTimersByTimeAsync(500);
    f.accept(1);
    await tick();
    f.publish(1);
    await tick();
    expect(required(f.signals[0]).aborted).toBe(true);
    const before = f.snapshots.length;
    required(f.controls[0]).resolve(new Response(null, { status: 404 }));
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.snapshots).toHaveLength(before);
    expect(f.headers).toHaveLength(2);
    required(owner.observe)(2);
    await tick();
    expect(f.controls).toHaveLength(2);
    expect(required(f.signals[1]).aborted).toBe(false);
    required(f.controls[1]).resolve(new Response(null, { status: 200 }));
    await tick();
  } finally {
    owner.dispose();
  }
});

it("preserves validated replay/live provenance through production broker transport; legacy traffic stays unknown", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    owner.update(["a"]);
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    const event = message(keypair(), "a", "incoming", 1700000000);
    f.frame("message", event);
    await tick();
    expect(f.callbacks.receive).toHaveBeenLastCalledWith([event]);
    for (const phase of ["replay", "live"]) {
      f.frame("traffic", { event, provenance: { phase, channelId: "a" } });
      await tick();
      expect(f.callbacks.receive).toHaveBeenLastCalledWith([event], {
        phase,
        channelId: "a",
      });
    }
    expect(f.callbacks.receive).toHaveBeenCalledTimes(3);
  } finally {
    owner.dispose();
  }
});
it.each([undefined, { phase: "fresh" }, { phase: "live", channelId: ["a"] }])(
  "rejects malformed traffic provenance instead of calling it fresh: %j",
  async (provenance) => {
    vi.useFakeTimers();
    const f = fixture();
    const t = await connectBrokerTransport();
    const owner = required(t.subscribe)(f.callbacks);
    try {
      f.accept(0);
      await tick();
      f.frame("traffic", {
        event: message(keypair(), "a", "incoming", 1700000000),
        provenance,
      });
      await tick();
      expect(f.callbacks.receive).not.toHaveBeenCalled();
      expect(f.snapshots.at(-1)).toMatchObject({ status: "retrying" });
    } finally {
      owner.dispose();
    }
  },
);

it("in-place interests fence removed/readded channel frames but retain unchanged-channel traffic", async () => {
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.update(["a", "b"]);
    f.accept(0);
    await tick();
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    owner.update(["b"]);
    owner.update(["a", "b"]);
    const event = message(keypair(), "a", "stale", 1700000000);
    f.frame("traffic", {
      event,
      provenance: { phase: "live", channelId: "a" },
      interestRevision: 1,
    });
    f.frame("traffic", {
      event: message(keypair(), "b", "unchanged", 1700000000),
      provenance: { phase: "live", channelId: "b" },
      interestRevision: 1,
    });
    await tick();
    expect(f.callbacks.receive).toHaveBeenCalledTimes(1);
    expect(f.callbacks.receive.mock.lastCall?.[1]).toEqual({
      phase: "live",
      channelId: "b",
    });
    required(f.interests[1]).resolve(new Response(null, { status: 200 }));
    await tick();
    expect(f.interests).toHaveLength(3);
    required(f.interests[2]).resolve(new Response(null, { status: 200 }));
    await tick();
    f.frame("traffic", {
      event,
      provenance: { phase: "live", channelId: "a" },
      interestRevision: 3,
    });
    await tick();
    expect(f.callbacks.receive).toHaveBeenCalledTimes(2);
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});

it("coalesced remove/re-add with the same final IDs still advances host interest revision", async () => {
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    owner.update(["a"]);
    f.accept(0);
    await tick();
    owner.update([]);
    owner.update(["a"]);
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    expect(f.interests).toHaveLength(2);
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/stream-interests"));
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({
      channels: ["a"],
      removed: ["a"],
      interestRevision: 3,
    });
    required(f.interests[1]).resolve(new Response(null, { status: 200 }));
    await tick();
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});

it("preserves locally-unsent presence separately from refusal and unknown responses", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    expect(
      await owner.publishPresence?.("online", new AbortController().signal),
    ).toBeNull();
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    for (const accepted of [null, false, true, undefined, "null"]) {
      const result = owner.publishPresence?.(
        "online",
        new AbortController().signal,
      );
      required(f.controls.at(-1)).resolve(Response.json({ accepted }));
      expect(await result).toBe(accepted === null ? null : accepted === true);
    }
  } finally {
    owner.dispose();
  }
});

it("in-place channel interests preserve an outstanding presence publication", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  try {
    f.accept(0);
    await tick();
    f.publish(0);
    await tick();
    const identity = owner.identity?.();
    const result = required(owner.publishPresence)(
      "online",
      new AbortController().signal,
    );
    owner.update(["a"]);
    expect(owner.identity?.()).toBe(identity);
    expect(required(f.signals[0]).aborted).toBe(false);
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    required(f.controls[0]).resolve(Response.json({ accepted: true }));
    expect(await result).toBe(true);
    expect(f.headers).toHaveLength(1);
  } finally {
    owner.dispose();
  }
});
it("carries plugin row kinds as in-place interest revisions", async () => {
  const f = fixture();
  const t = await connectBrokerTransport();
  const owner = required(t.subscribe)(f.callbacks);
  const body = (suffix: string) =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith(suffix))
      .map(([, init]) => JSON.parse(String(init?.body)));
  try {
    owner.update(["a"]);
    owner.kinds?.([40006]);
    f.accept(0);
    await tick();
    expect(body("/stream-interests")[0]).toMatchObject({
      channels: ["a"],
      kinds: [40006],
    });
    required(f.interests[0]).resolve(new Response(null, { status: 200 }));
    await tick();
    owner.kinds?.([]);
    await tick();
    expect(body("/stream-interests").at(-1)).toMatchObject({
      channels: ["a"],
      kinds: [],
    });
    expect(() => owner.kinds?.([9])).toThrow();
  } finally {
    owner.dispose();
  }
});
