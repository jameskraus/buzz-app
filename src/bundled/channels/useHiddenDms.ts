import { useCallback, useEffect, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { isMessageKind, MESSAGE_KINDS } from "../../features/relay/kinds";
import type { ChannelList } from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";

type MessageHead = Readonly<{ id: string; createdAt: number }>;
type HiddenDm = {
  id: string;
  // Keeps one hide identifiable through enrichment; JSON persistence omits it.
  hideGeneration: symbol;
  baseline?: MessageHead | null;
  knownIds?: readonly string[];
};
const key = "hidden-dms";

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function restore(scope: string): HiddenDm[] {
  const saved = readView<unknown>(scope, key, []);
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string")
      return [];
    const baseline = entry.baseline;
    const knownIds = entry.knownIds;
    return [
      {
        id: entry.id,
        hideGeneration: Symbol(),
        ...(baseline === null ||
        (baseline &&
          typeof baseline === "object" &&
          typeof baseline.id === "string" &&
          typeof baseline.createdAt === "number" &&
          Number.isFinite(baseline.createdAt))
          ? { baseline }
          : {}),
        ...(Array.isArray(knownIds) &&
        knownIds.every((id): id is string => typeof id === "string")
          ? { knownIds }
          : {}),
      },
    ];
  });
}

/** Local, viewer-scoped sidebar intent; verified message evidence restores a row. */
export function useHiddenDms(
  scope: string,
  session: RelaySession,
  list: ChannelList,
) {
  const [hidden, setHidden] = useState(() => restore(scope));
  const hiddenKey = hidden.map((entry) => entry.id).join("\u0000");
  const dmRosterKey =
    list.status === "ready"
      ? list.channels
          .filter((channel) => channel.channelType === "dm")
          .map((channel) => channel.id)
          .sort()
          .join("\u0000")
      : "";
  const current = useRef(hidden);
  const update = useCallback(
    (next: HiddenDm[]) => {
      current.current = next;
      setHidden(next);
      writeView(scope, key, next);
    },
    [scope],
  );
  const show = useCallback(
    (ids: readonly string[]) => {
      const targets = new Set(ids);
      const next = current.current.filter((entry) => !targets.has(entry.id));
      if (next.length !== current.current.length) update(next);
    },
    [update],
  );
  useEffect(
    () => session.directMessages.subscribeOpened((id) => show([id])),
    [session, show],
  );
  const hide = useCallback(
    (id: string) => {
      const latest = session.unread.snapshot({
        kind: "channel",
        channelId: id,
      }).latestMessage;
      update([
        ...current.current.filter((entry) => entry.id !== id),
        {
          id,
          hideGeneration: Symbol(),
          ...(latest ? { baseline: latest } : {}),
        },
      ]);
    },
    [session, update],
  );

  useEffect(() => {
    if (!hidden.length) return;
    const check = () => {
      const next = current.current.flatMap((entry) => {
        const latest = session.unread.snapshot({
          kind: "channel",
          channelId: entry.id,
        }).latestMessage;
        if (!latest || entry.baseline === undefined) return [entry];
        if (entry.baseline === null) return [];
        if (latest.id === entry.baseline.id) return [entry];
        if (
          latest.createdAt > entry.baseline.createdAt ||
          (latest.createdAt === entry.baseline.createdAt &&
            latest.id < entry.baseline.id)
        )
          return [];
        // The direct history read can distinguish an older arrival from a
        // deletion that exposed old history. A head rollback alone cannot.
        return [entry];
      });
      if (
        next.length !== current.current.length ||
        next.some((entry, index) => entry !== current.current[index])
      )
        update(next);
    };
    const stops = hidden.map((entry) =>
      session.unread.subscribe({ kind: "channel", channelId: entry.id }, check),
    );
    const stopIncoming = session.subscribeIncoming((messages) =>
      show(messages.map((message) => message.channelId)),
    );
    const stopOutgoing = session.outbox?.observeSend((event) => {
      if (!isMessageKind(event.kind)) return;
      const destinations = event.tags.filter(([name]) => name === "h");
      const id = destinations.length === 1 ? destinations[0]?.[1] : undefined;
      const hiddenAtSend = current.current.find((entry) => entry.id === id);
      if (!id || !hiddenAtSend) return;
      return () => {
        const hiddenNow = current.current.find((entry) => entry.id === id);
        if (hiddenNow?.hideGeneration === hiddenAtSend.hideGeneration)
          show([id]);
      };
    });
    check();
    return () => {
      for (const stop of stops) stop();
      stopIncoming();
      stopOutgoing?.();
    };
  }, [hidden, session, show, update]);

  useEffect(() => {
    if (!hiddenKey || !dmRosterKey) return;
    const controller = new AbortController();
    const dmIds = new Set(dmRosterKey.split("\u0000"));
    // The shared unread repair is roster-wide and capped. Compare a bounded
    // per-DM history window so a late-arriving message need not be the head.
    void (async () => {
      for (const id of hiddenKey.split("\u0000")) {
        if (controller.signal.aborted) return;
        const entry = current.current.find((item) => item.id === id);
        if (!entry) continue;
        if (!dmIds.has(id)) continue;
        for (
          let attempt = 0;
          attempt < 3 && !controller.signal.aborted;
          attempt++
        ) {
          try {
            // Save a deeper initial window so deleting a recent head does not
            // make older pre-hide history look like a new message.
            const events = await session.read(
              [
                {
                  kinds: MESSAGE_KINDS,
                  "#h": [id],
                  limit: entry.knownIds ? 50 : 100,
                },
              ],
              {
                signal: controller.signal,
                priority: "background",
              },
            );
            if (current.current.includes(entry)) {
              const latest = session.unread.snapshot({
                kind: "channel",
                channelId: id,
              }).latestMessage;
              const ids = events.map((event) => event.id);
              const changed =
                entry.knownIds &&
                ids.some((eventId) => !entry.knownIds?.includes(eventId));
              if (changed) {
                show([id]);
                break;
              }
              if (entry.baseline === undefined || !entry.knownIds)
                update(
                  current.current.map((item) =>
                    item === entry
                      ? {
                          ...item,
                          baseline: latest ?? null,
                          knownIds: ids,
                        }
                      : item,
                  ),
                );
            }
            break;
          } catch {
            if (attempt < 2) await pause(500 * 2 ** attempt, controller.signal);
          }
        }
      }
    })();
    return () => controller.abort();
  }, [hiddenKey, session, dmRosterKey, show, update]);

  return { hiddenIds: new Set(hidden.map((entry) => entry.id)), hide };
}
