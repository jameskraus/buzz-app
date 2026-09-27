import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";

export function lastEditableMessage(
  session: RelaySession,
  rows: readonly ChannelMessage[],
): ChannelMessage | undefined {
  if (!session.viewer || !session.outbox?.supports(40003)) return;
  const pending = session.outbox.snapshot();
  return [...rows]
    .reverse()
    .find(
      (row) =>
        row.authorId === session.viewer &&
        !row.membership &&
        !row.agentEnvelope &&
        !row.diff &&
        !row.plugin &&
        (!row.delivery ||
          row.delivery === "accepted" ||
          row.delivery === "seen") &&
        !pending.some(
          (item) =>
            item.event.kind === 40003 &&
            item.delivery !== "accepted" &&
            item.delivery !== "seen" &&
            item.event.tags.some(([name, id]) => name === "e" && id === row.id),
        ),
    );
}

const source = (row: ChannelMessage) => row.sourceContent ?? row.content;

const empty: readonly OutgoingEvent[] = [];
const snapshot = () => empty;
const subscribe = () => () => {};

/** Edit delivery uses the session outbox; the composer owns input and draft restoration. */
export function useMessageEdit(session: RelaySession, restore: () => void) {
  const [target, setTarget] = useState<ChannelMessage>();
  const [operation, setOperation] = useState<string>();
  const submitted = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const pending = useSyncExternalStore(
    session.outbox?.subscribe ?? subscribe,
    session.outbox?.snapshot ?? snapshot,
    session.outbox?.snapshot ?? snapshot,
  );
  const delivery = pending.find((item) => item.event.id === operation);
  const busy = !!operation && delivery?.delivery === "sending";
  const retryable =
    delivery?.delivery === "failed" || delivery?.delivery === "unknown";
  const close = () => {
    restore();
    setTarget(undefined);
    setOperation(undefined);
    submitted.current = undefined;
    setError(undefined);
  };
  const finish = useEffectEvent(close);
  useEffect(() => {
    if (
      operation &&
      (!delivery ||
        delivery.delivery === "accepted" ||
        delivery.delivery === "seen")
    )
      finish();
  }, [operation, delivery]);
  return {
    target,
    busy,
    locked: !!operation,
    retryable,
    error: error ?? delivery?.error,
    close,
    clearError: () => setError(undefined),
    start(row: ChannelMessage) {
      setTarget(row);
      setError(undefined);
      return source(row);
    },
    save(body: string, current: ChannelMessage | undefined) {
      if (!target || submitted.current || !body.trim()) return;
      if (!current || !lastEditableMessage(session, [current])) {
        setError("This message is no longer available to edit.");
        return;
      }
      if (source(current) !== source(target)) {
        setError(
          "This message changed while you were editing. Copy your changes, then cancel and reopen it.",
        );
        return;
      }
      if (body === source(target)) {
        close();
        return;
      }
      try {
        const id = session.messages.edit(
          target.id,
          body,
          current.attachmentSourceId ?? current.id,
        );
        submitted.current = id;
        setOperation(id);
        setError(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    retry() {
      if (!operation) return;
      try {
        session.outbox?.retry(operation);
        setError(undefined);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
  };
}
