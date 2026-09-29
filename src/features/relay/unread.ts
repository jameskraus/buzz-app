import type { ChannelQueries } from "./contracts";
import type { RelayEvent } from "./events";
import {
  effectiveFrontier,
  overrideActive,
  targetKey,
  type ReadTarget,
  type ReadState,
} from "./read-state-model";
import type {
  createReadState,
  ReadMutationResult,
  ReadSyncSnapshot,
} from "./read-state";
import type { Priority, RelayReader } from "./reader";
import { foldMessages } from "./fold";
import { threadReference } from "./thread-reference";

export type UnreadSnapshot = Readonly<{
  target: ReadTarget;
  /** Latest verified content evidence, including read and self-authored messages. */
  latestMessage?: Readonly<{ id: string; createdAt: number }>;
  /** null means unobserved/denied, never a fabricated zero or an exact relay total. */
  observedCount: number | null;
  attentionCount: number | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  manual: "none" | "local-only" | "remote";
  error?: string | undefined;
}>;
export type MessageAttention = Readonly<{
  status: "unknown" | "ineligible" | "eligible";
  category?: "mention" | "direct" | "thread";
  /** The event explicitly p-tags the viewer, even inside DM channels. */
  mentioned?: boolean;
  rootId?: string;
  unread: boolean;
  /** This row is explicitly forced unread during the current channel visit. */
  forced: boolean;
  viewing: boolean;
}>;
export type ThreadActivityItem = Readonly<{
  channelId: string;
  rootId: string;
  latestMessageId: string;
  authorId: string;
  createdAt: number;
  preview: string;
  unreadCount: number;
}>;
export type ThreadActivitySnapshot = Readonly<{
  channelId: string;
  /** null means activity evidence is unknown or access is denied. */
  items: readonly ThreadActivityItem[] | null;
  coverage: "unknown" | "observed";
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
export type ReadingHandle = Readonly<{
  /** Qualified visible rows only. This publishes no read intent and ends with the lease. */
  view(messageIds: readonly string[], visible: () => boolean): void;
  /** Only message IDs actually visible to the active consumer; no caller timestamps. */
  observe(messageIds: readonly string[]): Promise<void>;
  dispose(): void;
}>;
export interface UnreadCapability {
  snapshot(target: ReadTarget): UnreadSnapshot;
  /** Same verified attention/frontier policy as badges, not a notification event source. */
  attention(channelId: string, messageId: string): MessageAttention;
  subscribe(target: ReadTarget, listener: () => void): () => void;
  activity(channelId: string): ThreadActivitySnapshot;
  subscribeActivity(channelId: string, listener: () => void): () => void;
  sync(): ReadSyncSnapshot;
  subscribeSync(listener: () => void): () => void;
  ensure(): Promise<void>;
  refresh(): Promise<void>;
  retrySync(): Promise<void>;
  reading(channelId: string): ReadingHandle;
  /** Explicit prefix intent, unlike individual-message visibility observations. */
  markThrough(
    target: ReadTarget,
    messageId: string,
  ): Promise<ReadMutationResult>;
  /** One immediate menu action over the selected verified message and loaded reply subtree. */
  markMessageUnread(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  markMessageRead(
    channelId: string,
    messageId: string,
  ): Promise<ReadMutationResult>;
  /** End the channel visit; the device-local sidebar force remains until next open. */
  leaveChannel(channelId: string): void;
  /** Reconcile the previous visit's sidebar force without clearing independent channel intent. */
  enterChannel(channelId: string): Promise<void>;
  /** Explicit channel prefix through retained verified evidence, including replies. */
  markChannelRead(channelId: string): Promise<ReadMutationResult>;
  /** `markChannelRead` serialised over every accessible listed channel that still
   * shows unread evidence or a local mark. Channels with nothing to clear are
   * skipped, so an already-read community costs no writes. One failing channel
   * does not stop the rest; the first failure is rethrown after the sweep. */
  markAllChannelsRead(): Promise<readonly ReadMutationResult[]>;
  markUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  clearUnreadLocal(target: ReadTarget): Promise<ReadMutationResult>;
  readonly syncedManualUnread: false;
}
const contentKind = (event: RelayEvent) =>
  event.kind === 9 || event.kind === 40002 || event.kind === 40008;
const channelOf = (event: RelayEvent) => {
  const tags = event.tags.filter(([name]) => name === "h");
  return tags.length === 1 ? tags[0]?.[1] : undefined;
};
const auxiliaryKind = (event: RelayEvent) =>
  event.kind === 40003 || event.kind === 5 || event.kind === 9005;
/** Resolve every owning channel through bounded reference-only auxiliary ancestry.
 * A missing target, cycle, or unsupported intermediary fails closed. */
function channelOwnership(find: (id: string) => RelayEvent | undefined) {
  const memo = new Map<string, ReadonlySet<string> | undefined>();
  const visiting = new Set<string>();
  function owners(event: RelayEvent): ReadonlySet<string> | undefined {
    if (memo.has(event.id)) return memo.get(event.id);
    if (visiting.has(event.id) || visiting.size >= 32) return;
    visiting.add(event.id);
    const direct = channelOf(event);
    let resolved: Set<string> | undefined;
    if (contentKind(event)) {
      if (direct) resolved = new Set([direct]);
    } else if (auxiliaryKind(event)) {
      resolved = direct ? new Set([direct]) : new Set();
      const targets = event.tags.flatMap(([name, id]) =>
        name === "e" && id ? [id] : [],
      );
      if (!direct && !targets.length) resolved = undefined;
      for (const id of targets) {
        const target = find(id);
        const inherited = target && owners(target);
        if (!inherited) {
          resolved = undefined;
          break;
        }
        for (const channel of inherited) resolved?.add(channel);
      }
      if (!resolved?.size) resolved = undefined;
    }
    visiting.delete(event.id);
    memo.set(event.id, resolved);
    return resolved;
  }
  return owners;
}
/** Bounded verified evidence and one projection; no sidebar counters, sockets or implicit reads. */
export function createUnread({
  reads,
  channels,
  reader,
  viewer,
  notify = (listener) => listener(),
}: {
  reads: ReturnType<typeof createReadState>;
  channels: ChannelQueries;
  reader: RelayReader;
  viewer: string;
  notify?: (listener: () => void) => void;
}) {
  let closed = false,
    epoch = 0;
  let requested = false;
  let repairAgain = false;
  let freshness: UnreadSnapshot["freshness"] = "unknown";
  let error: string | undefined;
  let refresh: Promise<void> | undefined;
  const lifetime = new AbortController();
  const events = new Map<string, RelayEvent>();
  const known = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new Map<string, UnreadSnapshot>();
  const dirty = new Set<string>();
  const activityListeners = new Map<string, Set<() => void>>();
  const activitySnapshots = new Map<string, ThreadActivitySnapshot>();
  const activityDirty = new Set<string>();
  const handles = new Set<() => void>();
  const views = new Map<
    () => void,
    { ids: ReadonlySet<string>; visible: () => boolean }
  >();
  // Per-visit message overlay; only the sidebar hint is persisted in read state.
  const forcedMessages = new Map<string, Set<string>>();
  const entered = new Set<string>();
  const messageForceKey = (channelId: string) => `message-force:${channelId}`;
  const visits = new Map<string, number>();
  const mutations = new Map<string, Promise<unknown>>();
  function serialize<T>(
    channelId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = mutations.get(channelId) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    mutations.set(channelId, settled);
    void settled.then(() => {
      if (mutations.get(channelId) === settled) mutations.delete(channelId);
    });
    return next;
  }

  let bytes = 0;
  const allowed = (id: string) =>
    channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === id &&
          !channel.cached &&
          channel.members?.includes(viewer),
      );
  const keyFor = (target: ReadTarget) =>
    `${target.channelId}:${targetKey(target)}`;
  function root(event: RelayEvent): string | undefined {
    const channel = channelOf(event);
    let current = event;
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(current.id)) return;
      seen.add(current.id);
      const reference = threadReference(current);
      if (!reference) return current.id;
      const next = events.get(reference.rootId);
      if (!next || !contentKind(next) || channelOf(next) !== channel) return;
      current = next;
    }
  }
  type Evidence = {
    event: RelayEvent;
    rootId: string | undefined;
    mentioned: boolean;
  };
  let indexed = false;
  const byChannel = new Map<string, Evidence[]>();
  const tombstones = new Set<string>();
  const participants = new Set<string>();
  function indexEvidence() {
    if (indexed) return;
    indexed = true;
    byChannel.clear();
    tombstones.clear();
    participants.clear();
    for (const event of events.values()) {
      if (event.kind !== 5 && event.kind !== 9005) continue;
      for (const [name, id] of event.tags)
        if (name === "e" && id && events.get(id)?.pubkey === event.pubkey)
          tombstones.add(id);
    }
    for (const event of events.values()) {
      if (!contentKind(event) || tombstones.has(event.id)) continue;
      const channel = channelOf(event);
      if (!channel) continue;
      const rootId = root(event);
      if (event.pubkey === viewer && rootId) participants.add(rootId);
      const rows = byChannel.get(channel) ?? [];
      rows.push({
        event,
        rootId: threadReference(event) ? rootId : undefined,
        mentioned: event.tags.some(
          ([name, value]) => name === "p" && value === viewer,
        ),
      });
      byChannel.set(channel, rows);
    }
  }
  function deleted(event: RelayEvent): boolean {
    indexEvidence();
    return tombstones.has(event.id);
  }
  function inTarget(event: RelayEvent, target: ReadTarget) {
    return (
      channelOf(event) === target.channelId &&
      (target.kind === "channel" ||
        (target.kind === "message" && target.messageId === event.id) ||
        (target.kind === "thread" &&
          !!threadReference(event) &&
          root(event) === target.rootId))
    );
  }
  function isUnread({ event, rootId }: Evidence, state: ReadState) {
    const channelId = channelOf(event);
    if (!channelId || event.pubkey === viewer) return false;
    const frontier = effectiveFrontier(
      state,
      `msg:${event.id}`,
      channelId,
      rootId,
    );
    const forced =
      overrideActive(state.overrides[`msg:${event.id}`], frontier) ||
      overrideActive(
        state.overrides[channelId],
        effectiveFrontier(state, channelId),
      ) ||
      (rootId !== undefined &&
        overrideActive(
          state.overrides[`thread:${rootId}`],
          effectiveFrontier(state, `thread:${rootId}`, channelId),
        ));
    return (
      forcedMessages.get(channelId)?.has(event.id) ||
      !!reads.localUnread(`msg:${event.id}`) ||
      frontier === undefined ||
      event.created_at > frontier ||
      !!forced
    );
  }
  function category(
    { rootId, mentioned }: Evidence,
    dm: boolean,
  ): MessageAttention["category"] {
    // DM events p-tag the recipient, so a mention check would classify every
    // direct message as a mention. Direct wins inside DM channels.
    return dm
      ? "direct"
      : mentioned
        ? "mention"
        : rootId && participants.has(rootId)
          ? "thread"
          : undefined;
  }
  function priority(entry: Evidence, dm: boolean) {
    return (
      !!category(entry, dm) ||
      entry.event.tags.some(
        ([name, value]) => name === "broadcast" && value === "1",
      )
    );
  }
  function attention(channelId: string, messageId: string): MessageAttention {
    const unknown = Object.freeze({
      status: "unknown",
      unread: false,
      forced: false,
      viewing: false,
    } as const);
    if (closed || !allowed(channelId)) return unknown;
    indexEvidence();
    const event = events.get(messageId);
    if (!event || channelOf(event) !== channelId || !contentKind(event))
      return unknown;
    const entry = byChannel
      .get(channelId)
      ?.find((row) => row.event.id === messageId);
    if (!entry || event.pubkey === viewer)
      return Object.freeze({
        status: "ineligible",
        unread: false,
        forced: forcedMessages.get(channelId)?.has(messageId) ?? false,
        viewing: false,
      });
    const dm =
      channels.list().channels.find((channel) => channel.id === channelId)
        ?.channelType === "dm";
    const kind = category(entry, dm);
    const viewing = [...views.values()].some(
      (view) => view.ids.has(messageId) && view.visible(),
    );
    return Object.freeze({
      status: kind
        ? "eligible"
        : threadReference(event) && !entry.rootId
          ? "unknown"
          : "ineligible",
      ...(kind ? { category: kind } : {}),
      ...(entry.mentioned ? { mentioned: true } : {}),
      ...(entry.rootId ? { rootId: entry.rootId } : {}),
      unread: isUnread(entry, reads.state()),
      forced: forcedMessages.get(channelId)?.has(messageId) ?? false,
      viewing,
    });
  }
  function compute(target: ReadTarget): UnreadSnapshot {
    const key = targetKey(target);
    const accessible =
      allowed(target.channelId) &&
      (target.kind === "channel" ||
        (() => {
          const event = events.get(
            target.kind === "thread" ? target.rootId : target.messageId,
          );
          return (
            !!event &&
            channelOf(event) === target.channelId &&
            contentKind(event)
          );
        })());
    if (!accessible)
      return Object.freeze({
        target,
        observedCount: null,
        attentionCount: null,
        coverage: "unknown",
        freshness: "unknown",
        manual: "none",
      });
    const evidence = known.has(target.channelId);
    const state = reads.state();
    let count = 0,
      attention = 0;
    const dm =
      channels
        .list()
        .channels.find((channel) => channel.id === target.channelId)
        ?.channelType === "dm";
    indexEvidence();
    let latest: RelayEvent | undefined;
    for (const entry of byChannel.get(target.channelId) ?? []) {
      const event = entry.event;
      if (
        target.kind === "channel" &&
        (!latest ||
          event.created_at > latest.created_at ||
          (event.created_at === latest.created_at && event.id < latest.id))
      )
        latest = event;
      if (!inTarget(entry.event, target) || !isUnread(entry, state)) continue;
      count++;
      if (priority(entry, dm)) attention++;
    }
    const manual = reads.localUnread(key)
      ? "local-only"
      : target.kind === "message" &&
          forcedMessages.get(target.channelId)?.has(target.messageId)
        ? "local-only"
        : target.kind === "channel" &&
            reads.localUnread(messageForceKey(target.channelId))
          ? "local-only"
          : overrideActive(
                state.overrides[key],
                effectiveFrontier(state, key, target.channelId),
              )
            ? "remote"
            : "none";
    return Object.freeze({
      target,
      ...(latest
        ? { latestMessage: { id: latest.id, createdAt: latest.created_at } }
        : {}),
      observedCount: evidence ? count : null,
      attentionCount: evidence ? attention : null,
      coverage: evidence ? "observed" : "unknown",
      freshness,
      manual,
      ...(error ? { error } : {}),
    });
  }
  const equal = (a: UnreadSnapshot, b: UnreadSnapshot) =>
    a.latestMessage?.id === b.latestMessage?.id &&
    a.observedCount === b.observedCount &&
    a.attentionCount === b.attentionCount &&
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.manual === b.manual &&
    a.error === b.error;
  function computeActivity(channelId: string): ThreadActivitySnapshot {
    if (!allowed(channelId) || !known.has(channelId))
      return Object.freeze({
        channelId,
        items: null,
        coverage: "unknown",
        freshness: "unknown",
      });
    indexEvidence();
    const state = reads.state();
    const grouped = new Map<string, ThreadActivityItem>();
    const presented = new Map(
      foldMessages(channelId, "", [...events.values()], {
        includeReplies: true,
      }).map((message) => [message.id, message.content]),
    );
    for (const evidence of byChannel.get(channelId) ?? []) {
      const { event, rootId, mentioned } = evidence;
      const broadcast = event.tags.some(
        ([name, value]) => name === "broadcast" && value === "1",
      );
      if (
        !rootId ||
        (!mentioned && !broadcast && !participants.has(rootId)) ||
        !isUnread(evidence, state)
      )
        continue;
      const current = grouped.get(rootId);
      const preview = presented.get(event.id) ?? event.content;
      if (!current) {
        grouped.set(
          rootId,
          Object.freeze({
            channelId,
            rootId,
            latestMessageId: event.id,
            authorId: event.pubkey,
            createdAt: event.created_at,
            preview,
            unreadCount: 1,
          }),
        );
        continue;
      }
      const latest =
        event.created_at > current.createdAt ||
        (event.created_at === current.createdAt &&
          event.id < current.latestMessageId);
      grouped.set(
        rootId,
        Object.freeze({
          channelId,
          rootId,
          latestMessageId: latest ? event.id : current.latestMessageId,
          authorId: latest ? event.pubkey : current.authorId,
          createdAt: latest ? event.created_at : current.createdAt,
          preview: latest ? preview : current.preview,
          unreadCount: current.unreadCount + 1,
        }),
      );
    }
    return Object.freeze({
      channelId,
      items: Object.freeze(
        [...grouped.values()].sort(
          (a, b) =>
            b.createdAt - a.createdAt ||
            a.latestMessageId.localeCompare(b.latestMessageId),
        ),
      ),
      coverage: "observed",
      freshness,
      ...(error ? { error } : {}),
    });
  }
  const equalActivity = (
    a: ThreadActivitySnapshot,
    b: ThreadActivitySnapshot,
  ) =>
    a.coverage === b.coverage &&
    a.freshness === b.freshness &&
    a.error === b.error &&
    ((a.items === null && b.items === null) ||
      (a.items !== null &&
        b.items !== null &&
        a.items.length === b.items.length &&
        a.items.every((item, index) => {
          const other = b.items?.[index];
          return (
            item.rootId === other?.rootId &&
            item.latestMessageId === other.latestMessageId &&
            item.authorId === other.authorId &&
            item.createdAt === other.createdAt &&
            item.preview === other.preview &&
            item.unreadCount === other.unreadCount
          );
        })));
  function activity(channelId: string) {
    const previous = activitySnapshots.get(channelId);
    if (previous && !activityDirty.delete(channelId)) return previous;
    const value = computeActivity(channelId);
    if (previous && equalActivity(previous, value)) return previous;
    activitySnapshots.set(channelId, value);
    return value;
  }
  function snapshot(target: ReadTarget) {
    const key = keyFor(target),
      previous = snapshots.get(key);
    if (previous && !dirty.delete(key)) return previous;
    const value = compute(previous?.target ?? Object.freeze({ ...target }));
    if (previous && equal(previous, value)) return previous;
    if (!previous && snapshots.size >= 4096) {
      for (const key of snapshots.keys())
        if (!listeners.has(key)) {
          snapshots.delete(key);
          dirty.delete(key);
        }
      if (snapshots.size >= 4096)
        throw new Error("Unread selector capacity reached");
    }
    snapshots.set(key, value);
    return value;
  }
  function addActivityListener(channelId: string, listener: () => void) {
    activity(channelId);
    const set = activityListeners.get(channelId) ?? new Set();
    set.add(listener);
    activityListeners.set(channelId, set);
    return () => {
      set.delete(listener);
      if (!set.size) activityListeners.delete(channelId);
    };
  }
  function publish(channelIds?: ReadonlySet<string>) {
    if (closed) return;
    const changed: string[] = [];
    const changedActivity: string[] = [];
    for (const [key, old] of snapshots) {
      if (channelIds && !channelIds.has(old.target.channelId)) continue;
      // Revisit dormant selectors lazily, retaining identity if unchanged.
      if (!listeners.has(key)) {
        dirty.add(key);
        continue;
      }
      const next = compute(old.target);
      if (!equal(old, next)) {
        snapshots.set(key, next);
        changed.push(key);
      }
    }
    for (const [channelId, old] of activitySnapshots) {
      if (channelIds && !channelIds.has(channelId)) continue;
      if (!activityListeners.has(channelId)) {
        activityDirty.add(channelId);
        continue;
      }
      const next = computeActivity(channelId);
      if (!equalActivity(old, next)) {
        activitySnapshots.set(channelId, next);
        changedActivity.push(channelId);
      }
    }
    // Replace/invalidate ALL affected projections before any reentrant callback.
    for (const key of changed)
      for (const listener of listeners.get(key) ?? []) notify(listener);
    for (const channelId of changedActivity)
      for (const listener of activityListeners.get(channelId) ?? [])
        notify(listener);
  }
  const stopRead = reads.subscribe(publish);
  function purge() {
    // A revoke/regrant must not revive a transaction accepted under the old access epoch.
    epoch++;
    const denied = new Set(
      [...known, ...forcedMessages.keys()].filter(
        (channel) => !allowed(channel),
      ),
    );
    for (const channel of denied) {
      known.delete(channel);
      forcedMessages.delete(channel);
      entered.delete(channel);
    }
    const retained = new Map(events);
    const owners = channelOwnership((targetId) => retained.get(targetId));
    for (const [id, event] of retained) {
      const channels = owners(event);
      if (!channels || [...channels].some((channel) => !allowed(channel)))
        events.delete(id);
    }
    indexed = false;
    // Reference-only tombstones are retained only with a still-accessible target.
    bytes = [...events.values()].reduce(
      (total, event) =>
        total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
      0,
    );
    publish();
  }
  // Names/previews do not affect unread. Read membership once, without a
  // roster scan for every channel, and retain only the invalidation inputs.
  const types = (list: ReturnType<ChannelQueries["list"]>) =>
    new Map(
      list.channels
        .filter(
          (channel) => !channel.cached && channel.members?.includes(viewer),
        )
        .map((channel) => [channel.id, channel.channelType]),
    );
  const cachedIds = (list: ReturnType<ChannelQueries["list"]>) =>
    new Set(
      list.channels
        .filter((channel) => channel.cached)
        .map((channel) => channel.id),
    );
  const initialList = channels.list();
  let cachedChannels = cachedIds(initialList);
  let channelTypes = types(initialList);
  let accessKey = [...channelTypes.keys()].sort().join(",");
  const stopChannels = channels.subscribeList(() => {
    const list = channels.list();
    const nextTypes = types(list);
    const next = [...nextTypes.keys()].sort().join(",");
    const changed = new Set(
      [...nextTypes].flatMap(([id, type]) =>
        channelTypes.get(id) !== type ? [id] : [],
      ),
    );
    const confirmed = [...nextTypes.keys()].some((id) =>
      cachedChannels.has(id),
    );
    cachedChannels = cachedIds(list);
    channelTypes = nextTypes;
    if (next === accessKey) {
      if (changed.size) publish(changed);
    } else {
      accessKey = next;
      purge();
      // An initial observation made against a display-only roster still owes
      // evidence when membership becomes fresh, including during an active repair.
      if (requested && confirmed) {
        repairAgain = true;
        if (!refresh) void repair();
      }
    }
  });
  async function repair(priority: Priority = "foreground") {
    requested = true;
    if (closed) return;
    if (refresh) return refresh;
    repairAgain = false;
    const generation = epoch;
    refresh = (async () => {
      await reads.ensure();
      if (closed || generation !== epoch) return;
      const ids = channels
        .list()
        .channels.filter(
          (channel) => !channel.cached && channel.members?.includes(viewer),
        )
        .map((channel) => channel.id);
      if (!ids.length) return;
      try {
        // The relay caps aggregate explicit #h values at 128 per request.
        // Keep roster scope: an unscoped read also includes unjoined open channels.
        // Each bounded batch owns its queue-inclusive deadline after marker sync;
        // optional profiles must not block the initial user-visible observation.
        for (let offset = 0; offset < ids.length; offset += 128) {
          const signal = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(10000),
          ]);
          const result = await reader.read(
            [
              {
                kinds: [9, 40002, 40008],
                "#h": ids.slice(offset, offset + 128),
                include_aux: true,
                limit: 500,
              },
            ],
            { signal, priority },
          );
          if (closed || generation !== epoch) return;
          if (!accept(result) || closed || generation !== epoch) return;
        }
        freshness = "observed";
        error = undefined;
        publish();
      } catch (cause) {
        if (closed || generation !== epoch) return;
        freshness = "stale";
        error =
          cause instanceof Error ? cause.message : "Unread observation failed";
        publish();
      }
    })().finally(() => {
      refresh = undefined;
      if (!closed && repairAgain) void repair();
    });
    return refresh;
  }
  function accept(batch: readonly RelayEvent[]) {
    if (closed) return false;
    const changed = new Set<string>();
    indexed = false;
    const incoming = new Map(batch.map((event) => [event.id, event]));
    const owners = channelOwnership((id) => incoming.get(id) ?? events.get(id));
    for (const event of batch) {
      if (
        ![9, 40002, 40008, 40003, 5, 9005].includes(event.kind) ||
        events.has(event.id)
      )
        continue;
      const channels = owners(event);
      if (!channels || [...channels].some((channel) => !allowed(channel)))
        continue;
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (events.size >= 4096 || bytes + size > 8 * 1024 * 1024) {
        events.clear();
        known.clear();
        bytes = 0;
        error = "Unread observation capacity reached; refresh available";
        freshness = "stale";
        publish();
        return false;
      }
      events.set(event.id, event);
      bytes += size;
      for (const channel of channels) {
        known.add(channel);
        changed.add(channel);
      }
      // The recursively resolved owner set already includes every activity
      // projection affected by a deletion, including delete-of-edit chains.
    }
    if (changed.size) {
      const global = freshness !== "observed";
      freshness = "observed";
      publish(global ? undefined : changed);
    }
    return true;
  }
  function requireMessage(target: ReadTarget, id: string) {
    targetKey(target);
    const event = events.get(id);
    if (
      closed ||
      !allowed(target.channelId) ||
      !event ||
      !contentKind(event) ||
      deleted(event) ||
      channelOf(event) !== target.channelId
    )
      throw new Error("Verified readable message evidence unavailable");
    if (
      (target.kind === "thread" && root(event) !== target.rootId) ||
      (target.kind === "message" && target.messageId !== id)
    )
      throw new Error("Message does not belong to the read target");
    if (
      target.kind === "channel" &&
      threadReference(event) &&
      !event.tags.some(([name, value]) => name === "broadcast" && value === "1")
    )
      throw new Error("A thread reply cannot advance the channel frontier");
    return event;
  }
  function messageSubtree(channelId: string, messageId: string) {
    const selected = requireMessage(
      { kind: "message", channelId, messageId },
      messageId,
    );
    indexEvidence();
    const children = new Map<string, string[]>();
    for (const { event } of byChannel.get(channelId) ?? []) {
      const parent = threadReference(event)?.parentId;
      if (!parent || event.id === selected.id || !root(event)) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(event.id);
      children.set(parent, siblings);
    }
    const ids = new Set<string>([messageId]);
    const stack = [messageId];
    while (stack.length) {
      const parent = stack.pop();
      if (!parent) break;
      for (const id of children.get(parent) ?? []) {
        if (ids.has(id)) continue;
        ids.add(id);
        stack.push(id);
      }
    }
    return [...ids].flatMap((id) => {
      const event = events.get(id);
      return event ? [event] : [];
    });
  }
  const capability: UnreadCapability = Object.freeze<UnreadCapability>({
    snapshot,
    attention,
    subscribe(target, listener) {
      snapshot(target);
      const key = keyFor(target),
        set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    activity,
    subscribeActivity: addActivityListener,
    sync: reads.snapshot,
    subscribeSync: reads.subscribe,
    ensure: () => refresh ?? (requested ? Promise.resolve() : repair()),
    refresh: async () => {
      await reads.refresh("foreground");
      await repair();
    },
    retrySync: async () => {
      await reads.refresh();
      await reads.flush();
    },
    syncedManualUnread: false,
    reading(channelId) {
      if (closed || !allowed(channelId) || handles.size >= 64)
        throw new Error("Reading handle unavailable");
      let active = true;
      const generation = epoch;
      const manualRevision = reads.revision();
      const observed = new Set<string>();
      const dispose = () => {
        active = false;
        handles.delete(dispose);
        views.delete(dispose);
      };
      const valid = () =>
        active &&
        !closed &&
        generation === epoch &&
        allowed(channelId) &&
        (reads.localUnread(channelId) ?? 0) <= manualRevision;
      handles.add(dispose);
      return Object.freeze({
        dispose,
        view(ids: readonly string[], visible: () => boolean) {
          if (!valid() || ids.length > 128) return;
          const verified = ids.filter((id) => {
            try {
              requireMessage({ kind: "message", channelId, messageId: id }, id);
              return true;
            } catch {
              return false;
            }
          });
          views.set(dispose, {
            ids: new Set(verified),
            visible: () => valid() && visible(),
          });
        },
        async observe(ids: readonly string[]) {
          if (!valid() || ids.length > 128) return;
          for (const id of ids) {
            if (!valid() || observed.has(id)) continue;
            const target = {
              kind: "message" as const,
              channelId,
              messageId: id,
            };
            const event = requireMessage(target, id);
            if (
              (effectiveFrontier(
                reads.state(),
                targetKey(target),
                channelId,
                threadReference(event) ? root(event) : undefined,
              ) ?? -1) >= event.created_at
            ) {
              observed.add(id);
              continue;
            }
            await reads.read(
              targetKey(target),
              event.created_at,
              () => valid() && requireMessage(target, id) === event,
            );
            observed.add(id);
          }
        },
      });
    },
    async markThrough(target, id) {
      const event = requireMessage(target, id),
        generation = epoch;
      return serialize(target.channelId, () =>
        reads.read(
          targetKey(target),
          event.created_at,
          () =>
            !closed &&
            generation === epoch &&
            requireMessage(target, id) === event,
          true,
        ),
      );
    },
    async markMessageUnread(channelId, messageId) {
      const visit = visits.get(channelId) ?? 0;
      const rows = messageSubtree(channelId, messageId);
      const generation = epoch;
      return serialize(channelId, async () => {
        const valid = () =>
          !closed &&
          generation === epoch &&
          (visits.get(channelId) ?? 0) === visit &&
          allowed(channelId) &&
          rows.every((row) => events.get(row.id) === row && !deleted(row));
        if (!valid()) throw new Error("Unread channel visit expired");
        const result = await reads.markLocalUnread(
          messageForceKey(channelId),
          valid,
        );
        // A leave after persistence must not restore a previous visit's overlay.
        if (valid()) {
          const forced = forcedMessages.get(channelId) ?? new Set<string>();
          for (const row of rows) forced.add(row.id);
          forcedMessages.set(channelId, forced);
          publish(new Set([channelId]));
        }
        return result;
      });
    },
    async markMessageRead(channelId, messageId) {
      const visit = visits.get(channelId) ?? 0;
      const rows = messageSubtree(channelId, messageId);
      const generation = epoch;
      return serialize(channelId, async () => {
        const valid = () =>
          !closed &&
          generation === epoch &&
          (visits.get(channelId) ?? 0) === visit &&
          allowed(channelId) &&
          rows.every((row) => events.get(row.id) === row && !deleted(row));
        if (!valid()) throw new Error("Unread channel visit expired");
        const forced = forcedMessages.get(channelId);
        const ids = new Set(rows.map((row) => row.id));
        const remaining = forced && [...forced].some((id) => !ids.has(id));
        const result = await reads.readMessages(
          rows
            .filter((row) => row.pubkey !== viewer)
            .map((row) => ({
              key: `msg:${row.id}`,
              timestamp: row.created_at,
              channelId,
              ...(threadReference(row) && root(row)
                ? { rootId: root(row) }
                : {}),
            })),
          remaining ? undefined : messageForceKey(channelId),
          valid,
        );
        if (valid()) {
          for (const row of rows) forced?.delete(row.id);
          if (!forced?.size) forcedMessages.delete(channelId);
          publish(new Set([channelId]));
        }
        return result;
      });
    },
    leaveChannel(channelId) {
      visits.set(channelId, (visits.get(channelId) ?? 0) + 1);
      if (forcedMessages.delete(channelId)) publish(new Set([channelId]));
      entered.delete(channelId);
    },
    enterChannel(channelId) {
      const visit = visits.get(channelId) ?? 0;
      return serialize(channelId, async () => {
        await reads.ready;
        if (entered.has(channelId)) return;
        const valid = () =>
          !closed &&
          allowed(channelId) &&
          (visits.get(channelId) ?? 0) === visit;
        if (!valid()) throw new Error("Unread channel visit expired");
        // A prior visit's message force is reconciled on open; independent channel intent remains.
        if (reads.localUnread(messageForceKey(channelId)))
          await reads.clearLocalUnread(
            messageForceKey(channelId),
            [messageForceKey(channelId)],
            valid,
          );
        if (valid()) entered.add(channelId);
      });
    },
    async markChannelRead(channelId) {
      if (closed || !allowed(channelId))
        throw new Error("Read target unavailable");
      indexEvidence();
      const rows = byChannel.get(channelId) ?? [];
      // Snapshot the cut at invocation, not after a queued storage write. Do not
      // substitute wall time or a preview timestamp for verified domain evidence.
      const latest = rows.reduce<RelayEvent | undefined>(
        (head, { event }) =>
          !head || event.created_at > head.created_at ? event : head,
        undefined,
      );
      const keys = new Set([channelId, messageForceKey(channelId)]);
      for (const { event, rootId } of rows) {
        keys.add(`msg:${event.id}`);
        if (rootId) keys.add(`thread:${rootId}`);
        // A retained top-level message establishes its thread's channel even
        // when that thread's replies are outside our bounded evidence window.
        if (!threadReference(event)) keys.add(`thread:${event.id}`);
      }
      const generation = epoch;
      const valid = () => !closed && generation === epoch && allowed(channelId);
      return serialize(channelId, async () => {
        const result = latest
          ? await reads.read(channelId, latest.created_at, valid, true, [
              ...keys,
            ])
          : await reads.clearLocalUnread(channelId, [...keys], valid);
        if (valid() && forcedMessages.delete(channelId))
          publish(new Set([channelId]));
        return result;
      });
    },
    async markAllChannelsRead() {
      if (closed) throw new Error("Read target unavailable");
      // Decide the sweep from the list at invocation; channels granted later wait
      // for the next explicit action, like arrivals after a per-channel cut.
      const pending = channels
        .list()
        .channels.filter((channel) => allowed(channel.id))
        .map((channel) => channel.id)
        .filter((channelId) => {
          const current = compute({ kind: "channel", channelId });
          return (current.observedCount ?? 0) > 0 || current.manual !== "none";
        });
      const results: ReadMutationResult[] = [];
      let failure: unknown;
      let failed = false;
      for (const channelId of pending) {
        // A grant revoked while earlier channels were written is no failure of
        // the sweep: like a grant that arrives mid-sweep, it waits for the next
        // explicit action rather than surfacing as an error.
        if (!allowed(channelId)) continue;
        try {
          results.push(await capability.markChannelRead(channelId));
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
      if (failed) throw failure;
      return results;
    },
    async markUnreadLocal(target) {
      const key = targetKey(target);
      const generation = epoch;
      const valid = () => {
        if (closed || generation !== epoch || !allowed(target.channelId))
          return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      return serialize(target.channelId, () =>
        reads.markLocalUnread(key, valid),
      );
    },
    async clearUnreadLocal(target) {
      const key = targetKey(target);
      const generation = epoch;
      const valid = () => {
        if (closed || generation !== epoch || !allowed(target.channelId))
          return false;
        if (target.kind !== "channel")
          requireMessage(
            target,
            target.kind === "thread" ? target.rootId : target.messageId,
          );
        return true;
      };
      if (!valid()) throw new Error("Unread target unavailable");
      return serialize(target.channelId, () =>
        reads.clearLocalUnread(key, [key], valid),
      );
    },
  });
  return {
    capability,
    // Private session evidence lookup; never seeds timeline windows or grants access.
    // Reference-only auxiliaries inherit every owning channel through the same
    // bounded, fail-closed ancestry used for retention.
    event(id: string) {
      if (closed) return;
      const event = events.get(id);
      if (!event) return;
      const owners = channelOwnership((targetId) => events.get(targetId))(
        event,
      );
      return owners && [...owners].every(allowed) ? event : undefined;
    },
    accept,
    purge,
    reconnect() {
      if (requested) void reads.refresh().then(() => repair("background"));
    },
    stale() {
      epoch++;
      freshness = "stale";
      reads.stale();
      publish();
    },
    clear() {
      epoch++;
      repairAgain = false;
      indexed = false;
      events.clear();
      known.clear();
      forcedMessages.clear();
      entered.clear();
      bytes = 0;
      freshness = "unknown";
      error = undefined;
      publish();
    },
    dispose() {
      closed = true;
      epoch++;
      lifetime.abort();
      for (const stop of [...handles]) stop();
      stopRead();
      stopChannels();
      listeners.clear();
      snapshots.clear();
      dirty.clear();
      activityListeners.clear();
      activitySnapshots.clear();
      activityDirty.clear();
      events.clear();
      forcedMessages.clear();
      entered.clear();
      reads.dispose();
    },
  };
}
