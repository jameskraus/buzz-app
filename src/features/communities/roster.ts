// Community membership roles from the relay-signed NIP-43 kind 13534 roster.
// Roles here only shape the UI; the relay decides every privileged change.
import type { EventData, ReadFilter } from "../relay/events";
import type { ReadOptions } from "../relay/reader";
import { communityRequest } from "./api";

export type Role = "owner" | "admin" | "member";
export type Member = { pubkey: string; role: Role };

export const MEMBERSHIP_KIND = 13534;
const ROLES: readonly string[] = ["owner", "admin", "member"];

/** Members from the relay-signed snapshot (`["member", pubkey, role]` tags). */
export function membersFromSnapshot(
  event: EventData,
  relayAuthor: string,
): Member[] {
  if (event.kind !== MEMBERSHIP_KIND || event.pubkey !== relayAuthor)
    throw new Error("Member list is not signed by this community");
  const members = new Map<string, Member>();
  for (const [name, pubkey, role] of event.tags) {
    if (name !== "member" || !pubkey || !/^[0-9a-f]{64}$/.test(pubkey))
      continue;
    if (members.has(pubkey)) continue;
    members.set(pubkey, {
      pubkey,
      role: role && ROLES.includes(role) ? (role as Role) : "member",
    });
  }
  return [...members.values()];
}

/** The community's relay signing key, from the broker session contract. */
export const relayAuthor = async (community: string) =>
  (await communityRequest<{ relayAuthor: string }>(community, "session"))
    .relayAuthor;

export type RosterReader = {
  read(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
  ): Promise<readonly EventData[]>;
};

/** One fresh roster read through the community's own session. Null means the
 * community publishes no member list, so it has no roles to derive. */
export async function readRoster(
  session: RosterReader,
  community: string,
  signal?: AbortSignal,
): Promise<Member[] | null> {
  const author = await relayAuthor(community);
  const events = await session.read(
    [{ kinds: [MEMBERSHIP_KIND], authors: [author], limit: 1 }],
    { fresh: true, ...(signal ? { signal } : {}) },
  );
  const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
  return latest ? membersFromSnapshot(latest, author) : null;
}

export const managesCommunity = (role: Role | undefined) =>
  role === "owner" || role === "admin";
