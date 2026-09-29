import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { foldMessages } from "./fold";
import {
  readJournal,
  newReadJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import type { RelayEvent } from "./events";
import type { ThreadActivitySnapshot } from "./unread";
import type { ChannelStoreOptions } from "./store";
import type { SavedHead } from "./persistence";
import type { ReadStateSigning } from "./read-state-host";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
  flush,
  bounds,
} from "./testing";
// @ts-expect-error Test the production Node codec with disposable identities.
import { decodeReadState, signReadState } from "../../../dev/read-state.mjs";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(
  options: ChannelStoreOptions = {},
  signer = true,
  preloaded?: (journal: ReadJournal) => ReadJournal,
) {
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair();
  let journal: ReadJournal | undefined = preloaded?.(newReadJournal());
  let hold: Promise<void> | undefined;
  let commitHold: Promise<void> | undefined;
  let started: (() => void) | undefined;
  let failNextSave = false;
  let failure: Error | undefined;
  const storage: ReadStateStorage = {
    async update(change) {
      if (failure) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      if (hold) {
        const wait = hold;
        hold = undefined;
        started?.();
        started = undefined;
        await wait;
      }
      if (failNextSave) {
        failNextSave = false;
        throw new Error("Storage update rejected");
      }
      journal = readJournal(change(journal), viewer.pubkey);
      if (commitHold) {
        const wait = commitHold;
        commitHold = undefined;
        await wait;
      }
      return journal;
    },
    close() {},
  };
  let incoming: (events: readonly RelayEvent[]) => void = () => {};
  const query = vi.fn(
    async (_filters: readonly import("./events").ReadFilter[]) =>
      [] as RelayEvent[],
  );
  const host = {
    decode: vi.fn(async (events: readonly RelayEvent[]) =>
      decodeReadState(events, viewer.secret),
    ),
    sign: vi.fn(async (intent: ReadStateSigning) =>
      signReadState(intent, viewer.secret),
    ),
    publish: vi.fn(async () => {}),
  };
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      media: () => undefined,
      readState: signer ? host : { decode: host.decode },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      ...options,
      readStateStorage: storage,
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  owners.push(owner);
  const emit = (events: readonly RelayEvent[]) => incoming(events);
  const grant = (id: string, time = 10) =>
    emit([
      roster(relay, id, [viewer.pubkey], time),
      metadata(relay, id, id, time),
    ]);
  const target = { kind: "channel" as const, channelId: "room" };
  return {
    ...owner,
    viewer,
    relay,
    alice,
    host,
    query,
    emit,
    grant,
    target,
    snapshot: () => owner.session.unread.snapshot(target),
    journal: () => journal,
    failNextSave() {
      failNextSave = true;
    },
    holdSaveStarted() {
      let release = () => {};
      let signal = () => {};
      const startedPromise = new Promise<void>((resolve) => {
        signal = resolve;
      });
      started = signal;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { started: startedPromise, release };
    },
    failSave() {
      failure = new Error("disk full");
    },
    holdSave() {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    /** Holds the next save after its change is applied but before it resolves,
     * like a storage transaction still committing when relay events arrive. */
    holdCommit() {
      let release = () => {};
      commitHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

it("production live evidence feeds stable snapshots; selection/prefetch do not read", async () => {
  const h = setup();
  h.grant("room");
  const unread = h.session.unread;
  expect(h.snapshot().observedCount).toBeNull();
  const row = message(h.alice, "room", "hello", 11, [["p", h.viewer.pubkey]]);
  h.emit([row, row, message(h.viewer, "room", "own", 12)]);
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    attentionCount: 1,
    coverage: "observed",
    latestMessage: {
      id: message(h.viewer, "room", "own", 12).id,
      createdAt: 12,
    },
  });
  const snapshot = h.snapshot(),
    changed = vi.fn();
  unread.subscribe(h.target, changed);
  h.emit([row]);
  expect(h.snapshot()).toBe(snapshot);
  expect(changed).not.toHaveBeenCalled();
  await flush();
  expect(h.journal()?.state.frontiers).toEqual({});
  expect(h.host.sign).not.toHaveBeenCalled();
});

it("unread repair observes history without seeding the channel window or consuming its cursor", async () => {
  const h = setup();
  const rows = Array.from({ length: 60 }, (_, i) =>
    message(h.alice, "room", `history ${i}`, i + 11),
  );
  h.query.mockImplementation(async (filters) => {
    const filter = filters[0];
    if (!filter?.kinds?.includes(9)) return [];
    if (filter.limit === 500) return rows; // Roster-wide unread evidence, not a window page.
    const older = filter.until !== undefined;
    const cursor = rows[older ? 20 : 40];
    if (!cursor) throw new Error("Missing fixture cursor");
    return [
      ...rows.slice(older ? 20 : 40, older ? 40 : 60),
      bounds(
        h.relay,
        "room",
        older ? `${filter.until}:${filter.before_id}` : "head",
        {
          has_more: true,
          next_cursor: {
            created_at: cursor.created_at,
            id: cursor.id,
          },
        },
      ),
    ];
  });
  h.grant("room");
  h.session.channels.ensure("room");
  await vi.waitFor(() =>
    expect(h.session.channels.window("room").rows).toHaveLength(20),
  );
  const head = h.session.channels.window("room");
  await h.session.unread.ensure();
  expect(h.snapshot().observedCount).toBe(60);
  expect(h.session.channels.window("room")).toBe(head);
  expect(h.journal()?.state.frontiers).toEqual({});
  h.session.channels.loadOlder("room");
  await vi.waitFor(() =>
    expect(h.session.channels.window("room").rows).toHaveLength(40),
  );
  expect(h.session.channels.window("room").rows.map(({ id }) => id)).toEqual(
    rows.slice(20).map(({ id }) => id),
  );
  const cursorReads = h.query.mock.calls.flatMap(([filters]) =>
    filters.filter((filter) => filter.until !== undefined),
  );
  expect(cursorReads).toHaveLength(1);
  expect(cursorReads[0]).toMatchObject({
    until: rows[40]?.created_at,
    before_id: rows[40]?.id,
    limit: 20,
  });
});

it.each([5, 9005])(
  "later kind-%s deletions resolve repair-only evidence without seeding a window",
  async (kind) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "repair only", 11);
    h.query.mockImplementation(async (filters) =>
      filters[0]?.kinds?.includes(9) ? [row] : [],
    );
    await h.session.unread.ensure();
    expect(h.snapshot().observedCount).toBe(1);
    const window = h.session.channels.window("room");
    expect(window.rows).toHaveLength(0);
    const deletion = (author: typeof h.alice, ids = [row.id]) =>
      signed(author, {
        kind,
        content: "",
        tags: [["h", "room"], ...ids.map((id) => ["e", id])],
      });
    h.emit([deletion(h.viewer)]);
    expect(h.snapshot().observedCount).toBe(1);
    h.emit([deletion(h.alice, [row.id, "f".repeat(64)])]);
    expect(h.snapshot().observedCount).toBe(1); // Explicit #h cannot launder an unknown target.
    h.emit([deletion(h.alice)]);
    expect(h.snapshot().observedCount).toBe(0);
    expect(h.session.channels.window("room")).toBe(window);
  },
);

it("a deletion cannot use revoked unread evidence to delete an accessible target", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const hidden = message(h.alice, "room", "private", 11);
  const visible = message(h.alice, "other", "accessible", 12);
  h.query.mockImplementation(async (filters) =>
    filters[0]?.kinds?.includes(9) ? [hidden, visible] : [],
  );
  await h.session.unread.ensure();
  h.emit([roster(h.relay, "room", [], 20)]);
  const deletion = signed(h.alice, {
    kind: 5,
    content: "",
    tags: [
      ["h", "other"],
      ["e", visible.id],
      ["e", hidden.id],
    ],
  });
  h.emit([deletion]);
  expect(h.snapshot().observedCount).toBeNull();
  expect(
    h.session.unread.snapshot({ kind: "channel", channelId: "other" })
      .observedCount,
  ).toBe(1);
  h.grant("room", 21);
  await h.session.unread.refresh();
  expect(h.snapshot().observedCount).toBe(1);
});

it("promotes mentions, broadcasts and participating-thread replies without promoting ordinary unread", () => {
  const h = setup();
  h.grant("room");
  const root = message(h.viewer, "room", "root", 10);
  const ordinary = message(h.alice, "room", "ordinary", 11);
  h.emit([root, ordinary]);
  expect(h.snapshot()).toMatchObject({ observedCount: 1, attentionCount: 0 });

  const mentioned = message(h.alice, "room", "mentioned", 12, [
    ["p", h.viewer.pubkey],
  ]);
  const broadcast = message(h.alice, "room", "broadcast", 13, [
    ["e", root.id, "", "reply"],
    ["broadcast", "1"],
  ]);
  const participatingReply = message(h.alice, "room", "reply", 14, [
    ["e", root.id, "", "reply"],
  ]);
  const missingRootBroadcast = message(
    h.alice,
    "room",
    "broadcast without retained root",
    15,
    [
      ["e", "f".repeat(64), "", "reply"],
      ["broadcast", "1"],
    ],
  );
  h.emit([mentioned, broadcast, participatingReply, missingRootBroadcast]);
  expect(h.snapshot()).toMatchObject({ observedCount: 5, attentionCount: 4 });
  expect(h.session.unread.activity("room").items).toHaveLength(1);
  expect(
    h.session.unread.attention("room", missingRootBroadcast.id),
  ).toMatchObject({ status: "unknown", unread: true });
});

it("late DM metadata updates an existing attention selector without expiring reading intent", async () => {
  const h = setup();
  h.grant("room");
  await h.session.unread.ensure(); // Settle initialization; no later read-state activity can mask invalidation.
  const row = message(h.alice, "room", "dm", 11);
  h.emit([row]);
  const before = h.snapshot();
  expect(before).toMatchObject({ observedCount: 1, attentionCount: 0 });
  const changed = vi.fn();
  h.session.unread.subscribe(h.target, changed);
  const reading = h.session.unread.reading("room");
  h.emit([
    signed(h.relay, {
      kind: 39000,
      content: "",
      created_at: 20,
      tags: [
        ["d", "room"],
        ["name", "room"],
        ["t", "dm"],
      ],
    }),
  ]);
  expect(
    h.session.channels.list().channels.find(({ id }) => id === "room")
      ?.channelType,
  ).toBe("dm");
  expect(h.snapshot()).toMatchObject({ observedCount: 1, attentionCount: 1 });
  expect(h.snapshot()).not.toBe(before);
  expect(changed).toHaveBeenCalledTimes(1);
  await reading.observe([row.id]);
  expect(h.journal()?.state.frontiers[`msg:${row.id}`]).toBe(11);
});

it.each(["lowercase", "uppercase reply", "uppercase root", "last valid"])(
  "thread row projection and unread ancestry agree on %s references",
  async (variant) => {
    const h = setup();
    h.grant("room");
    const root = message(h.viewer, "room", "root", 11);
    const unrelated = message(h.viewer, "room", "unrelated", 11);
    const reference = (id: string) =>
      variant === "lowercase" ? id : id.toUpperCase();
    const tags = (parentId: string) => [
      ...(variant === "last valid"
        ? [
            ["e", unrelated.id, "", "root"],
            ["e", unrelated.id, "", "reply"],
          ]
        : []),
      ...(variant === "uppercase root" || variant === "last valid"
        ? [["e", reference(root.id), "", "root"]]
        : []),
      ["e", reference(parentId), "", "reply"],
      ...(variant === "last valid"
        ? [
            ["e", "invalid", "", "root"],
            ["e", "invalid", "", "reply"],
          ]
        : []),
    ];
    const broadcast = message(h.viewer, "room", "broadcast", 12, [
      ...tags(root.id),
      ["broadcast", "1"],
    ]);
    const reply = message(h.alice, "room", "unread", 13, tags(broadcast.id));
    h.emit([root, unrelated, broadcast, reply]);
    const row = foldMessages("room", h.relay.pubkey, [broadcast])[0];
    assert(row?.threadRootId);
    expect(row.threadRootId).toBe(root.id);
    const target = {
      kind: "thread" as const,
      channelId: "room",
      rootId: row.threadRootId,
    };
    expect(h.session.unread.snapshot(target)).toMatchObject({
      observedCount: 1,
      attentionCount: 1,
      coverage: "observed",
    });
    expect(h.query).not.toHaveBeenCalled();
    await h.session.unread.markThrough(target, reply.id);
    expect(h.journal()?.state.frontiers).toEqual({ [`thread:${root.id}`]: 13 });
    expect(h.session.unread.snapshot(target).observedCount).toBe(0);
    expect(h.snapshot().observedCount).toBe(0); // Inherited thread frontier agrees too.
    const reading = h.session.unread.reading("room");
    await reading.observe([reply.id]);
    reading.dispose();
    expect(h.journal()?.state.frontiers).toEqual({ [`thread:${root.id}`]: 13 });
  },
);

it("groups unread thread activity by same-channel root and clears one item without clearing unrelated or manual unread", async () => {
  const h = setup();
  h.grant("room");
  const firstRoot = message(h.viewer, "room", "first root", 10);
  const secondRoot = message(h.viewer, "room", "second root", 11);
  const firstReply = message(h.alice, "room", "first reply", 12, [
    ["e", firstRoot.id, "", "reply"],
  ]);
  const latestFirstReply = message(h.alice, "room", "latest first reply", 14, [
    ["e", firstReply.id, "", "reply"],
  ]);
  const secondReply = message(h.alice, "room", "second reply", 13, [
    ["e", secondRoot.id, "", "reply"],
  ]);
  h.emit([
    firstRoot,
    secondRoot,
    firstReply,
    latestFirstReply,
    secondReply,
    message(h.alice, "room", "ordinary top level", 15),
  ]);

  expect(h.session.unread.activity("room")).toMatchObject({
    channelId: "room",
    coverage: "observed",
    freshness: "observed",
    items: [
      {
        channelId: "room",
        rootId: firstRoot.id,
        latestMessageId: latestFirstReply.id,
        authorId: h.alice.pubkey,
        createdAt: 14,
        preview: "latest first reply",
        unreadCount: 2,
      },
      {
        channelId: "room",
        rootId: secondRoot.id,
        latestMessageId: secondReply.id,
        authorId: h.alice.pubkey,
        createdAt: 13,
        preview: "second reply",
        unreadCount: 1,
      },
    ],
  });

  await h.session.unread.markUnreadLocal(h.target);
  await h.session.unread.markThrough(
    { kind: "thread", channelId: "room", rootId: firstRoot.id },
    latestFirstReply.id,
  );

  expect(h.session.unread.activity("room").items).toEqual([
    expect.objectContaining({
      rootId: secondRoot.id,
      latestMessageId: secondReply.id,
    }),
  ]);
  expect(h.snapshot()).toMatchObject({
    observedCount: 2,
    manual: "local-only",
  });
});

it("activity previews use edited and unwrapped current message content and notify subscribers", () => {
  const h = setup();
  h.grant("room");
  const root = message(h.viewer, "room", "root", 10);
  const reply = message(h.alice, "room", "ORIGINAL", 11, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply]);
  const before = h.session.unread.activity("room");
  const changes: ThreadActivitySnapshot[] = [];
  h.session.unread.subscribeActivity("room", () =>
    changes.push(h.session.unread.activity("room")),
  );
  h.emit([
    signed(h.alice, {
      kind: 40003,
      content: "EDITED",
      tags: [["e", reply.id]],
    }),
  ]);
  expect(h.session.unread.activity("room")).not.toBe(before);
  expect(h.session.unread.activity("room").items?.[0]?.preview).toBe("EDITED");
  expect(changes.at(-1)?.items?.[0]?.preview).toBe("EDITED");

  const agentReply = signed(h.alice, {
    kind: 40002,
    content: JSON.stringify({ content: "unwrapped hello" }),
    tags: [
      ["h", "room"],
      ["e", root.id, "", "reply"],
    ],
    created_at: 12,
  });
  h.emit([agentReply]);
  expect(h.session.unread.activity("room").items?.[0]).toMatchObject({
    latestMessageId: agentReply.id,
    preview: "unwrapped hello",
  });
});

it("repair-retained reference-only edits admit a later deletion without seeding a window", async () => {
  const h = setup();
  h.grant("room");
  const root = message(h.viewer, "room", "root", 10);
  const reply = message(h.alice, "room", "ORIGINAL", 11, [
    ["e", root.id, "", "reply"],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "EDITED",
    tags: [["e", reply.id]],
  });
  h.query.mockImplementation(async (filters) =>
    filters[0]?.kinds?.includes(9) ? [root, reply, edit] : [],
  );

  await h.session.unread.ensure();
  expect(h.session.unread.activity("room").items?.[0]?.preview).toBe("EDITED");
  const window = h.session.channels.window("room");
  expect(window.rows).toHaveLength(0);
  const changes: ThreadActivitySnapshot[] = [];
  h.session.unread.subscribeActivity("room", () =>
    changes.push(h.session.unread.activity("room")),
  );

  const deletion = (ids: readonly string[]) =>
    signed(h.alice, {
      kind: 5,
      content: "",
      tags: ids.map((id) => ["e", id]),
    });
  h.emit([deletion([edit.id, "f".repeat(64)])]);
  expect(h.session.unread.activity("room").items?.[0]?.preview).toBe("EDITED");
  expect(changes).toEqual([]);

  h.emit([deletion([edit.id])]);

  expect(h.session.unread.activity("room").items?.[0]?.preview).toBe(
    "ORIGINAL",
  );
  expect(changes.map((snapshot) => snapshot.items?.[0]?.preview)).toEqual([
    "ORIGINAL",
  ]);
  expect(h.session.channels.window("room")).toBe(window);
});

it("activity subscribers restore original content when a reference-only edit is deleted", () => {
  const h = setup();
  h.grant("room");
  const root = message(h.viewer, "room", "root", 10);
  const reply = message(h.alice, "room", "ORIGINAL", 11, [
    ["e", root.id, "", "reply"],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "EDITED",
    tags: [["e", reply.id]],
  });
  const deletion = signed(h.alice, {
    kind: 5,
    content: "",
    tags: [["e", edit.id]],
  });
  h.emit([root, reply]);
  const changes: ThreadActivitySnapshot[] = [];
  h.session.unread.subscribeActivity("room", () =>
    changes.push(h.session.unread.activity("room")),
  );

  h.emit([edit]);
  expect(changes.at(-1)?.items?.[0]?.preview).toBe("EDITED");
  h.emit([deletion]);
  expect(h.session.unread.activity("room").items?.[0]?.preview).toBe(
    "ORIGINAL",
  );
  expect(changes.map((snapshot) => snapshot.items?.[0]?.preview)).toEqual([
    "EDITED",
    "ORIGINAL",
  ]);
});

it("deletion-before-edit batches retain authorized ancestry without a transient activity change", () => {
  const h = setup();
  h.grant("room");
  const root = message(h.viewer, "room", "root", 10);
  const reply = message(h.alice, "room", "ORIGINAL", 11, [
    ["e", root.id, "", "reply"],
  ]);
  const edit = signed(h.alice, {
    kind: 40003,
    content: "EDITED",
    tags: [["e", reply.id]],
  });
  const deletion = signed(h.alice, {
    kind: 5,
    content: "",
    tags: [["e", edit.id]],
  });
  h.emit([root, reply]);
  const before = h.session.unread.activity("room");
  const changed = vi.fn();
  h.session.unread.subscribeActivity("room", changed);

  h.emit([deletion, edit]);
  expect(h.session.unread.activity("room")).toBe(before);
  expect(h.session.unread.activity("room").items?.[0]?.preview).toBe(
    "ORIGINAL",
  );
  expect(changed).not.toHaveBeenCalled();
});

it("resolves every activity item through its own channel hierarchy", () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const roomRoot = message(h.viewer, "room", "room root", 10);
  const otherRoot = message(h.viewer, "other", "other root", 10);
  const valid = message(h.alice, "room", "room reply", 12, [
    ["e", roomRoot.id, "", "reply"],
  ]);
  const foreign = message(h.alice, "room", "foreign ancestry", 13, [
    ["e", otherRoot.id, "", "reply"],
  ]);
  h.emit([roomRoot, otherRoot, valid, foreign]);

  expect(h.session.unread.activity("room").items).toEqual([
    expect.objectContaining({
      rootId: roomRoot.id,
      latestMessageId: valid.id,
    }),
  ]);
  expect(h.session.unread.activity("other").items).toEqual([]);
});

it("distinguishes unknown thread-activity evidence from observed evidence", () => {
  const h = setup();
  h.grant("room");
  expect(h.session.unread.activity("room")).toMatchObject({
    channelId: "room",
    items: null,
    coverage: "unknown",
    freshness: "unknown",
  });
  const root = message(h.viewer, "room", "root", 10);
  const reply = message(h.alice, "room", "retained reply", 11, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply]);
  expect(h.session.unread.activity("room")).toMatchObject({
    items: [expect.objectContaining({ latestMessageId: reply.id })],
    coverage: "observed",
    freshness: "observed",
  });
});

it("canonical unread ancestry still requires retained same-channel content", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const root = message(h.viewer, "room", "root", 11);
  const foreign = message(h.viewer, "other", "foreign", 11, [
    ["e", root.id.toUpperCase(), "", "reply"],
  ]);
  const unretained = message(h.viewer, "room", "unretained", 11, [
    ["e", root.id.toUpperCase(), "", "reply"],
  ]);
  const replies = [foreign, unretained].map((parent) =>
    message(h.alice, "room", parent.content, 12, [
      ["e", parent.id.toUpperCase(), "", "reply"],
    ]),
  );
  const rootOnly = message(h.alice, "room", "not a reply", 12, [
    ["e", root.id.toUpperCase(), "", "root"],
  ]);
  h.emit([root, foreign, rootOnly, ...replies]);
  const target = {
    kind: "thread" as const,
    channelId: "room",
    rootId: root.id,
  };
  expect(h.session.unread.snapshot(target).observedCount).toBe(0);
  for (const reply of replies)
    await expect(
      h.session.unread.markThrough(target, reply.id),
    ).rejects.toThrow("does not belong");
  expect(h.journal()?.state.frontiers ?? {}).toEqual({});
});

it("individual reply visibility leaves unseen siblings and the channel prefix untouched", async () => {
  const h = setup();
  h.grant("room");
  const root = message(h.alice, "room", "root", 11);
  const reply = message(h.alice, "room", "visible", 12, [
    ["e", root.id, "", "reply"],
  ]);
  const sibling = message(h.alice, "room", "unseen", 12, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, reply, sibling]);
  const handle = h.session.unread.reading("room");
  await handle.observe([reply.id]);
  expect(h.journal()?.state.frontiers).toEqual({ [`msg:${reply.id}`]: 12 });
  expect(h.snapshot().observedCount).toBe(2);
  expect(
    h.session.unread.snapshot({
      kind: "thread",
      channelId: "room",
      rootId: root.id,
    }).observedCount,
  ).toBe(1);
  await expect(
    h.session.unread.markThrough(h.target, reply.id),
  ).rejects.toThrow("reply");
  handle.dispose();
});

it.each([false, true])(
  "deletions/auxiliary events neither create counts nor depend on batch order (%s)",
  (reverse) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "deleted", 11);
    const deletion = signed(h.alice, {
      kind: 5,
      content: "",
      tags: [["e", row.id]],
    });
    const edit = signed(h.alice, {
      kind: 40003,
      content: "edited",
      tags: [["e", row.id]],
    });
    h.emit(reverse ? [deletion, edit, row] : [row, edit, deletion]);
    expect(h.snapshot().observedCount).toBe(0);
  },
);

it("a forged-author deletion does not hide a message", () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "retained", 11);
  h.emit([
    row,
    signed(h.viewer, { kind: 5, content: "", tags: [["e", row.id]] }),
  ]);
  expect(h.snapshot().observedCount).toBe(1);
});

it("all projections are denied before any revocation subscriber runs; durable intent survives", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "private", 11);
  h.emit([row]);
  await h.session.unread.markUnreadLocal(h.target);
  const exposed: (number | null)[] = [];
  h.session.profiles.subscribe(() => exposed.push(h.snapshot().observedCount));
  h.session.unread.subscribe(h.target, () =>
    exposed.push(h.snapshot().observedCount),
  );
  h.emit([roster(h.relay, "room", [], 20)]);
  expect(h.snapshot()).toMatchObject({ observedCount: null, manual: "none" });
  expect(exposed.length).toBeGreaterThan(0);
  expect(exposed.every((value) => value === null)).toBe(true);
  expect(h.journal()?.localUnread.room).toBeGreaterThan(0);
  h.grant("room", 21);
  expect(h.snapshot().observedCount).toBeNull();
});

it.each(["dispose", "revoke-regrant", "delete"])(
  "pending reading cannot outlive %s",
  async (action) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "visible", 11);
    h.emit([row]);
    await flush();
    const handle = h.session.unread.reading("room"),
      release = h.holdSave();
    const reading = handle.observe([row.id]);
    const result = reading.catch(() => {});
    await flush();
    if (action === "dispose") handle.dispose();
    if (action === "revoke-regrant") {
      h.emit([roster(h.relay, "room", [], 20)]);
      h.grant("room", 21);
    }
    if (action === "delete")
      h.emit([
        signed(h.alice, { kind: 5, content: "", tags: [["e", row.id]] }),
      ]);
    release();
    await result;
    expect(h.journal()?.state.frontiers).toEqual({});
  },
);

it("rejects manual unread targets whose signed message belongs to a different channel", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const row = message(h.alice, "other", "other channel", 11);
  h.emit([row]);
  await expect(
    h.session.unread.markUnreadLocal({
      kind: "message",
      channelId: "room",
      messageId: row.id,
    }),
  ).rejects.toThrow();
});

it("late reading leases cannot clear a newer manual unread action", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "visible", 11);
  h.emit([row]);
  const handle = h.session.unread.reading("room");
  await h.session.unread.markUnreadLocal(h.target);
  await handle.observe([row.id]);
  expect(h.journal()?.state.frontiers).toEqual({});
  expect(h.snapshot().manual).toBe("local-only");
});

it("reverified cache restore hands evidence to unread before exposing rows without network content", async () => {
  let saved: SavedHead[] = [];
  const h = setup({
    prepared: true,
    persistence: {
      read: async () => saved.slice(),
      write: async () => {},
      remove: async () => {},
      retain: async () => {},
      clear: async () => {},
      close() {},
    },
  });
  const row = message(h.alice, "room", "cached readable message", 11);
  saved = [
    {
      channelId: "room",
      savedAt: Date.now(),
      events: [
        row,
        bounds(h.relay, "room", "head", { has_more: false, next_cursor: null }),
      ],
      profiles: [],
    },
  ];
  h.query.mockImplementation(async (filters) => {
    if (filters[0]?.kinds?.includes(39002))
      return [roster(h.relay, "room", [h.viewer.pubkey], 10)];
    if (filters[0]?.kinds?.includes(39000))
      return [metadata(h.relay, "room", "room", 10)];
    return new Promise(() => {}); // No network content can supply the missing evidence.
  });
  h.session.channels.ensureList();
  h.session.channels.ensure("room");
  const seen: (number | null)[] = [];
  const stop = h.session.channels.subscribeWindow("room", () => {
    if (h.session.channels.window("room").rows.length)
      seen.push(h.snapshot().observedCount);
  });
  await vi.waitFor(() =>
    expect(h.session.channels.window("room").rows).toHaveLength(1),
  );
  expect(seen).toContain(1);
  expect(h.snapshot().observedCount).toBe(1);
  h.emit([signed(h.viewer, { kind: 5, content: "", tags: [["e", row.id]] })]);
  expect(h.snapshot().observedCount).toBe(1);
  h.emit([signed(h.alice, { kind: 5, content: "", tags: [["e", row.id]] })]);
  expect(h.snapshot().observedCount).toBe(0);
  stop();
});

it("explicit read clears local manual unread", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "readable", 11);
  h.emit([row]);
  await h.session.unread.markUnreadLocal(h.target);
  await h.session.unread.markThrough(h.target, row.id);
  expect(h.journal()?.localUnread.room).toBeUndefined();
  expect(h.journal()?.state.frontiers.room).toBe(11);
});

it.each(["clear", "revoke-regrant"])(
  "reentrant cache-restore subscriber %s fences row publication",
  async (action) => {
    let saved: SavedHead[] = [];
    const h = setup({
      prepared: true,
      persistence: {
        read: async () => saved.slice(),
        write: async () => {},
        remove: async () => {},
        retain: async () => {},
        clear: async () => {},
        close() {},
      },
    });
    const row = message(h.alice, "room", "cached readable message", 11);
    saved = [
      {
        channelId: "room",
        savedAt: Date.now(),
        events: [
          row,
          bounds(h.relay, "room", "head", {
            has_more: false,
            next_cursor: null,
          }),
        ],
        profiles: [],
      },
    ];
    h.query.mockImplementation(async (filters) => {
      if (filters[0]?.kinds?.includes(39002))
        return [roster(h.relay, "room", [h.viewer.pubkey], 10)];
      if (filters[0]?.kinds?.includes(39000))
        return [metadata(h.relay, "room", "room", 10)];
      return new Promise(() => {}); // No network content can supply the missing evidence.
    });
    let triggered = false;
    const stopUnread = h.session.unread.subscribe(h.target, () => {
      if (triggered || h.snapshot().observedCount !== 1) return;
      triggered = true;
      saved = [];
      if (action === "clear") void h.clearCache();
      else {
        h.emit([roster(h.relay, "room", [], 20)]);
        h.grant("room", 21);
      }
    });
    h.session.channels.ensureList();
    h.session.channels.ensure("room");
    const seen: (number | null)[] = [];
    const stop = h.session.channels.subscribeWindow("room", () => {
      if (h.session.channels.window("room").rows.length)
        seen.push(h.snapshot().observedCount);
    });
    await vi.waitFor(() => expect(triggered).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.session.channels.ensure("room");
    expect(seen).toEqual([]);
    expect(h.session.channels.window("room").rows).toHaveLength(0);
    stopUnread();
    stop();
  },
);

it.each([5, 9005])(
  "live kind-%s multi-channel deletion updates subscribed and dormant unread projections together",
  async (kind) => {
    const h = setup();
    h.grant("room");
    h.grant("other");
    await h.session.unread.ensure();
    const rows = ["room", "other"].map((id) =>
      message(h.alice, id, "delete together", 11),
    );
    h.emit(rows);
    const other = { kind: "channel" as const, channelId: "other" };
    const otherRow = rows[1];
    assert(otherRow);
    const dormant = {
      kind: "message" as const,
      channelId: "other",
      messageId: otherRow.id,
    };
    expect(h.session.unread.snapshot(other).observedCount).toBe(1);
    expect(h.session.unread.snapshot(dormant).observedCount).toBe(1);
    const seen: (number | null)[][] = [];
    h.session.unread.subscribe(h.target, () =>
      seen.push([
        h.session.unread.snapshot(other).observedCount,
        h.session.unread.snapshot(dormant).observedCount,
      ]),
    );
    h.session.unread.subscribe(other, () => {});
    h.emit([
      signed(h.alice, {
        kind,
        content: "",
        tags: rows.map((row) => ["e", row.id]),
      }),
    ]);
    expect(seen).toEqual([[0, 0]]);
  },
);

it("projects event attention through the same mention, DM, participation and frontier policy", async () => {
  const h = setup();
  h.grant("room");
  const own = message(h.viewer, "room", "root", 11);
  const reply = message(h.alice, "room", "reply", 12, [
    ["e", own.id, "", "reply"],
  ]);
  const mention = message(h.alice, "room", "mention", 13, [
    ["p", h.viewer.pubkey],
  ]);
  const ordinary = message(h.alice, "room", "ordinary", 14);
  h.emit([own, reply, mention, ordinary]);
  const attention = (id: string) => h.session.unread.attention("room", id);
  expect(attention(own.id)).toMatchObject({
    status: "ineligible",
    unread: false,
  });
  expect(attention(reply.id)).toMatchObject({
    status: "eligible",
    category: "thread",
    rootId: own.id,
    unread: true,
  });
  expect(attention(mention.id)).toMatchObject({
    status: "eligible",
    category: "mention",
    unread: true,
  });
  expect(attention(ordinary.id)).toMatchObject({
    status: "ineligible",
    unread: true,
  });
  expect(h.snapshot().attentionCount).toBe(2);
  const lease = h.session.unread.reading("room");
  await lease.observe([reply.id]);
  expect(attention(reply.id).unread).toBe(false);
  expect(h.snapshot().attentionCount).toBe(1);
  h.emit([
    signed(h.relay, {
      kind: 39000,
      created_at: 20,
      content: "",
      tags: [
        ["d", "room"],
        ["name", "DM"],
        ["t", "dm"],
      ],
    }),
  ]);
  expect(attention(ordinary.id)).toMatchObject({
    status: "eligible",
    category: "direct",
  });
  // DM events p-tag their recipient; direct wins over mention in DM channels.
  expect(attention(mention.id).category).toBe("direct");
  expect(h.snapshot().attentionCount).toBe(2);
  expect(attention("f".repeat(64)).status).toBe("unknown");
  lease.dispose();
});
it("qualified viewing is lease-scoped and never writes a read marker", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "mention", 11, [["p", h.viewer.pubkey]]);
  h.emit([row]);
  let focused = true;
  const lease = h.session.unread.reading("room");
  const attention = () => h.session.unread.attention("room", row.id);
  lease.view([row.id, "f".repeat(64)], () => focused);
  expect(attention().viewing).toBe(true);
  await flush();
  expect(h.host.sign).not.toHaveBeenCalled();
  expect(attention().unread).toBe(true);
  focused = false;
  expect(attention().viewing).toBe(false);
  focused = true;
  lease.dispose();
  expect(attention().viewing).toBe(false);
});
it("attention fails closed after deletion or access loss, and viewing cannot survive regrant", () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "mention", 11, [["p", h.viewer.pubkey]]);
  h.emit([row]);
  const lease = h.session.unread.reading("room");
  lease.view([row.id], () => true);
  h.emit([
    signed(h.alice, {
      kind: 5,
      created_at: 12,
      content: "",
      tags: [["e", row.id]],
    }),
  ]);
  expect(h.session.unread.attention("room", row.id)).toMatchObject({
    status: "ineligible",
    viewing: false,
  });
  h.emit([roster(h.relay, "room", [], 20)]);
  expect(h.session.unread.attention("room", row.id).status).toBe("unknown");
  h.grant("room", 30);
  h.emit([row]);
  expect(h.session.unread.attention("room", row.id).viewing).toBe(false);
});

it("reports an own row's force independently of channel intent and never counts it as unread", async () => {
  const h = setup();
  h.grant("room");
  const own = message(h.viewer, "room", "own", 11);
  const peer = message(h.alice, "room", "peer", 12);
  h.emit([own, peer]);
  await h.session.unread.enterChannel("room");
  await h.session.unread.markThrough(
    { kind: "message", channelId: "room", messageId: peer.id },
    peer.id,
  );
  await h.session.unread.markUnreadLocal(h.target);
  await h.session.unread.markMessageUnread("room", own.id);
  expect(h.session.unread.attention("room", own.id)).toMatchObject({
    status: "ineligible",
    unread: false,
    forced: true,
  });
  const ownTarget = {
    kind: "message" as const,
    channelId: "room",
    messageId: own.id,
  };
  expect(h.session.unread.snapshot(ownTarget).manual).toBe("local-only");
  expect(h.session.unread.attention("room", peer.id).forced).toBe(false);
  expect(h.snapshot()).toMatchObject({
    observedCount: 0,
    manual: "local-only",
  });
  await h.session.unread.markMessageRead("room", own.id);
  expect(h.session.unread.attention("room", own.id)).toMatchObject({
    status: "ineligible",
    unread: false,
    forced: false,
  });
  expect(h.session.unread.snapshot(ownTarget).manual).toBe("none");
  expect(h.snapshot()).toMatchObject({
    observedCount: 0,
    manual: "local-only",
  });
  expect(h.journal()?.localUnread["message-force:room"]).toBeUndefined();
  expect(h.journal()?.localUnread.room).toBeGreaterThan(0);
  h.session.unread.leaveChannel("room");
  expect(h.session.unread.attention("room", own.id).forced).toBe(false);
});

it("forces loaded reply subtrees independently and preserves channel manual intent across visits", async () => {
  const h = setup();
  h.grant("room");
  const a = message(h.alice, "room", "a", 11);
  const aChild = message(h.alice, "room", "a child", 12, [
    ["e", a.id, "", "reply"],
  ]);
  const b = message(h.alice, "room", "b", 13);
  h.emit([a, aChild, b]);
  await h.session.unread.enterChannel("room");
  for (const row of [a, aChild, b])
    await h.session.unread.markThrough(
      { kind: "message", channelId: "room", messageId: row.id },
      row.id,
    );
  expect(h.snapshot().observedCount).toBe(0);
  await h.session.unread.markMessageUnread("room", a.id);
  await h.session.unread.markMessageUnread("room", b.id);
  expect(h.snapshot()).toMatchObject({
    observedCount: 3,
    manual: "local-only",
  });
  expect(h.session.unread.attention("room", aChild.id).unread).toBe(true);
  await h.session.unread.markMessageRead("room", a.id);
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    manual: "local-only",
  });
  await h.session.unread.markUnreadLocal(h.target);
  await h.session.unread.markMessageRead("room", b.id);
  expect(h.snapshot()).toMatchObject({
    observedCount: 0,
    manual: "local-only",
  });
  h.session.unread.leaveChannel("room");
  await h.session.unread.enterChannel("room");
  expect(h.snapshot().manual).toBe("local-only"); // Independent channel action survives.
});

it("leaves only the sidebar hint after channel leave and reconciles it on reopen", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "read", 11);
  h.emit([row]);
  await h.session.unread.enterChannel("room");
  await h.session.unread.markThrough(
    { kind: "message", channelId: "room", messageId: row.id },
    row.id,
  );
  await h.session.unread.markMessageUnread("room", row.id);
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    manual: "local-only",
  });
  h.session.unread.leaveChannel("room");
  expect(h.snapshot()).toMatchObject({
    observedCount: 0,
    manual: "local-only",
  });
  await h.session.unread.enterChannel("room");
  expect(h.snapshot()).toMatchObject({ observedCount: 0, manual: "none" });
});

it("manual message intent participates in shared counts and is cleared by explicit subtree read", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "read", 11);
  h.emit([row]);
  const target = {
    kind: "message" as const,
    channelId: "room",
    messageId: row.id,
  };
  await h.session.unread.markThrough(target, row.id);
  await h.session.unread.markUnreadLocal(target);
  expect(h.snapshot().observedCount).toBe(1);
  expect(h.session.unread.attention("room", row.id).unread).toBe(true);
  await h.session.unread.markMessageRead("room", row.id);
  expect(h.snapshot().observedCount).toBe(0);
  expect(h.journal()?.localUnread[`msg:${row.id}`]).toBeUndefined();
});

it("revocation rejects an unread action before its intent is saved", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "read", 11);
  h.emit([row]);
  const target = {
    kind: "message" as const,
    channelId: "room",
    messageId: row.id,
  };
  await h.session.unread.markThrough(target, row.id);
  const failed = h.session.unread.markMessageUnread("room", row.id);
  h.emit([roster(h.relay, "room", [], 20)]);
  await expect(failed).rejects.toThrow();
  expect(h.session.unread.attention("room", row.id).status).toBe("unknown");
});

it("revocation during a held subtree read keeps the previously saved force and frontiers", async () => {
  const h = setup();
  h.grant("room");
  const a = message(h.alice, "room", "a", 11);
  const b = message(h.alice, "room", "b", 12, [["e", a.id, "", "reply"]]);
  h.emit([a, b]);
  await h.session.unread.enterChannel("room");
  for (const row of [a, b])
    await h.session.unread.markThrough(
      { kind: "message", channelId: "room", messageId: row.id },
      row.id,
    );
  await h.session.unread.markMessageUnread("room", a.id);
  expect(h.snapshot().observedCount).toBe(2);
  const { started, release } = h.holdSaveStarted();
  const pending = h.session.unread.markMessageRead("room", a.id);
  await started;
  try {
    h.emit([roster(h.relay, "room", [], 20)]);
  } finally {
    release();
  }
  await expect(pending).rejects.toThrow();
  h.emit([roster(h.relay, "room", [h.viewer.pubkey], 21)]);
  h.emit([a, b]);
  expect(h.journal()?.localUnread["message-force:room"]).toBeGreaterThan(0);
  expect(h.journal()?.state.frontiers[`msg:${a.id}`]).toBe(11);
});

it("rejected storage update preserves the entire subtree and permits a clean retry", async () => {
  const h = setup();
  h.grant("room");
  const root = message(h.alice, "room", "root", 11);
  const child = message(h.alice, "room", "child", 12, [
    ["e", root.id, "", "reply"],
  ]);
  h.emit([root, child]);
  await h.session.unread.enterChannel("room");
  await h.session.unread.markMessageUnread("room", root.id);
  const before = h.journal();
  expect(h.snapshot()).toMatchObject({
    observedCount: 2,
    manual: "local-only",
  });
  h.failNextSave();
  await expect(
    h.session.unread.markMessageRead("room", root.id),
  ).rejects.toThrow("Storage update rejected");
  expect(h.journal()).toBe(before);
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBeUndefined();
  expect(h.journal()?.state.frontiers[`msg:${child.id}`]).toBeUndefined();
  expect(h.journal()?.localUnread["message-force:room"]).toBeGreaterThan(0);
  expect(h.snapshot()).toMatchObject({
    observedCount: 2,
    manual: "local-only",
  });
  expect(h.session.unread.attention("room", child.id).unread).toBe(true);
  await h.session.unread.markMessageRead("room", root.id);
  expect(h.snapshot()).toMatchObject({ observedCount: 0, manual: "none" });
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(11);
  expect(h.journal()?.state.frontiers[`msg:${child.id}`]).toBe(12);
  expect(h.journal()?.localUnread["message-force:room"]).toBeUndefined();
});

it("serializes independent subtree reads and rejects stale unread after leaving", async () => {
  const h = setup();
  h.grant("room");
  const a = message(h.alice, "room", "a", 11);
  const b = message(h.alice, "room", "b", 12);
  h.emit([a, b]);
  await h.session.unread.enterChannel("room");
  const unread = h.session.unread.markMessageUnread("room", a.id);
  const read = h.session.unread.markMessageRead("room", a.id);
  const second = h.session.unread.markMessageUnread("room", b.id);
  await Promise.all([unread, read, second]);
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    manual: "local-only",
  });
  const pending = h.session.unread.markMessageUnread("room", a.id);
  h.session.unread.leaveChannel("room");
  await expect(pending).rejects.toThrow("visit expired");
  expect(h.session.unread.attention("room", a.id).unread).toBe(false);
});

it("without a signer, clears a pre-read forced subtree but rejects fresh evidence", async () => {
  const old = message(keypair(), "room", "old", 11);
  // The fixture supplies a real, previously saved frontier and checks it is not modified.
  const h = setup({}, false, (journal) => ({
    ...journal,
    state: { ...journal.state, frontiers: { [`msg:${old.id}`]: 11 } },
  }));
  h.grant("room");
  const fresh = message(h.alice, "room", "fresh", 12);
  h.emit([old, fresh]);
  await h.session.unread.markMessageUnread("room", old.id);
  await h.session.unread.markMessageRead("room", old.id);
  expect(h.session.unread.attention("room", old.id).unread).toBe(false);
  expect(h.journal()?.state.frontiers[`msg:${old.id}`]).toBe(11);
  await expect(
    h.session.unread.markMessageRead("room", fresh.id),
  ).rejects.toThrow("unsupported");
  expect(h.session.unread.attention("room", fresh.id).unread).toBe(true);
});

it("reopening waits for the prior visit's queued unread and reconciles its sidebar hint", async () => {
  const h = setup();
  h.grant("room");
  const row = message(h.alice, "room", "old", 11);
  h.emit([row]);
  await h.session.unread.enterChannel("room");
  const { started, release } = h.holdSaveStarted();
  const pending = h.session.unread.markMessageUnread("room", row.id);
  await started; // The storage update has begun and is held before the visit changes.
  try {
    h.session.unread.leaveChannel("room");
  } finally {
    release();
  }
  await expect(pending).rejects.toThrow("Reading observation expired");
  await h.session.unread.enterChannel("room");
  expect(h.snapshot().manual).toBe("none");
});

it("without a signer, own descendants do not require read frontiers to clear a forced peer subtree", async () => {
  const peer = message(keypair(), "room", "peer", 11);
  const h = setup({}, false, (journal) => ({
    ...journal,
    state: { ...journal.state, frontiers: { [`msg:${peer.id}`]: 11 } },
  }));
  h.grant("room");
  const own = message(h.viewer, "room", "own reply", 12, [
    ["e", peer.id, "", "reply"],
  ]);
  h.emit([peer, own]);
  await h.session.unread.markMessageUnread("room", peer.id);
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    manual: "local-only",
  });
  await h.session.unread.markMessageRead("room", peer.id);
  expect(h.snapshot()).toMatchObject({ observedCount: 0, manual: "none" });
  expect(h.journal()?.state.frontiers[`msg:${own.id}`]).toBeUndefined();
  expect(h.journal()?.state.frontiers[`msg:${peer.id}`]).toBe(11);
});

it("channel read atomically clears owned marks through the latest reply, preserving other channels and later arrivals", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const root = message(h.alice, "room", "root", 11);
  const reply = message(h.alice, "room", "reply", 20, [
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  const other = message(h.alice, "other", "other", 12);
  h.emit([root, reply, other]);
  const unread = h.session.unread;
  const thread = {
    kind: "thread" as const,
    channelId: "room",
    rootId: root.id,
  };
  const msg = {
    kind: "message" as const,
    channelId: "room",
    messageId: reply.id,
  };
  await unread.markUnreadLocal(h.target);
  await unread.markUnreadLocal(thread);
  await unread.markUnreadLocal(msg);
  await unread.markUnreadLocal({ kind: "channel", channelId: "other" });
  const before = h.journal();
  const release = h.holdSave();
  const pending = unread.markChannelRead("room");
  // Arrival is beyond the captured frontier while its durable transaction waits.
  const later = message(h.alice, "room", "later", 21);
  h.emit([later]);
  expect(h.snapshot().manual).toBe("local-only");
  release();
  expect(await pending).toMatchObject({ durability: "saved", sync: "pending" });
  expect(h.journal()?.revision).toBe((before?.revision ?? 0) + 1);
  expect(h.journal()?.state.frontiers).toEqual({ room: 20 });
  expect(h.journal()?.localUnread).toEqual({
    other: before?.localUnread.other,
  });
  expect(unread.snapshot(thread)).toMatchObject({
    manual: "none",
    observedCount: 0,
  });
  expect(unread.snapshot(msg)).toMatchObject({
    manual: "none",
    observedCount: 0,
  });
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    attentionCount: 0,
    manual: "none",
  });
  expect(
    unread.snapshot({ kind: "channel", channelId: "other" }),
  ).toMatchObject({ observedCount: 1, manual: "local-only" });
  expect(h.session.channels.window("room").rows).toHaveLength(0);
});

it("mark all serialises channel reads over listed channels, skips read ones and finishes the sweep past a failure", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  h.grant("quiet");
  h.emit([
    message(h.alice, "room", "one", 11),
    message(h.alice, "other", "two", 12),
  ]);
  const unread = h.session.unread;
  const results = await unread.markAllChannelsRead();
  expect(results).toHaveLength(2);
  expect(results.every((result) => result.durability === "saved")).toBe(true);
  // "quiet" had nothing to clear, so it earned neither a frontier nor a write.
  expect(h.journal()?.state.frontiers).toEqual({ room: 11, other: 12 });

  // Nothing left to clear: the sweep costs no storage revision.
  const revision = h.journal()?.revision;
  expect(await unread.markAllChannelsRead()).toEqual([]);
  expect(h.journal()?.revision).toBe(revision);

  h.emit([
    message(h.alice, "room", "three", 13),
    message(h.alice, "other", "four", 14),
  ]);
  const later = { room: 13, other: 14 };
  const order = h.session.channels
    .list()
    .channels.map((channel) => channel.id)
    .filter((id) => id in later) as (keyof typeof later)[];
  const [first, second] = order;
  assert(first && second);
  h.failSave();
  await expect(unread.markAllChannelsRead()).rejects.toThrow("disk full");
  // The failing channel kept its old frontier while the sweep went on.
  expect(h.journal()?.state.frontiers).toEqual({
    room: 11,
    other: 12,
    [second]: later[second],
  });
  expect(
    unread.snapshot({ kind: "channel", channelId: first }).observedCount,
  ).toBe(1);
  expect(
    unread.snapshot({ kind: "channel", channelId: second }).observedCount,
  ).toBe(0);
});

it("mark all skips a channel whose grant is revoked mid-sweep instead of failing", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  h.emit([
    message(h.alice, "room", "one", 11),
    message(h.alice, "other", "two", 12),
  ]);
  const cut = { room: 11, other: 12 };
  const [first, second] = h.session.channels
    .list()
    .channels.map((channel) => channel.id)
    .filter((id) => id in cut) as (keyof typeof cut)[];
  assert(first && second);
  // Let the initial journal save settle so the hold lands on the sweep's write.
  await flush();
  // The first channel's write is still committing when the second grant goes.
  const release = h.holdCommit();
  const sweep = h.session.unread.markAllChannelsRead();
  await flush();
  expect(h.journal()?.state.frontiers).toEqual({ [first]: cut[first] });
  h.emit([roster(h.relay, second, [], 20)]);
  release();
  const results = await sweep;
  expect(results).toHaveLength(1);
  expect(results[0]?.durability).toBe("saved");
  // The revoked channel earned neither a frontier nor a failure.
  expect(h.journal()?.state.frontiers).toEqual({ [first]: cut[first] });
});

it("channel read clears local intent without fabricating a frontier when no messages are known", async () => {
  const h = setup();
  h.grant("room");
  await h.session.unread.markUnreadLocal(h.target);
  await h.session.unread.markChannelRead("room");
  expect(h.journal()?.state.frontiers).toEqual({});
  expect(h.snapshot()).toMatchObject({ observedCount: null, manual: "none" });
  expect(h.host.sign).not.toHaveBeenCalled();
});

it.each(["clearCache", "dispose", "revoke-regrant"] as const)(
  "channel read rejects delayed intent after %s without clearing saved marks",
  async (action) => {
    const h = setup();
    h.grant("room");
    h.emit([message(h.alice, "room", "root", 11)]);
    await h.session.unread.markUnreadLocal(h.target);
    const before = h.journal();
    const release = h.holdSave();
    const result = h.session.unread.markChannelRead("room");
    const rejected = expect(result).rejects.toThrow();
    if (action === "revoke-regrant") {
      h.emit([roster(h.relay, "room", [], 20)]);
      h.grant("room", 21);
    } else await h[action]();
    release();
    await rejected;
    expect(h.journal()?.state.frontiers).toEqual(before?.state.frontiers);
    expect(h.journal()?.localUnread).toEqual(before?.localUnread);
  },
);

it("channel read cannot use another channel, deleted content or auxiliary events as its frontier", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const root = message(h.alice, "room", "root", 11);
  const removed = message(h.alice, "room", "deleted", 20);
  h.emit([
    root,
    removed,
    message(h.alice, "other", "other", 30),
    signed(h.alice, {
      kind: 5,
      created_at: 40,
      tags: [
        ["h", "room"],
        ["e", removed.id],
      ],
      content: "",
    }),
  ]);
  await h.session.unread.markChannelRead("room");
  expect(h.journal()?.state.frontiers).toEqual({ room: 11 });
  await expect(h.session.unread.markChannelRead("denied")).rejects.toThrow(
    "unavailable",
  );
});

it("failed channel read saves neither frontier nor clears, and an explicit retry succeeds", async () => {
  const h = setup();
  h.grant("room");
  h.emit([message(h.alice, "room", "root", 11)]);
  await h.session.unread.markUnreadLocal(h.target);
  const before = h.journal();
  h.failSave();
  await expect(h.session.unread.markChannelRead("room")).rejects.toThrow(
    "disk full",
  );
  expect(h.journal()).toEqual(before);
  expect(h.snapshot()).toMatchObject({
    observedCount: 1,
    manual: "local-only",
  });
  await h.session.unread.markChannelRead("room");
  expect(h.snapshot()).toMatchObject({ observedCount: 0, manual: "none" });
});

it("channel read clears own-message force only after saving and preserves later message intent", async () => {
  const h = setup();
  h.grant("room");
  h.grant("other");
  const own = message(h.viewer, "room", "own", 11);
  const other = message(h.alice, "other", "other", 12);
  h.emit([own, other]);
  const unread = h.session.unread;
  await unread.enterChannel("room");
  await unread.markMessageUnread("room", own.id);
  await unread.markMessageUnread("other", other.id);
  h.failSave();
  await expect(unread.markChannelRead("room")).rejects.toThrow("disk full");
  expect(unread.attention("room", own.id)).toMatchObject({
    forced: true,
    unread: false,
  });
  expect(h.journal()?.localUnread["message-force:room"]).toBeGreaterThan(0);

  const held = h.holdSaveStarted();
  const reading = unread.markChannelRead("room");
  await held.started;
  expect(unread.attention("room", own.id).forced).toBe(true);
  held.release();
  await reading;
  expect(unread.attention("room", own.id)).toMatchObject({
    forced: false,
    unread: false,
  });
  expect(h.snapshot()).toMatchObject({ observedCount: 0, manual: "none" });
  expect(h.journal()?.localUnread["message-force:room"]).toBeUndefined();
  expect(unread.attention("other", other.id).forced).toBe(true);
  expect(h.journal()?.localUnread["message-force:other"]).toBeGreaterThan(0);

  // A message unread action invoked after channel read must win, even while its save waits.
  const next = h.holdSaveStarted();
  const secondRead = unread.markChannelRead("room");
  await next.started;
  const laterForce = unread.markMessageUnread("room", own.id);
  next.release();
  await Promise.all([secondRead, laterForce]);
  expect(unread.attention("room", own.id)).toMatchObject({
    forced: true,
    unread: false,
  });
  expect(h.snapshot()).toMatchObject({
    observedCount: 0,
    manual: "local-only",
  });
  expect(h.journal()?.localUnread["message-force:room"]).toBeGreaterThan(0);
});

it.each(["channel", "thread", "message"] as const)(
  "preserves a later %s unread choice behind pending message and channel reads",
  async (kind) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "root", 11);
    h.emit([row]);
    const unread = h.session.unread;
    await unread.enterChannel("room");
    const target =
      kind === "channel"
        ? h.target
        : kind === "thread"
          ? { kind, channelId: "room", rootId: row.id }
          : { kind, channelId: "room", messageId: row.id };
    const key =
      kind === "channel"
        ? "room"
        : `${kind === "thread" ? "thread" : "msg"}:${row.id}`;
    const held = h.holdSaveStarted();
    const messageRead = unread.markMessageRead("room", row.id);
    const pending = [messageRead];
    try {
      await held.started;
      pending.push(unread.markChannelRead("room"));
      pending.push(unread.markUnreadLocal(target));
    } finally {
      held.release();
    }
    await Promise.all(pending);
    expect(h.journal()?.state.frontiers.room).toBe(11);
    expect(h.journal()?.localUnread[key]).toBeGreaterThan(0);
    expect(unread.snapshot(target).manual).toBe("local-only");
  },
);

it.each(["markThrough", "clearUnreadLocal", "markChannelRead"] as const)(
  "%s preserves a final explicit read after queued local unread",
  async (action) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "root", 11);
    h.emit([row]);
    const unread = h.session.unread;
    await unread.enterChannel("room");
    const held = h.holdSaveStarted();
    const messageRead = unread.markMessageRead("room", row.id);
    const pending = [messageRead];
    try {
      await held.started;
      pending.push(unread.markUnreadLocal(h.target));
      pending.push(
        action === "markThrough"
          ? unread.markThrough(h.target, row.id)
          : action === "clearUnreadLocal"
            ? unread.clearUnreadLocal(h.target)
            : unread.markChannelRead("room"),
      );
    } finally {
      held.release();
    }
    await Promise.all(pending);
    expect(h.journal()?.localUnread.room).toBeUndefined();
    expect(h.snapshot().manual).toBe("none");
  },
);

it.each(
  (["clearCache", "dispose", "revoke-regrant"] as const).flatMap((action) =>
    (["markUnreadLocal", "markMessageRead", "markMessageUnread"] as const).map(
      (markAction) => ({ action, markAction }),
    ),
  ),
)(
  "queued $markAction stays invalid after $action",
  async ({ action, markAction }) => {
    const h = setup();
    h.grant("room");
    const row = message(h.alice, "room", "root", 11);
    h.emit([row]);
    await h.session.unread.enterChannel("room");
    const held = h.holdSaveStarted();
    const messageRead = h.session.unread.markMessageRead("room", row.id);
    const rejectedRead = expect(messageRead).rejects.toThrow();
    const pending = [rejectedRead];
    try {
      await held.started;
      const mark =
        markAction === "markUnreadLocal"
          ? h.session.unread.markUnreadLocal(h.target)
          : h.session.unread[markAction]("room", row.id);
      pending.push(expect(mark).rejects.toThrow());
      if (action === "revoke-regrant") {
        h.emit([roster(h.relay, "room", [], 20)]);
        h.grant("room", 21);
      } else await h[action]();
      if (action !== "dispose") {
        h.grant("room", 22);
        h.emit([row]); // Restored evidence must not revive pre-invalidation intent.
      }
    } finally {
      held.release();
    }
    await Promise.all(pending);
    expect(h.journal()?.localUnread.room).toBeUndefined();
    expect(h.journal()?.localUnread["message-force:room"]).toBeUndefined();
    expect(h.journal()?.state.frontiers[`msg:${row.id}`]).toBeUndefined();
  },
);

it("queued message read does not consume a reply arriving after the click", async () => {
  const h = setup();
  h.grant("room");
  const root = message(h.alice, "room", "root", 11);
  h.emit([root]);
  const unread = h.session.unread;
  await unread.enterChannel("room");
  const held = h.holdSaveStarted();
  const prior = unread.markUnreadLocal(h.target);
  let clicked: Promise<unknown> | undefined;
  const late = message(h.alice, "room", "late reply", 13, [
    ["e", root.id, "", "reply"],
    ["p", h.viewer.pubkey],
  ]);
  try {
    await held.started;
    clicked = unread.markMessageRead("room", root.id);
    h.emit([late]);
    expect(unread.attention("room", late.id).unread).toBe(true);
  } finally {
    held.release();
  }
  await Promise.all([prior, clicked]);
  expect(h.journal()?.state.frontiers[`msg:${root.id}`]).toBe(11);
  expect(h.journal()?.state.frontiers[`msg:${late.id}`]).toBeUndefined();
  expect(unread.attention("room", late.id).unread).toBe(true);
});

it.each(["markMessageRead", "markMessageUnread"] as const)(
  "%s rejects invalid targets asynchronously",
  async (action) => {
    const h = setup();
    h.grant("room");
    await expect(h.session.unread[action]("room", "missing")).rejects.toThrow();
  },
);
