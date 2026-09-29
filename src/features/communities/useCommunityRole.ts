import { useCallback, useEffect, useRef, useState } from "react";
import {
  managesCommunity,
  readRoster,
  type Member,
  type RosterReader,
} from "./roster";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** The viewer's role in one community, derived from the relay-signed roster
 * read through that community's own session. Shared by the Invites settings
 * card and the community rail menu so both gate owner/admin actions alike.
 *
 * `members` is `undefined` while the first read is pending, `null` when the
 * community publishes no member list. A failed re-read keeps the last list and
 * reports `readError`; it never erases a confirmed roster. Passing no session
 * reads nothing and reports no role. */
export function useCommunityRole(
  session: RosterReader | undefined,
  community: string | null,
  viewer: string | undefined,
) {
  const [members, setMembers] = useState<Member[] | null>();
  const [readError, setReadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const reading = useRef<AbortController | null>(null);
  /** Read-only roster refresh; the newest request wins and never rethrows. */
  const refresh = useCallback(async () => {
    if (!session || !community) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const { signal } = controller;
    setRefreshing(true);
    try {
      const next = await readRoster(session, community, signal);
      if (signal.aborted) return;
      setMembers(next);
      setReadError("");
    } catch (reason) {
      if (signal.aborted) return;
      setMembers((current) => current ?? null);
      setReadError(`Could not load members: ${message(reason)}`);
    } finally {
      if (!signal.aborted) setRefreshing(false);
    }
  }, [session, community]);
  useEffect(() => {
    // Another community's roster must never gate this one's actions.
    setMembers(undefined);
    setReadError("");
    void refresh();
    return () => reading.current?.abort();
  }, [refresh]);
  const role = viewer
    ? members?.find((member) => member.pubkey === viewer)?.role
    : undefined;
  return {
    members,
    role,
    manager: managesCommunity(role),
    readError,
    refreshing,
    refresh,
  };
}
