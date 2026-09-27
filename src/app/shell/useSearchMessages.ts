import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { objectBody } from "../../features/relay/body";
import { isMessageKind, MESSAGE_KINDS } from "../../features/relay/kinds";
import type { RelaySession } from "../../features/relay/session";

export type SearchMessage = Readonly<{
  id: string;
  channelId: string;
  authorId: string;
  createdAt: number;
  preview: string;
}>;
type Result = {
  owner: object;
  messages: readonly SearchMessage[];
  error?: string;
};

/** Finite, ranked results belong to this open palette, not a retained event view. */
export function useSearchMessages(
  session: RelaySession,
  query: string,
  scopedChannelId?: string,
) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>();
  const owner = useMemo(
    () => ({ session, query, scopedChannelId, attempt }),
    [session, query, scopedChannelId, attempt],
  );
  // The copied result changes synchronously even if React has not committed it yet.
  const copied = useRef<Result | undefined>(undefined);
  const replace = useCallback((next: Result | undefined) => {
    copied.current = next;
    setResult(next);
  }, []);
  useEffect(
    () =>
      session.channels.subscribeList(() => {
        const previous = copied.current;
        if (!previous) return;
        const messages = previous.messages.filter(
          (message) => !!session.channels.get?.(message.channelId),
        );
        if (messages.length !== previous.messages.length)
          replace({ ...previous, messages });
      }),
    [session, replace],
  );
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    // Typeahead waits for a brief typing pause; cancellation also owns the delay.
    const timer = setTimeout(() => {
      void session
        .read(
          [
            {
              kinds: MESSAGE_KINDS,
              search: query,
              search_mode: "prefix",
              limit: 20,
              ...(scopedChannelId ? { "#h": [scopedChannelId] } : {}),
            },
          ],
          { signal: controller.signal, priority: "foreground", fresh: true },
        )
        .then((events) => {
          if (controller.signal.aborted) return;
          const messages = events.flatMap((event): SearchMessage[] => {
            const destinations = event.tags.filter(([name]) => name === "h");
            const channelId = destinations[0]?.[1];
            if (
              !isMessageKind(event.kind) ||
              destinations.length !== 1 ||
              !channelId ||
              (scopedChannelId && channelId !== scopedChannelId) ||
              !session.channels.get?.(channelId)
            )
              return [];
            // Search returns original indexed events, not an auxiliary edit fold.
            // Exact navigation owns current content/deletion checks when opened.
            const body =
              event.kind === 40002 ? objectBody(event.content) : undefined;
            const text =
              event.kind === 40002
                ? typeof body?.content === "string"
                  ? body.content
                  : "Agent message"
                : event.content;
            return [
              {
                id: event.id,
                channelId,
                authorId: event.pubkey,
                createdAt: event.created_at,
                preview:
                  text.replace(/\s+/g, " ").trim().slice(0, 240) ||
                  "Attachment",
              },
            ];
          });
          replace({ owner, messages });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            replace({
              owner,
              messages: [],
              error: `Message search couldn’t finish${error instanceof Error && error.message ? `: ${error.message.slice(0, 240)}` : "."}${scopedChannelId ? " Try again." : " Pages and conversations are still available."}`,
            });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, query, scopedChannelId, owner, replace]);
  const current = result?.owner === owner ? result : undefined;
  return {
    messages: (current?.messages ?? []).filter(
      (message) => !!session.channels.get?.(message.channelId),
    ),
    loading: !!query && !current,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
