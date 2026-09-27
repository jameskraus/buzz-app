import type { ChannelMessage } from "./contracts";
import type { EventData } from "./events";
import { foldMessages } from "./fold";
import type { OutgoingEvent } from "./outbox";
import type { RelayProfiler } from "./profiling";

import { channelRowKind as messageKind } from "./kinds";
import { compareMessages, eventMs, MessageClock } from "./message-order";
const PARENT_OVERLAY_DEPTH = 2;
const CHILD_OVERLAY_DEPTH = 1;

/** Per-window indexes. New evidence folds only affected messages; status updates never fold. */
export class MessageProjection {
  private inputs = new Map<string, EventData>();
  private overlays = new Map<string, Set<string>>();
  private messages = new Map<string, ChannelMessage>();
  private deliveries = new Map<string, OutgoingEvent>();
  private rows: readonly ChannelMessage[] = Object.freeze([]);
  constructor(
    private channelId: string,
    private relayAuthor: string,
    private profiling: RelayProfiler,
    private includeReplies: () => boolean = () => false,
    private clock = new MessageClock(),
  ) {}
  snapshot() {
    return this.rows;
  }
  reconcile(
    events: readonly EventData[],
    operations: readonly OutgoingEvent[],
  ) {
    const next = new Map(events.map((event) => [event.id, event]));
    const deliveries = new Map(operations.map((item) => [item.event.id, item]));
    const affected = new Set<string>();
    const targets = (event: EventData) =>
      messageKind(event.kind)
        ? [event.id]
        : event.tags.flatMap(([name, value]) =>
            name === "e" && value ? [value] : [],
          );
    for (const [id, event] of this.inputs) {
      if (next.has(id)) continue;
      for (const target of targets(event)) {
        affected.add(target);
        const refs = this.overlays.get(target);
        refs?.delete(id);
        if (!refs?.size) this.overlays.delete(target);
      }
    }
    for (const [id, event] of next) {
      // Stable event IDs identify immutable payloads, including unsigned local intent.
      if (this.inputs.has(id)) continue;
      if (messageKind(event.kind))
        this.clock.observe(this.channelId, eventMs(event));
      for (const target of targets(event)) {
        affected.add(target);
        if (!messageKind(event.kind)) {
          const refs = this.overlays.get(target) ?? new Set<string>();
          refs.add(id);
          this.overlays.set(target, refs);
        }
      }
    }
    // A deletion of an edit/reaction changes its owning message, not a row
    // whose ID is the overlay. Include removed inputs for failure rollback.
    const parentQueue = [...affected].map((id) => ({ id, depth: 0 }));
    const queuedParents = new Set(affected);
    for (let index = 0; index < parentQueue.length; index++) {
      const { id, depth } = parentQueue[index] ?? {};
      if (!id || depth === undefined || depth >= PARENT_OVERLAY_DEPTH) continue;
      const event = next.get(id) ?? this.inputs.get(id);
      if (!event || messageKind(event.kind)) continue;
      for (const parent of targets(event)) {
        affected.add(parent);
        if (!queuedParents.has(parent)) {
          queuedParents.add(parent);
          parentQueue.push({ id: parent, depth: depth + 1 });
        }
      }
    }
    this.inputs = next;
    for (const [id, item] of deliveries) {
      const previous = this.deliveries.get(id);
      if (
        previous?.delivery !== item.delivery ||
        previous?.error !== item.error
      ) {
        if (messageKind(item.event.kind) && !affected.has(id))
          this.delivery(id, item);
      }
    }
    for (const id of this.deliveries.keys())
      if (!deliveries.has(id) && !affected.has(id))
        this.delivery(id, undefined);
    this.deliveries = deliveries;
    if (affected.size)
      this.profiling.measure(
        "view.fold",
        this.channelId,
        () => {
          for (const id of affected) {
            const event = next.get(id);
            const overlayIds = this.overlayIds(id);
            const row =
              event && messageKind(event.kind)
                ? foldMessages(
                    this.channelId,
                    this.relayAuthor,
                    [
                      event,
                      ...[...overlayIds].flatMap((ref) => next.get(ref) ?? []),
                    ],
                    { includeReplies: this.includeReplies() },
                  )[0]
                : undefined;
            if (row)
              this.messages.set(id, this.withDelivery(row, deliveries.get(id)));
            else this.messages.delete(id);
          }
          this.rows = Object.freeze(
            [...this.messages.values()].sort(compareMessages),
          );
        },
        affected.size,
      );
    return this.rows;
  }
  private overlayIds(id: string) {
    const overlayIds = new Set(this.overlays.get(id) ?? []);
    let frontier = [...overlayIds];
    for (let depth = 0; depth < CHILD_OVERLAY_DEPTH; depth++) {
      const children: string[] = [];
      for (const ref of frontier) {
        for (const child of this.overlays.get(ref) ?? []) {
          if (overlayIds.has(child)) continue;
          overlayIds.add(child);
          children.push(child);
        }
      }
      frontier = children;
      if (!frontier.length) break;
    }
    return overlayIds;
  }
  private withDelivery(
    row: ChannelMessage,
    item: OutgoingEvent | undefined,
  ): ChannelMessage {
    return Object.freeze({
      ...row,
      delivery: item?.delivery,
      deliveryError: item?.error,
    });
  }
  private delivery(id: string, item: OutgoingEvent | undefined) {
    const row = this.messages.get(id);
    if (!row) return;
    const next = this.withDelivery(row, item);
    this.messages.set(id, next);
    this.rows = Object.freeze(
      this.rows.map((old) => (old.id === id ? next : old)),
    );
  }
}
