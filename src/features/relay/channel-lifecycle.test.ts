import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { PublishRejected } from "./outbox";
import {
  createChannelLifecycle,
  ChannelLifecycleUnconfirmed,
} from "./channel-lifecycle";
import {
  lifecycleSettings,
  lifecycleTemplate,
  validateLifecycleTemplate,
} from "./channel-lifecycle-protocol";
import type { ReadFilter, RelayEvent } from "./events";
import type { ReadOptions } from "./reader";

const key = new Uint8Array(32).fill(2);
const relayKey = new Uint8Array(32).fill(3);
const agentKey = new Uint8Array(32).fill(4);
const other = getPublicKey(agentKey);
const viewer = getPublicKey(key);
const relayAuthor = getPublicKey(relayKey);
const id = "11111111-1111-4111-8111-111111111111";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(role = "owner", type = "stream", owners = 1) {
  let timestamp = 100;
  const record = (kind: number, tags: string[][], content = "") =>
    finalizeEvent({ kind, tags, content, created_at: timestamp++ }, relayKey);
  const metadata = (archived = false) =>
    record(39000, [
      ["d", id],
      ["t", type],
      ["name", "fixture"],
      ...(archived ? [["archived", "true"]] : []),
    ]);
  const roles = (role: string) =>
    record(39001, [
      ["d", id],
      ...(role === "member" ? [] : [["p", viewer, role]]),
      ...(owners > 1 ? [["p", other, "owner"]] : []),
    ]);
  let events = [
    metadata(),
    roles(role),
    record(39002, [
      ["d", id],
      ["p", viewer, "", role],
      ["p", other, "", owners > 1 ? "owner" : "member"],
    ]),
  ];
  let visible: RelayEvent[] = [];
  let active = true;
  const read = vi.fn(
    async (filters: readonly ReadFilter[], _options?: ReadOptions) => {
      if (filters[0]?.kinds?.[0] === 30622) return visible;
      return events.filter((event) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(event.kind) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter["#p"] ||
              event.tags.some(
                ([key, value]) =>
                  key === "p" && filter["#p"]?.includes(value ?? ""),
              )),
        ),
      );
    },
  );
  const sign = vi.fn(async (event: EventTemplate) =>
    finalizeEvent(structuredClone(event), key),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9002)
      events = [
        metadata(true),
        ...events.filter((event) => event.kind !== 39000),
      ];
    if (event.kind === 9008)
      events = events.filter((event) => event.kind !== 39000);
    if (event.kind === 9022)
      events = events.map((entry) =>
        entry.kind === 39002
          ? record(
              39002,
              entry.tags.filter(
                ([key, value]) => key !== "p" || value !== viewer,
              ),
            )
          : entry,
      );
    if (event.kind === 41012)
      visible = [
        record(30622, [
          ["d", viewer],
          ["p", viewer],
          ["h", id],
        ]),
      ];
  });
  const removed = vi.fn();
  const acceptDiscovery = vi.fn();
  const owner = createChannelLifecycle({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    canAccess: () => active,
    removed,
    acceptDiscovery,
  });
  return {
    owner,
    read,
    sign,
    publish,
    removed,
    acceptDiscovery,
    record,
    roles,
    metadata,
    setEvents: (value: RelayEvent[]) => {
      events = value;
    },
    getEvents: () => events,
    setVisible: (value: RelayEvent[]) => {
      visible = value;
    },
    deny: () => {
      active = false;
    },
  };
}

describe("type and role boundaries", () => {
  it.each([
    ["owner", "stream", 1, true, true, false, false],
    ["owner", "stream", 2, true, true, true, false],
    ["admin", "forum", 1, true, false, true, false],
    ["member", "stream", 1, false, false, true, false],
    ["owner", "dm", 1, false, false, false, true],
  ] as const)(
    "%s %s with %s owner(s)",
    async (role, type, owners, canArchive, canDelete, canLeave, canHide) => {
      const h = harness(role, type, owners);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canArchive,
        canDelete,
        canLeave,
        canHide,
      });
      h.owner.dispose();
    },
  );
  it.each(
    [[], ["wss://relay.example"], ["", "owner"]].map((hints) => ({ hints })),
  )(
    "accepts membership hints %j without granting administrator authority",
    async ({ hints }) => {
      const h = harness("member");
      h.setEvents([
        ...h.getEvents().filter((event) => event.kind !== 39002),
        h.record(39002, [
          ["d", id],
          ["p", viewer, ...hints],
        ]),
      ]);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canArchive: false,
        canDelete: false,
        canLeave: true,
      });
      h.owner.dispose();
    },
  );
  it.each(
    [
      [["p"]],
      [["p", "not-a-key"]],
      [["p", viewer, "", "owner", "unexpected"]],
      [
        ["p", viewer],
        ["p", viewer, "", "owner"],
      ],
    ].map((entries) => ({ entries })),
  )(
    "rejects malformed or duplicate member entries %j before signing",
    async ({ entries }) => {
      const h = harness();
      h.setEvents([
        ...h.getEvents().filter((event) => event.kind !== 39002),
        h.record(39002, [["d", id], ...entries]),
      ]);
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "Malformed",
      );
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it("validates the complete administrator record, not just the viewer's first match", () => {
    const h = harness();
    h.setEvents([
      h.metadata(),
      h.record(39001, [
        ["d", id],
        ["p", viewer, "owner"],
        ["p", other, "bogus"],
      ]),
      h.record(39002, [
        ["d", id],
        ["p", viewer],
        ["p", other],
      ]),
    ]);
    expect(() =>
      lifecycleSettings(h.getEvents(), id, viewer, relayAuthor),
    ).toThrow("Malformed");
  });
  it.each(["archive", "delete", "leave"] as const)(
    "cannot %s a DM",
    async (action) => {
      const h = harness("owner", "dm");
      await expect(h.owner.capability.run(action, id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it("requires a complete trusted metadata/admin/member response", async () => {
    const h = harness();
    h.setEvents(h.getEvents().slice(0, 2));
    await expect(h.owner.capability.load(id)).rejects.toThrow(
      "could not be verified",
    );
    h.owner.dispose();
  });
  it("rejects a foreign author even with matching coordinates", async () => {
    const h = harness();
    h.setEvents([
      finalizeEvent(
        {
          kind: 39000,
          tags: [
            ["d", id],
            ["t", "stream"],
          ],
          content: "",
          created_at: 1000,
        },
        key,
      ),
      ...h.getEvents().slice(1),
    ]);
    // Deliberately bypass the fixture's author filtering to exercise the guard.
    h.read.mockResolvedValueOnce(h.getEvents());
    await expect(h.owner.capability.load(id)).rejects.toThrow("authority");
    h.owner.dispose();
  });
});

it.each(["archive", "delete", "leave", "hide"] as const)(
  "confirms %s without granting it to the message outbox",
  async (action) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const h = harness("owner", action === "hide" ? "dm" : "stream", 2);
      await h.owner.capability.run(action, id);
      expect(h.publish).toHaveBeenCalledOnce();
      expect(h.sign.mock.calls[0]?.[0]).toEqual(lifecycleTemplate(action, id));
      if (action === "archive")
        expect(h.acceptDiscovery).toHaveBeenCalledOnce();
      else if (action !== "hide") expect(h.removed).toHaveBeenCalledWith(id);
      else {
        expect(h.owner.capability.snapshot().hidden).toEqual([id]);
        expect(h.removed).not.toHaveBeenCalled();
      }
      if (action === "leave") {
        expect(
          h.getEvents().find((event) => event.kind === 39002)?.tags,
        ).toEqual([
          ["d", id],
          ["p", other, "", "owner"],
        ]);
        expect(h.read.mock.calls.at(-1)?.[0]).toEqual([
          {
            kinds: [39002],
            authors: [relayAuthor],
            "#d": [id],
            "#p": [viewer],
            limit: 1,
          },
        ]);
      }
      h.owner.dispose();
    } finally {
      clock.mockRestore();
    }
  },
);

it("rereads authority after signing; a removed admin cannot publish", async () => {
  const h = harness("admin");
  h.sign.mockImplementation(async (event) => {
    h.setEvents([
      h.metadata(),
      h.roles("member"),
      h.record(39002, [
        ["d", id],
        ["p", viewer],
        ["p", other],
      ]),
    ]);
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.run("archive", id)).rejects.toThrow(
    "no longer permitted",
  );
  expect(h.publish).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("fences access loss during signing and rejects a changed timestamp", async () => {
  const h = harness();
  h.sign.mockImplementationOnce(async (event) => {
    h.deny();
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "access unavailable",
  );
  expect(h.publish).not.toHaveBeenCalled();
  h.owner.dispose();
  const g = harness();
  g.sign.mockImplementationOnce(async (event) =>
    finalizeEvent({ ...event, created_at: event.created_at + 1 }, key),
  );
  await expect(g.owner.capability.run("delete", id)).rejects.toThrow(
    "Signer changed",
  );
  expect(g.publish).not.toHaveBeenCalled();
  g.owner.dispose();
});
it.each(["clear", "dispose", "cancel"] as const)(
  "%s stops an in-flight signer even when it ignores abort",
  async (action) => {
    const h = harness();
    const gate = deferred<void>();
    const started = deferred<void>();
    h.sign.mockImplementationOnce(async (event) => {
      started.resolve();
      await gate.promise;
      return finalizeEvent(event, key);
    });
    const run = h.owner.capability.run("delete", id);
    await started.promise;
    h.owner[action]();
    gate.resolve();
    await expect(run).rejects.toThrow();
    expect(h.publish).not.toHaveBeenCalled();
    h.owner.dispose();
  },
);
it("does not infer deletion from a failed confirmation read; retry can recover", async () => {
  const h = harness();
  h.publish.mockImplementationOnce(async () => {
    h.read.mockRejectedValueOnce(new Error("query failed"));
  });
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "query failed",
  );
  expect(h.removed).not.toHaveBeenCalled();
  await h.owner.capability.run("delete", id);
  expect(h.removed).toHaveBeenCalledOnce();
  h.owner.dispose();
});
it("serializes destructive operations without automatic resubmission", async () => {
  const h = harness();
  const gate = deferred<void>();
  const started = deferred<void>();
  h.sign.mockImplementationOnce(async (event) => {
    started.resolve();
    await gate.promise;
    return finalizeEvent(event, key);
  });
  const run = h.owner.capability.run("delete", id);
  await started.promise;
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "in progress",
  );
  gate.resolve();
  await run;
  expect(h.publish).toHaveBeenCalledOnce();
  h.owner.dispose();
});
it("retains the last good visibility on failure and rejects stale snapshots", async () => {
  const h = harness("owner", "dm");
  const stale = h.record(30622, [
    ["d", viewer],
    ["p", viewer],
  ]);
  await h.owner.capability.run("hide", id);
  h.setVisible([stale]);
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot().hidden).toEqual([id]);
  h.read.mockRejectedValueOnce(new Error("offline"));
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "error",
    hidden: [id],
  });
  h.setVisible([
    h.record(30622, [
      ["d", viewer],
      ["p", viewer],
    ]),
  ]);
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "ready",
    hidden: [],
  });
  h.owner.dispose();
});
it("a clear cannot be repopulated by a late visibility response", async () => {
  const h = harness();
  const gate = deferred<RelayEvent[]>();
  h.read.mockImplementationOnce(() => gate.promise);
  const pending = h.owner.capability.refreshVisibility();
  h.owner.clear();
  gate.resolve([
    h.record(30622, [
      ["d", viewer],
      ["p", viewer],
      ["h", id],
    ]),
  ]);
  await pending;
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "idle",
    hidden: [],
  });
  h.owner.dispose();
});
it.each([
  {
    kind: 9002,
    tags: [
      ["h", id],
      ["name", "rename"],
    ],
  },
  {
    kind: 9022,
    tags: [
      ["h", id],
      ["p", other],
    ],
  },
  {
    kind: 9008,
    tags: [
      ["h", id],
      ["h", id],
    ],
  },
  { kind: 41012, tags: [["h", "not-a-channel"]] },
  { kind: 9, tags: [["h", id]] },
])("rejects expanded host authority %#", (changes) => {
  expect(() =>
    validateLifecycleTemplate({ content: "", created_at: 1, ...changes }),
  ).toThrow();
});
it("a signer cannot mutate the input in place to bypass command equality", async () => {
  const h = harness();
  h.sign.mockImplementationOnce(async (event) => {
    event.kind = 9022;
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "Signer changed",
  );
  expect(h.publish).not.toHaveBeenCalled();
  h.owner.dispose();
});

it("distinguishes a rejected publication from an uncertain delivery without replay", async () => {
  const h = harness();
  h.publish.mockRejectedValueOnce(new PublishRejected("permission revoked"));
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "permission revoked",
  );
  expect(h.removed).not.toHaveBeenCalled();
  h.publish.mockRejectedValueOnce(new Error("connection lost"));
  await expect(h.owner.capability.run("delete", id)).rejects.toBeInstanceOf(
    ChannelLifecycleUnconfirmed,
  );
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.removed).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("an accepted command without side effects remains uncertain, never replayed", async () => {
  vi.useFakeTimers();
  const h = harness();
  try {
    h.publish.mockImplementationOnce(async () => {});
    const run = expect(
      h.owner.capability.run("delete", id),
    ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
    await vi.runAllTimersAsync();
    await run;
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.removed).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
    vi.useRealTimers();
  }
});
it("session replacement during publication cannot apply a late completion", async () => {
  const h = harness();
  const started = deferred<void>();
  const gate = deferred<void>();
  h.publish.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
  });
  const run = h.owner.capability.run("delete", id);
  await started.promise;
  h.owner.dispose();
  gate.resolve();
  await expect(run).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
  expect(h.removed).not.toHaveBeenCalled();
  expect(h.acceptDiscovery).not.toHaveBeenCalled();
});
it("reads exact relay-owned coordinates fresh both before sign and before publish", async () => {
  const h = harness();
  await h.owner.capability.run("delete", id);
  const expected = [39000, 39001, 39002].map((kind) => ({
    kinds: [kind],
    authors: [relayAuthor],
    "#d": [id],
    limit: 1,
  }));
  expect(h.read).toHaveBeenNthCalledWith(
    1,
    expected,
    expect.objectContaining({ fresh: true, priority: "foreground" }),
  );
  expect(h.read).toHaveBeenNthCalledWith(
    2,
    expected,
    expect.objectContaining({ fresh: true, priority: "foreground" }),
  );
  h.owner.dispose();
});
it.each([
  [
    ["d", other],
    ["p", viewer],
  ],
  [
    ["d", viewer],
    ["p", other],
  ],
  [
    ["d", viewer],
    ["p", viewer],
    ["h", "invalid"],
  ],
])("invalid DM visibility never hides a conversation %#", async (...tags) => {
  const h = harness("owner", "dm");
  h.setVisible([h.record(30622, tags)]);
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "error",
    hidden: [],
  });
  h.owner.dispose();
});

function ownerTag(target = other, ownerKey = key, conditions = "") {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${target}:${conditions}`)
    .digest();
  return [
    "auth",
    getPublicKey(ownerKey),
    conditions,
    bytesToHex(schnorr.sign(digest, ownerKey)),
  ];
}
function agentProfile(tags = [ownerTag()], created_at = 200) {
  return finalizeEvent(
    {
      kind: 0,
      created_at,
      tags,
      content: JSON.stringify({ name: "Agent", ownerPubkey: viewer }),
    },
    agentKey,
  );
}
describe("direct-owner-only channel Delete", () => {
  it.each(["admin", "member"])(
    "a %s owning an owner-role agent retains base actions but cannot Delete",
    async (role) => {
      const h = harness(role, "stream", 2);
      h.setEvents([...h.getEvents(), agentProfile()]);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canDelete: false,
        canArchive: role === "admin",
        canLeave: true,
      });
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      // No profile or optional authority lookup can gate Archive/Leave.
      expect(h.read.mock.calls).toHaveLength(2);
      for (const [filters] of h.read.mock.calls)
        expect(filters).toEqual(
          [39000, 39001, 39002].map((kind) => ({
            kinds: [kind],
            authors: [relayAuthor],
            "#d": [id],
            limit: 1,
          })),
        );
      await h.owner.capability.run(role === "admin" ? "archive" : "leave", id);
      expect(h.publish).toHaveBeenCalledOnce();
      h.owner.dispose();
    },
  );
  it.each([
    ["missing", []],
    ["display-only", [agentProfile([])]],
    ["valid attestation", [agentProfile()]],
    ["foreign attestation", [agentProfile([ownerTag(other, relayKey)])]],
    ["replaced profile", [agentProfile(), agentProfile([], 201)]],
  ] as const)(
    "%s profile cannot change direct-owner eligibility",
    async (_label, profiles) => {
      for (const role of ["owner", "admin", "member"]) {
        const h = harness(role, "stream", 2);
        h.setEvents([...h.getEvents(), ...profiles]);
        expect((await h.owner.capability.load(id)).canDelete).toBe(
          role === "owner",
        );
        expect(h.read).toHaveBeenCalledOnce();
        expect(
          h.read.mock.calls[0]?.[0].flatMap((filter) => filter.kinds),
        ).toEqual([39000, 39001, 39002]);
        h.owner.dispose();
      }
    },
  );
  it("does not bypass direct-owner membership", async () => {
    const h = harness();
    h.setEvents(
      h.getEvents().map((event) => {
        if (event.kind === 39001)
          return h.record(39001, [
            ["d", id],
            ["p", other, "owner"],
          ]);
        if (event.kind === 39002)
          return h.record(39002, [
            ["d", id],
            ["p", other],
          ]);
        return event;
      }),
    );
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "no longer a channel member",
    );
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it.each(["before signing", "before publication"])(
    "rereads direct ownership %s",
    async (when) => {
      const h = harness("owner", "stream", 2);
      expect((await h.owner.capability.load(id)).canDelete).toBe(true);
      const demote = () =>
        h.setEvents(
          h
            .getEvents()
            .map((event) => (event.kind === 39001 ? h.roles("admin") : event)),
        );
      if (when === "before signing") demote();
      else
        h.sign.mockImplementationOnce(async (event) => {
          demote();
          return finalizeEvent(event, key);
        });
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).toHaveBeenCalledTimes(when === "before signing" ? 0 : 1);
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it.each(["owner", "admin", "member"])(
    "archived %s cannot Delete until restored",
    async (role) => {
      const h = harness(role, "stream", 2);
      const metadata = (archived: boolean) =>
        h.setEvents(
          h
            .getEvents()
            .map((event) =>
              event.kind === 39000 ? h.metadata(archived) : event,
            ),
        );
      metadata(true);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canDelete: false,
        canArchive: false,
        canLeave: true,
      });
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).not.toHaveBeenCalled();
      metadata(false);
      expect((await h.owner.capability.load(id)).canDelete).toBe(
        role === "owner",
      );
      h.owner.dispose();
    },
  );
  it("archiving during signing prevents direct-owner Delete publication", async () => {
    const h = harness();
    h.sign.mockImplementationOnce(async (event) => {
      h.setEvents(
        h
          .getEvents()
          .map((record) => (record.kind === 39000 ? h.metadata(true) : record)),
      );
      return finalizeEvent(event, key);
    });
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "no longer permitted",
    );
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it.each(["clear", "dispose", "cancel", "caller", "access"] as const)(
    "%s fences permission reads even when the host ignores abort",
    async (action) => {
      const h = harness();
      const gate = deferred<RelayEvent[]>(),
        started = deferred<void>();
      const caller = new AbortController();
      h.read.mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      const result = h.owner.capability.run("delete", id, caller.signal);
      await started.promise;
      if (action === "caller") caller.abort();
      else if (action === "access") h.deny();
      else h.owner[action]();
      gate.resolve(h.getEvents());
      await expect(result).rejects.toThrow();
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
});
