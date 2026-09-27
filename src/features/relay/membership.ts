import type { ChannelMessage, MembershipChange } from "./contracts";
import type { EventData } from "./events";
import { objectBody } from "./body";
import { MEMBERSHIP_KIND } from "./kinds";
const pubkey = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Only the session's verified relay identity may describe membership activity. */
export function membershipChange(
  event: EventData,
  relayAuthor: string,
): MembershipChange | undefined {
  if (event.kind !== MEMBERSHIP_KIND || event.pubkey !== relayAuthor) return;
  const body = objectBody(event.content);
  if (!body || !pubkey(body.actor)) return;
  if (body.type === "member_left") {
    if (body.target !== undefined && body.target !== body.actor) return;
    return Object.freeze({
      type: body.type,
      actor: body.actor,
      target: body.actor,
    });
  }
  if (
    (body.type === "member_joined" || body.type === "member_removed") &&
    pubkey(body.target)
  )
    return Object.freeze({
      type: body.type,
      actor: body.actor,
      target: body.target,
    });
}

/** Shared profile demand includes system actors/subjects without inventing mentions. */
export function rowProfileIds(row: ChannelMessage): readonly string[] {
  return row.membership
    ? [row.membership.actor, row.membership.target]
    : [
        row.authorId,
        ...row.mentions,
        ...(row.mentionReferences ?? []),
        ...row.participants,
      ];
}

/** Activity never replaces the latest conversational sidebar preview. */
export function messagePreview(
  rows: readonly ChannelMessage[] = [],
): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && !row.membership)
      return row.diff
        ? `Diff: ${row.diff.filePath || "patch"}${row.diff.description ? ` — ${row.diff.description}` : ""}`
        : row.content;
  }
}
