import type { NamingIdentity } from "./policy";
import { useSyncExternalStore, useCallback, useMemo } from "react";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { IdentityNameView } from "./service";
const noop = () => () => {};
const zero = () => 0;
/** The interface arrives through the captured session, never a global lookup. */
export function useIdentityNames(names: IdentityNameView | undefined) {
  const revision = useSyncExternalStore(
    names?.subscribe ?? noop,
    names?.snapshot ?? zero,
    zero,
  );
  return useCallback(
    (
      pubkey: string,
      fallback: string,
      candidates?: readonly string[],
      displayFacts?: readonly NamingIdentity[],
    ): string => {
      // Invalidate memoized labels and completion choices on name changes.
      void revision;
      return (
        names?.resolve(pubkey, fallback, candidates, displayFacts) ?? fallback
      );
    },
    [names, revision],
  );
}

const noMembers: readonly string[] = [];
/** Channel membership defines ambiguity, not the community-wide profile cache. */
export function useChannelIdentityNames(
  session: RelaySession | undefined,
  channelId: string | undefined,
  displayed?: readonly string[],
) {
  const members = useListedChannel(
    session?.channels,
    channelId,
    (channel) => channel?.members ?? noMembers,
  );
  const names = session?.names;
  const ids = displayed && JSON.stringify([...new Set(displayed)].sort());
  const snapshot = useMemo<() => number | string>(() => {
    if (ids === undefined) return names?.snapshot ?? zero;
    const keys: string[] = JSON.parse(ids);
    // Select outputs, not collision candidates: an off-row member or agent's
    // owner can still change a displayed label. The name service owns that policy.
    const lookup = names?.scope(members);
    let revision: number | undefined;
    let labels = "";
    return () => {
      const next = names?.snapshot() ?? 0;
      if (revision !== next) {
        revision = next;
        labels = JSON.stringify(keys.map((key) => lookup?.(key)?.name));
      }
      return labels;
    };
  }, [names, members, ids]);
  const revision = useSyncExternalStore(
    names?.subscribe ?? noop,
    snapshot,
    snapshot,
  );
  return useCallback(
    (pubkey: string, fallback: string) => {
      void revision;
      return names?.resolve(pubkey, fallback, members) ?? fallback;
    },
    [names, revision, members],
  );
}
