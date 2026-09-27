import { assert, expect, it, vi } from "vitest";
import { createChannelActivity } from "./channel-activity";
import { CHANNEL_ACTIVITY_KINDS } from "./kinds";
import { flush, keypair, message, signed } from "./testing";

const forumActivity = (
  key: ReturnType<typeof keypair>,
  channelId: string,
  kind: 45001 | 45003,
  created_at: number,
) =>
  signed(key, { kind, created_at, content: "forum", tags: [["h", channelId]] });

function deferredReader() {
  const pending: {
    ids: readonly string[];
    signal: AbortSignal;
    resolve(events: readonly import("./events").RelayEvent[]): void;
    reject(error: unknown): void;
  }[] = [];
  return {
    pending,
    read(ids: readonly string[], signal: AbortSignal) {
      return new Promise<readonly import("./events").RelayEvent[]>(
        (resolve, reject) => pending.push({ ids, signal, resolve, reject }),
      );
    },
  };
}

it("reads authoritative activity in 128-channel batches across message and forum kinds", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const changed = vi.fn();
  const activity = createChannelActivity(wire.read);
  activity.subscribe(changed);
  const ids = Array.from({ length: 257 }, (_, index) => `room-${index}`);
  const refresh = activity.refresh(ids);
  await flush();
  for (const [index, size] of [128, 128, 1].entries()) {
    const request = take(wire.pending);
    expect(request.ids).toEqual(ids.slice(index * 128, index * 128 + size));
    expect(CHANNEL_ACTIVITY_KINDS).toEqual([9, 40002, 40008, 45001, 45003]);
    const channelId = ids[index * 128];
    assert.exists(channelId);
    request.resolve([forumActivity(peer, channelId, 45003, 100 + index)]);
    await flush();
  }
  await refresh;
  expect(activity.last(ids[0] ?? "")).toBe(100);
  expect(activity.last(ids[128] ?? "")).toBe(101);
  expect(activity.last(ids[256] ?? "")).toBe(102);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(activity.status()).toBe("ready");
});

it("keeps the last good projection on failure and never rolls back newer live activity", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read, vi.fn());
  activity.accept([message(peer, "alpha", "seed", 50)]);

  const failed = activity.refresh(["alpha"]);
  await flush();
  take(wire.pending).reject(new Error("offline"));
  await expect(failed).rejects.toThrow("offline");
  expect(activity.last("alpha")).toBe(50);

  const refresh = activity.refresh(["alpha", "quiet"]);
  await flush();
  activity.accept([message(peer, "alpha", "live", 90)]);
  take(wire.pending).resolve([message(peer, "alpha", "stale query", 60)]);
  await refresh;
  expect(activity.last("alpha")).toBe(90);
  expect(activity.last("quiet")).toBeUndefined();
});

it("authoritative absence clears unchanged recency but cache clear rejects late settlement", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read, vi.fn());
  activity.accept([forumActivity(peer, "forum", 45001, 70)]);
  const absent = activity.refresh(["forum"]);
  await flush();
  take(wire.pending).resolve([]);
  await absent;
  expect(activity.last("forum")).toBeUndefined();

  activity.accept([message(peer, "forum", "again", 80)]);
  const stale = activity.refresh(["forum"]);
  await flush();
  activity.clear();
  take(wire.pending).resolve([message(peer, "forum", "late", 100)]);
  await stale;
  expect(activity.last("forum")).toBeUndefined();
});

it("retires an older roster refresh before it can erase newer results", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read);
  const older = activity.refresh(["old"]);
  const first = take(wire.pending);
  const newer = activity.refresh(["new"]);
  const second = take(wire.pending);
  second.resolve([message(peer, "new", "new roster", 90)]);
  await newer;
  first.resolve([message(peer, "old", "stale roster", 100)]);
  await older;
  expect(activity.last("new")).toBe(90);
  expect(activity.last("old")).toBeUndefined();
  expect(first.signal.aborted).toBe(true);
  activity.dispose();
});

it("cache clear aborts active batches and disposal ignores late live input", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read);
  const pending = activity.refresh(["alpha"]);
  const first = take(wire.pending);
  activity.clear();
  first.resolve([message(peer, "alpha", "late", 90)]);
  await pending;
  expect(first.signal.aborted).toBe(true);
  expect(activity.last("alpha")).toBeUndefined();
  activity.dispose();
  activity.accept([message(peer, "alpha", "retired", 100)]);
  expect(activity.last("alpha")).toBeUndefined();
});

it("a later batch failure cannot partially replace the last good projection", async () => {
  const peer = keypair();
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read);
  activity.accept([message(peer, "room-0", "seed", 50)]);
  const ids = Array.from({ length: 129 }, (_, i) => `room-${i}`);
  const pending = activity.refresh(ids);
  const failed = expect(pending).rejects.toThrow("offline");
  take(wire.pending).resolve([message(peer, "room-0", "partial", 90)]);
  await flush();
  take(wire.pending).reject(new Error("offline"));
  await failed;
  expect(activity.last("room-0")).toBe(50);
  activity.dispose();
});

function take<T>(pending: T[]): T {
  const next = pending.shift();
  assert.exists(next, "Expected a pending operation");
  return next;
}

it("ignores unsupported kinds, ambiguous scopes and out-of-batch activity", async () => {
  const peer = keypair();
  const valid = message(peer, "alpha", "visible", 40);
  const ambiguous = signed(peer, {
    kind: 9,
    created_at: 100,
    content: "ambiguous",
    tags: [
      ["h", "alpha"],
      ["h", "beta"],
    ],
  });
  const unsupported = signed(peer, {
    kind: 7,
    created_at: 200,
    content: "reaction",
    tags: [["h", "alpha"]],
  });
  const other = message(peer, "beta", "unrequested", 300);
  const owner = createChannelActivity(async () => [
    valid,
    ambiguous,
    unsupported,
    other,
  ]);
  await owner.refresh(["alpha"]);
  expect(owner.last("alpha")).toBe(40);
  expect(owner.last("beta")).toBeUndefined();
  owner.accept([ambiguous, unsupported]);
  expect(owner.last("alpha")).toBe(40);
  owner.dispose();
});

it("publishes settled readiness even for empty activity and failure without changing values", async () => {
  const wire = deferredReader();
  const activity = createChannelActivity(wire.read);
  expect(activity.status()).toBe("idle");
  const empty = activity.refresh(["quiet"]);
  expect(activity.status()).toBe("loading");
  take(wire.pending).resolve([]);
  await empty;
  expect(activity.status()).toBe("ready");
  const failure = activity.refresh(["quiet"]);
  const rejected = expect(failure).rejects.toThrow("offline");
  take(wire.pending).reject(new Error("offline"));
  await rejected;
  expect(activity.status()).toBe("error");
  activity.clear();
  expect(activity.status()).toBe("idle");
  activity.dispose();
});

it("includes diff messages in both historical and live recency", async () => {
  const peer = keypair();
  const diff = (created_at: number) =>
    signed(peer, {
      kind: 40008,
      created_at,
      content: "diff --git a/file b/file",
      tags: [["h", "alpha"]],
    });
  const activity = createChannelActivity(async () => [diff(50)]);
  await activity.refresh(["alpha"]);
  expect(activity.last("alpha")).toBe(50);
  activity.accept([diff(90)]);
  expect(activity.last("alpha")).toBe(90);
  activity.dispose();
});
