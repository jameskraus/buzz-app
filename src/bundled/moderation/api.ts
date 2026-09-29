// Owner/admin requests through the development broker. Roles come from the
// shared roster reader; the relay decides every change.
import { communityRequest } from "../../features/communities/api";
import type { Member, Role } from "../../features/communities/roster";

// The rail's gate for Invite to community, so both surfaces agree on which
// builds can reach the broker-only `invite` and `member` routes below.
export { inviteMintingAvailable } from "../../features/communities/api";
export {
  MEMBERSHIP_KIND,
  membersFromSnapshot,
  relayAuthor,
  type Member,
  type Role,
} from "../../features/communities/roster";

export type Invite = {
  code: string;
  url: string;
  expires_at: number;
  max_uses: number | null;
  uses_remaining: number | null;
};
export type MemberChange =
  | { action: "add" | "role"; pubkey: string; role: "admin" | "member" }
  | { action: "remove"; pubkey: string };

export type Action = "promote" | "demote" | "remove";
/** Actions the relay's permission matrix would allow `actor` to take on `target`. */
export function allowedActions(
  actor: Role | undefined,
  target: Member,
  self: boolean,
): Action[] {
  if (self || target.role === "owner") return [];
  if (actor === "admin") return target.role === "member" ? ["remove"] : [];
  if (actor !== "owner") return [];
  return [target.role === "admin" ? "demote" : "promote", "remove"];
}

export const mintInvite = (
  community: string,
  ttl_secs: number,
  max_uses: number | null,
) => communityRequest<Invite>(community, "invite", { ttl_secs, max_uses });

export async function changeMember(community: string, change: MemberChange) {
  const receipt = await communityRequest<{
    accepted?: boolean;
    message?: string;
  }>(community, "member", change);
  if (!receipt.accepted)
    throw new Error(receipt.message || "The relay did not accept the change");
}
