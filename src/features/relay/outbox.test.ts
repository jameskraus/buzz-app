import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { registerPluginRowKind } from "./kinds";
import {
  PublishRejected,
  createOutbox,
  type OutboxStorage,
  type OutgoingEvent,
} from "./outbox";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import {
  bounds,
  flush,
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
const viewer = keypair(),
  relay = keypair();
function memoryStorage(): OutboxStorage {
  let records: readonly OutgoingEvent[] = [];
  return {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
    },
  };
}
const owners: ReturnType<typeof createRelaySession>[] = [];
function setup(storage = memoryStorage(), timeoutMs = 10000) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const query = vi.spyOn(wire.transport, "query");
  const signatures: {
    event: EventTemplate;
    resolve(event: RelayEvent): void;
  }[] = [];
  const publications: {
    event: RelayEvent;
    resolve(): void;
    reject(error: unknown): void;
  }[] = [];
  const sign = vi.fn(
    (event: EventTemplate) =>
      new Promise<RelayEvent>((resolve) => signatures.push({ event, resolve })),
  );
  const publish = vi.fn(
    (event: RelayEvent) =>
      new Promise<void>((resolve, reject) =>
        publications.push({ event, resolve, reject }),
      ),
  );
  const owner = createRelaySession(
    { ...wire.transport, writer: { sign, publish } },
    { outboxStorage: storage, deliveryTimeoutMs: timeoutMs },
  );
  owners.push(owner);
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const send = (content = "hello") =>
    outbox.send({ kind: 9, content, tags: [["h", "c"]] });
  async function open() {
    owner.session.channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "c", [viewer.pubkey]),
        metadata(relay, "c", "General"),
      ]);
    await flush();
    owner.session.channels.ensure("c");
    wire
      .next()
      .respond([
        bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
      ]);
    await flush();
    // Resolve the author directory once so tests control only history and delivery reads.
    const names = owner.session.profiles.ensure([viewer.pubkey]);
    wire.next().respond([
      signed(viewer, {
        kind: 0,
        content: JSON.stringify({ name: "You" }),
        tags: [],
      }),
    ]);
    await names;
  }
  async function signNext() {
    await flush();
    const request = signatures.shift();
    assert.exists(request);
    const event = signed(viewer, request.event);
    request.resolve(event);
    await flush();
    return event;
  }
  return {
    ...wire,
    query,
    ...owner,
    outbox,
    send,
    open,
    signNext,
    sign,
    publish,
    publications,
    signatures,
  };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
it("renders one local event immediately across channel, sidebar, and filtered plugin views; stale reads cannot remove it", async () => {
  const h = setup();
  await h.open();
  const view = h.session.observe([{ kinds: [9], "#h": ["c"], limit: 80 }]);
  const render = vi.fn();
  view.subscribe(render);
  const refreshing = view.refresh();
  const stale = h.next();
  const id = h.send();
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id, content: "hello", delivery: "sending" },
  ]);
  expect(h.session.channels.list().channels[0]?.preview).toBe("hello");
  expect(view.snapshot().events).toMatchObject([{ id, delivery: "sending" }]);
  expect(render).toHaveBeenCalled();
  const event = await h.signNext();
  const publication = h.publications.shift();
  assert.exists(publication);
  publication.resolve();
  await flush();
  expect(h.outbox.snapshot()[0]?.delivery).toBe("accepted");
  stale.respond([]);
  await refreshing;
  expect(view.snapshot().events).toHaveLength(1);
  h.next().respond([event]);
  await flush(); // Internal sent-vs-seen confirmation.
  expect(h.outbox.snapshot()).toHaveLength(0);
  const latest = view.refresh();
  h.next().respond([event]);
  await latest;
  expect(view.snapshot().events).toHaveLength(1);
  assert.exists(h.session.channels.refresh);
  h.session.channels.refresh("c");
  h.next().respond([
    bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id, delivery: "seen" },
  ]);
  expect(h.session.channels.window("c").rows).toHaveLength(1);
});
it("a relay echo before publish ACK wins over a late failure and never duplicates the row", async () => {
  const h = setup();
  await h.open();
  const id = h.send();
  const event = await h.signNext();
  const view = h.session.observe([{ ids: [id], limit: 1 }]);
  const refresh = view.refresh();
  h.next().respond([event]);
  await refresh;
  const publication = h.publications.shift();
  assert.exists(publication);
  publication.reject(new Error("lost acknowledgment"));
  await flush();
  expect(h.outbox.snapshot()).toHaveLength(0);
  expect(h.session.channels.window("c").rows).toMatchObject([
    { id, delivery: "seen" },
  ]);
});
it("failed sends remain retryable, and retry republishes exactly the same signed event", async () => {
  const h = setup();
  await h.open();
  const id = h.send();
  const event = await h.signNext();
  const rejectedPublication = h.publications.shift();
  assert.exists(rejectedPublication);
  rejectedPublication.reject(new PublishRejected("Not allowed"));
  await flush();
  expect(h.session.channels.window("c").rows[0]).toMatchObject({
    delivery: "failed",
    deliveryError: "Not allowed",
  });
  h.outbox.retry(id);
  h.outbox.retry(id);
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(h.publications).toHaveLength(1);
  expect(h.publications[0]?.event).toEqual(event);
  const publication = h.publications.shift();
  assert.exists(publication);
  publication.resolve();
  await flush();
  h.next().respond([event]);
  await flush();
  expect(h.outbox.snapshot()).toHaveLength(0);
});
it("persists before publish, restores uncertain writes without auto-sending, and retries using the same event ID", async () => {
  const storage = memoryStorage();
  const first = setup(storage);
  const id = first.send();
  const event = await first.signNext();
  expect((await storage.load())[0]?.signed?.id).toBe(id);
  first.dispose();
  const second = setup(storage);
  expect(second.outbox.snapshot()[0]).toMatchObject({
    delivery: "unknown",
    event: { id },
  });
  expect(second.publish).not.toHaveBeenCalled();
  second.outbox.retry(id);
  await flush();
  expect(second.sign).not.toHaveBeenCalled();
  expect(second.publications[0]?.event.id).toBe(event.id);
});
it("never publishes when durable storage fails and reports that failure on the shared event", async () => {
  const h = setup({
    load: () => [],
    save: () => {
      throw new Error("disk full");
    },
  });
  const id = h.send();
  await flush();
  expect(h.outbox.snapshot()[0]).toMatchObject({
    event: { id },
    delivery: "failed",
    error: "disk full",
  });
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.sign).not.toHaveBeenCalled();
});
it("two identical sends in the same second are separate events", () => {
  const h = setup();
  const one = h.send(),
    two = h.send();
  expect(one).not.toBe(two);
  expect(h.outbox.snapshot()).toHaveLength(2);
});
it("read-only sessions have no outbox capability", () => {
  const h = createRelaySession(null);
  owners.push(h);
  expect(h.session.outbox).toBeUndefined();
});

it("times out a non-cooperating publisher as unknown, then reconciles a relay observation", async () => {
  vi.useFakeTimers();
  const h = setup(memoryStorage(), 100);
  const id = h.send();
  await vi.advanceTimersByTimeAsync(0);
  const signature = h.signatures.shift();
  assert.exists(signature);
  const event = signed(viewer, signature.event);
  signature.resolve(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.publish).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(101);
  expect(h.outbox.snapshot()[0]?.delivery).toBe("unknown");
  // A publish timeout may still have committed the event remotely.
  const confirmation = h.pending.find((item) =>
    item.filters[0]?.ids?.includes(id),
  );
  assert.exists(confirmation);
  const names = h.pending.find((item) => item.filters[0]?.kinds?.includes(0));
  assert.exists(names); // Local-send enrichment is still held, not released for the test.
  expect(names.signal?.aborted).toBe(false);
  expect(
    h.query.mock.calls.find(([filters]) => filters[0]?.ids?.includes(id))?.[3],
  ).toBe("foreground");
  confirmation.respond([event]);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.outbox.snapshot()).toHaveLength(0);
  h.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("confirms an accepted send ahead of held author enrichment, but retries in background", async () => {
  vi.useFakeTimers();
  const h = setup();
  const id = h.send();
  await vi.advanceTimersByTimeAsync(0);
  const signature = h.signatures.shift();
  assert.exists(signature);
  const event = signed(viewer, signature.event);
  signature.resolve(event);
  await vi.advanceTimersByTimeAsync(0);
  const names = h.next();
  expect(names.filters[0]?.kinds).toEqual([0]);
  const publication = h.publications.shift();
  assert.exists(publication);
  publication.resolve();
  await vi.advanceTimersByTimeAsync(0);
  const first = h.next();
  expect(first.filters).toEqual([{ ids: [id], limit: 1 }]);
  expect(h.query.mock.calls.at(-1)?.[3]).toBe("foreground");
  expect(names.signal?.aborted).toBe(false);
  first.respond([]);
  await vi.advanceTimersByTimeAsync(501);
  expect(h.pending).toHaveLength(0); // Retry yields to the still-held background name read.
  names.respond([]);
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of [1500, 4000, 10000, null]) {
    const retry = h.next();
    expect(retry.filters).toEqual([{ ids: [id], limit: 1 }]);
    expect(h.query.mock.calls.at(-1)?.[3]).toBe("background");
    retry.respond([]);
    await vi.advanceTimersByTimeAsync(delay ?? 20000);
  }
  expect(h.pending).toHaveLength(0);
  expect(
    h.query.mock.calls.filter(([filters]) => filters[0]?.ids?.includes(id)),
  ).toHaveLength(5);
  expect(h.outbox.snapshot()[0]?.delivery).toBe("accepted");
  expect(h.publish).toHaveBeenCalledTimes(1);
});
it("optimistic edits fold against retained message events and a rejected edit rolls back", async () => {
  const h = setup();
  await h.open();
  const original = signed(viewer, {
    kind: 9,
    tags: [["h", "c"]],
    content: "Original",
  });
  assert.exists(h.session.channels.refresh);
  h.session.channels.refresh("c");
  h.next().respond([
    original,
    bounds(relay, "c", "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  h.outbox.send({
    kind: 40003,
    content: "Edited",
    tags: [
      ["h", "c"],
      ["e", original.id],
    ],
  });
  expect(h.session.channels.window("c").rows[0]?.content).toBe("Edited");
  await h.signNext();
  const publication = h.publications.shift();
  assert.exists(publication);
  publication.reject(new PublishRejected("Edit rejected"));
  await flush();
  expect(h.session.channels.window("c").rows[0]?.content).toBe("Original");
});
it("optimistic profile edits reach the shared profile directory without a channel", () => {
  const h = setup();
  h.outbox.send({
    kind: 0,
    content: JSON.stringify({ name: "Local name" }),
    tags: [],
  });
  expect(h.session.profiles.snapshot().get(viewer.pubkey)?.name).toBe(
    "Local name",
  );
});

it("releases delivery slots on verified echoes even when publishers never acknowledge", async () => {
  const h = setup();
  const ids = Array.from({ length: 4 }, (_, i) => h.send(`queued ${i}`));
  const events = [await h.signNext(), await h.signNext(), await h.signNext()];
  expect(h.publish).toHaveBeenCalledTimes(3);
  expect(h.sign).toHaveBeenCalledTimes(3);
  const view = h.session.observe([{ ids: ids.slice(0, 3), limit: 3 }]);
  const refresh = view.refresh();
  const firstId = ids[0];
  assert.exists(firstId);
  const pending = h.pending.find((request) =>
    request.filters[0]?.ids?.includes(firstId),
  );
  assert.exists(pending);
  pending.respond(events);
  await refresh;
  await flush();
  // No ACK or timeout: verified delivery itself must release the queue.
  expect(h.sign).toHaveBeenCalledTimes(4);
  expect(h.outbox.snapshot().map((item) => item.event.id)).toEqual([ids[3]]);
});

it("never commits a pre-hydration snapshot after a first send times out", async () => {
  vi.useFakeTimers();
  let hydrate!: (records: readonly OutgoingEvent[]) => void;
  const saves: (readonly OutgoingEvent[])[] = [];
  const restored = signed(viewer, {
    kind: 9,
    content: "older pending",
    tags: [["h", "c"]],
  });
  const h = setup(
    {
      load: () =>
        new Promise((resolve) => {
          hydrate = resolve;
        }),
      save: (records) => {
        saves.push(records);
      },
    },
    100,
  );
  h.send();
  await vi.advanceTimersByTimeAsync(101);
  expect(h.outbox.snapshot()[0]?.delivery).toBe("failed");
  hydrate([{ event: restored, signed: restored, delivery: "unknown" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(saves.length).toBeGreaterThan(0);
  expect(
    saves.every((records) =>
      records.some((item) => item.event.id === restored.id),
    ),
  ).toBe(true);
  expect(h.sign).not.toHaveBeenCalled();
});

it("bounds sending time from enqueue, including when all delivery slots are occupied", async () => {
  vi.useFakeTimers();
  const h = setup(memoryStorage(), 100);
  for (let index = 0; index < 3; index++) h.send(`blocking ${index}`);
  await vi.advanceTimersByTimeAsync(50);
  const queued = h.send("waiting for a slot");
  await vi.advanceTimersByTimeAsync(101);
  expect(
    h.outbox.snapshot().find((item) => item.event.id === queued)?.delivery,
  ).toBe("failed");
  expect(h.outbox.snapshot().some((item) => item.delivery === "sending")).toBe(
    false,
  );
  expect(h.publish).not.toHaveBeenCalled();
});

it("confirms only matching pending IDs from a mixed, reordered observation batch", async () => {
  const viewer = keypair();
  const event = (content: string) =>
    signed(viewer, { kind: 9, tags: [["h", "c"]], content });
  const [first, second, pending, unrelated] = [
    event("first"),
    event("second"),
    event("pending"),
    event("unrelated"),
  ];
  if (!first || !second || !pending || !unrelated)
    throw new Error("missing review fixture");
  const owner = createOutbox(
    viewer.pubkey,
    {
      sign: async () => {
        throw new Error("No sign expected");
      },
      publish: async () => {
        throw new Error("No publish expected");
      },
    },
    {
      load: () =>
        [first, second, pending].map((event) => ({
          event,
          signed: event,
          delivery: "unknown" as const,
        })),
      save: () => {},
    },
  );
  try {
    await owner.ready;
    owner.observe([unrelated, second, first]);
    expect(owner.outbox.snapshot().map((item) => item.event.id)).toEqual([
      pending.id,
    ]);
    expect(
      owner.local.snapshot().map((item) => [item.event.id, item.delivery]),
    ).toEqual([
      [first.id, "seen"],
      [second.id, "seen"],
      [pending.id, "unknown"],
    ]);
  } finally {
    owner.dispose();
  }
});

it.each(["unknown", "accepted"] as const)(
  "preserves prior %s when retry publication is rejected and after restore",
  async (prior) => {
    const storage = memoryStorage();
    const h = setup(storage);
    const id = h.send();
    await h.signNext();
    const first = h.publications.shift();
    assert.exists(first);
    if (prior === "unknown") first.reject(new Error("Lost ACK"));
    else first.resolve();
    await flush();
    expect(h.outbox.snapshot()[0]?.delivery).toBe(prior);
    h.outbox.retry(id);
    await flush();
    const retry = h.publications.shift();
    assert.exists(retry);
    retry.reject(new PublishRejected("membership changed"));
    await flush();
    expect(h.outbox.snapshot()[0]).toMatchObject({
      delivery: prior,
      error: "Retry blocked: membership changed",
    });
    h.dispose();
    const restored = setup(storage);
    expect(restored.outbox.snapshot()[0]).toMatchObject({
      delivery: "unknown",
      error: "Retry blocked: membership changed",
    });
  },
);
it("storage failure before a retry dispatch cannot erase prior uncertainty", async () => {
  let fail = false;
  const h = setup({
    load: () => [],
    save: () => {
      if (fail) throw new Error("disk full");
    },
  });
  const id = h.send();
  await h.signNext();
  const first = h.publications.shift();
  assert.exists(first);
  first.reject(new Error("Lost ACK"));
  await flush();
  fail = true;
  h.outbox.retry(id);
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.outbox.snapshot()[0]).toMatchObject({
    delivery: "unknown",
    error: "Retry failed: disk full",
  });
});

it("a queued retry deadline preserves unknown evidence without another dispatch", async () => {
  vi.useFakeTimers();
  const event = signed(viewer, {
    kind: 9,
    content: "prior send",
    tags: [["h", "c"]],
  });
  const h = setup(
    {
      load: () => [{ event, signed: event, delivery: "unknown" }],
      save: () => {},
    },
    100,
  );
  for (let i = 0; i < 3; i++) h.send(`occupy ${i}`);
  h.outbox.retry(event.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.sign).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(101);
  expect(
    h.outbox.snapshot().find((item) => item.event.id === event.id)?.delivery,
  ).toBe("unknown");
  expect(h.publish).not.toHaveBeenCalled();
});

for (const outcome of [
  "ack",
  "echo",
  "unknown-then-echo",
  "rejected",
  "unknown",
] as const) {
  it(`delivered notification follows ${outcome}, never enqueue/sign or unknown outcome`, async () => {
    const storage = memoryStorage();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const publish = vi.fn(
      () =>
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const owner = createOutbox(
      viewer.pubkey,
      {
        sign: async (template) => signed(viewer, template),
        publish,
      },
      storage,
    );
    const notified = vi.fn();
    owner.outbox.observeSend((event) => () => notified(event));
    const id = owner.outbox.send({
      kind: 9,
      content: "wake",
      tags: [["h", "c"]],
    });
    try {
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
      expect(notified).not.toHaveBeenCalled();
      const event = owner.outbox.snapshot()[0]?.signed;
      assert.exists(event);
      if (outcome === "ack") resolve();
      else if (outcome === "echo") owner.observe([event]);
      else
        reject(
          outcome === "rejected"
            ? new PublishRejected("no")
            : new Error("lost ACK"),
        );
      await flush();
      if (outcome === "unknown-then-echo") {
        expect(notified).not.toHaveBeenCalled();
        expect(owner.outbox.snapshot()[0]?.delivery).toBe("unknown");
        owner.observe([event]);
      }
      const confirmed = ["ack", "echo", "unknown-then-echo"].includes(outcome);
      expect(notified).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      if (confirmed) {
        expect(notified).toHaveBeenCalledWith({
          id: event.id,
          pubkey: event.pubkey,
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          created_at: event.created_at,
        });
        owner.observe([event]);
        owner.outbox.retry(id);
        await flush();
        expect(notified).toHaveBeenCalledOnce();
      }
      owner.dispose();
      const restored = createOutbox(
        viewer.pubkey,
        {
          sign: async (template) => signed(viewer, template),
          publish,
        },
        storage,
      );
      restored.outbox.observeSend((event) => () => notified(event));
      await restored.ready;
      restored.observe([event]);
      expect(notified).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      restored.dispose();
    } finally {
      owner.dispose();
    }
  });
}

it("a failing delivered observer cannot turn a confirmed send into failure", async () => {
  const owner = createOutbox(
    viewer.pubkey,
    {
      sign: async (template) => signed(viewer, template),
      publish: async () => {},
    },
    memoryStorage(),
  );
  const next = vi.fn();
  owner.outbox.observeSend(() => () => {
    throw new Error("observer");
  });
  owner.outbox.observeSend(() => next);
  try {
    owner.outbox.send({ kind: 9, content: "hello", tags: [] });
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(owner.outbox.snapshot()[0]?.delivery).toBe("accepted");
  } finally {
    owner.dispose();
  }
});

it("restores a retained creation to retained storage when dismissal cannot persist", async () => {
  const event = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [["h", "11111111-1111-4111-8111-111111111111"]],
  });
  const retained: OutgoingEvent = { event, signed: event, delivery: "seen" };
  let records: readonly OutgoingEvent[] = [retained];
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("journal unavailable"))
    .mockImplementation(async (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    });
  const owner = createOutbox(
    viewer.pubkey,
    {
      sign: async (template) => signed(viewer, template),
      publish: async () => {},
    },
    { load: () => structuredClone(records), save },
  );
  try {
    await owner.ready;
    expect(owner.outbox.snapshot()).toHaveLength(0);
    await expect(owner.outbox.dismiss(event.id)).rejects.toThrow(
      "journal unavailable",
    );
    expect(owner.outbox.snapshot()).toHaveLength(0);
    expect(owner.local.snapshot()).toEqual([retained]);
    await vi.waitFor(() =>
      expect(records).toMatchObject([
        { event: { id: event.id }, delivery: "seen" },
      ]),
    );
  } finally {
    owner.dispose();
  }
});

it("keeps creation receipts when an access purge races journal hydration", async () => {
  const creation = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [["h", "11111111-1111-4111-8111-111111111111"]],
  });
  const message = signed(viewer, {
    kind: 9,
    content: "private content",
    tags: [["h", "11111111-1111-4111-8111-111111111111"]],
  });
  let hydrate!: (items: readonly OutgoingEvent[]) => void;
  const owner = createOutbox(
    viewer.pubkey,
    {
      sign: async (template) => signed(viewer, template),
      publish: async () => {},
    },
    {
      load: () =>
        new Promise((resolve) => {
          hydrate = resolve;
        }),
      save: async () => {},
    },
  );
  try {
    owner.purgeConfirmed((event) => event.kind === 9007);
    hydrate([
      { event: creation, signed: creation, delivery: "seen" },
      { event: message, signed: message, delivery: "seen" },
    ]);
    await owner.ready;
    expect(owner.outbox.snapshot()).toHaveLength(0);
    expect(owner.local.snapshot().map(({ event }) => event.id)).toEqual([
      creation.id,
    ]);
  } finally {
    owner.dispose();
  }
});

it.each(["commit", "reject", "echo"] as const)(
  "serializes delayed dismissal with concurrent intent: %s",
  async (outcome) => {
    const event = signed(viewer, {
      kind: 40003,
      content: "Retained edit",
      tags: [["e", "a".repeat(64)]],
    });
    const pending: OutgoingEvent = { event, signed: event, delivery: "failed" };
    let records: readonly OutgoingEvent[] = [pending];
    let release = () => {};
    let reject = (_error: Error) => {};
    const gate = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let saving = () => {};
    const started = new Promise<void>((resolve) => {
      saving = resolve;
    });
    let hold = true;
    const sign = vi.fn(async (template: EventTemplate) =>
      signed(viewer, template),
    );
    const publish = vi.fn(async () => {});
    const owner = createOutbox(
      viewer.pubkey,
      { sign, publish },
      {
        load: () => records,
        async save(next) {
          if (hold && !next.some((item) => item.event.id === event.id)) {
            saving();
            await gate;
          }
          records = next;
        },
      },
    );
    try {
      await owner.ready;
      const dismissal = owner.outbox.dismiss(event.id);
      const result = dismissal.then(
        () => undefined,
        (error: unknown) => error,
      );
      await started;
      const duplicate = owner.outbox.dismiss(event.id);
      expect(duplicate).toBe(dismissal);
      let duplicateSettled = false;
      const duplicateResult = duplicate.then(
        () => {
          duplicateSettled = true;
        },
        (error: unknown) => {
          duplicateSettled = true;
          return error;
        },
      );
      await Promise.resolve();
      expect(duplicateSettled).toBe(false);
      expect(owner.outbox.snapshot()).toEqual([pending]);
      expect(owner.local.snapshot()).toEqual([pending]);
      owner.outbox.retry(event.id);
      expect(owner.outbox.snapshot()).toEqual([pending]);
      const nextId = owner.outbox.send({
        kind: 9,
        content: "Concurrent intent",
        tags: [["h", "c"]],
      });
      if (outcome === "echo") owner.observe([event]);
      hold = false;
      if (outcome === "commit") release();
      else reject(new Error("Disk unavailable"));
      expect(await result).toEqual(
        outcome === "commit" ? undefined : new Error("Disk unavailable"),
      );
      expect(await duplicateResult).toEqual(await result);
      await vi.waitFor(() =>
        expect(
          owner.outbox.snapshot().find((item) => item.event.id === nextId)
            ?.delivery,
        ).toBe("accepted"),
      );
      await vi.waitFor(() =>
        expect(records.find((item) => item.event.id === nextId)?.delivery).toBe(
          "accepted",
        ),
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(1);
      const remaining = records.find((item) => item.event.id === event.id);
      if (outcome === "commit") expect(remaining).toBeUndefined();
      else
        expect(remaining).toMatchObject({
          event,
          delivery: outcome === "echo" ? "seen" : "failed",
        });
      expect(
        owner.outbox.snapshot().some((item) => item.event.id === event.id),
      ).toBe(outcome === "reject");
    } finally {
      release();
      owner.dispose();
    }
  },
);

it("fences caller-scoped admission before signing and at publisher entry", async () => {
  const h = setup();
  const template = {
    kind: 9000,
    content: "",
    tags: [
      ["h", "c"],
      ["p", "a".repeat(64)],
    ],
  };
  let active = true;
  const first = h.outbox.send(template, undefined, () => active);
  active = false;
  await vi.waitFor(() =>
    expect(
      h.outbox.snapshot().find((row) => row.event.id === first)?.delivery,
    ).toBe("failed"),
  );
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  expect(() => h.outbox.retry(first)).toThrow(/cancelled/);
  active = true;
  h.outbox.retry(first, () => active);
  await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
  const request = h.signatures.shift();
  assert.exists(request);
  active = false;
  request.resolve(signed(viewer, request.event));
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(h.publish).not.toHaveBeenCalled();
  active = true;
  h.outbox.retry(first, () => active);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  const dispatched = h.publications.shift();
  assert.exists(dispatched);
  active = false; // Past publisher entry: result may have reached the relay.
  dispatched.resolve();
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("accepted"),
  );
});

it("promotes a legacy saved invitation when a profile retries it with live admission", async () => {
  const storage = memoryStorage();
  const event = signed(viewer, {
    kind: 9000,
    content: "",
    tags: [
      ["h", "c"],
      ["p", "a".repeat(64)],
    ],
  });
  const { sig: _sig, ...unsigned } = event;
  await storage.save([{ event: unsigned, delivery: "failed" }]);
  const h = setup(storage);
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.event.id).toBe(event.id),
  );
  const id = event.id;
  expect(h.outbox.snapshot()[0]?.guarded).toBeUndefined();

  let active = true;
  h.outbox.retry(id, () => active);
  await vi.waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
  const request = h.signatures.shift();
  assert.exists(request);
  // A pre-hardening saved intent is now guarded, even while signing is held.
  active = false;
  request.resolve(signed(viewer, request.event));
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(h.outbox.snapshot()[0]?.guarded).toBe(true);
  expect(h.publish).not.toHaveBeenCalled();
  expect(() => h.outbox.retry(id)).toThrow(/cancelled/);

  const restored = setup(storage);
  await vi.waitFor(() =>
    expect(restored.outbox.snapshot()[0]?.event.id).toBe(id),
  );
  expect(restored.outbox.snapshot()[0]?.guarded).toBe(true);
  expect(() => restored.outbox.retry(id)).toThrow(/cancelled/);
  expect(restored.publish).not.toHaveBeenCalled();
});

it("does not replay a guarded addition through generic retry or after hydration", async () => {
  const storage = memoryStorage();
  const h = setup(storage);
  let active = true;
  const id = h.outbox.send(
    {
      kind: 9000,
      content: "",
      tags: [
        ["h", "c"],
        ["p", "a".repeat(64)],
      ],
    },
    undefined,
    () => active,
  );
  active = false;
  await vi.waitFor(() =>
    expect(h.outbox.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(() => h.outbox.retry(id)).toThrow(/cancelled/);
  const restored = setup(storage);
  await vi.waitFor(() =>
    expect(restored.outbox.snapshot()[0]?.event.id).toBe(id),
  );
  expect(restored.outbox.snapshot()[0]?.guarded).toBe(true);
  expect(() => restored.outbox.retry(id)).toThrow(/cancelled/);
  expect(restored.sign).not.toHaveBeenCalled();
  expect(restored.publish).not.toHaveBeenCalled();
  restored.outbox.retry(id, () => true); // Explicit renewed admission may reuse the exact event.
  await vi.waitFor(() => expect(restored.sign).toHaveBeenCalledOnce());
});
it("plugin row kinds are written exactly as given, without message ordering tags", () => {
  const release = registerPluginRowKind(40006);
  try {
    const h = setup();
    h.outbox.send({ kind: 40006, content: "{}", tags: [["h", "c"]] });
    h.send();
    const [plugin, core] = h.outbox.snapshot().map((item) => item.event);
    expect(plugin?.tags.map(([name]) => name)).toEqual(["h", "client-id"]);
    expect(core?.tags.map(([name]) => name)).toContain("ms");
  } finally {
    release();
  }
});
