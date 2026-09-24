import { yieldToHost } from "../../features/relay/yield";
import { communityRequest } from "../../features/communities/api";
import { eventDto } from "../../features/relay/events";
import { foldProfiles } from "../../features/relay/profiles";
import type { Profile } from "../../features/relay/contracts";

/** Display enrichment stays on the relay that supplied the identity. */
export async function communityProfiles(
  community: string,
  identities: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Profile>> {
  const profiles = new Map<string, Profile>();
  for (let offset = 0; offset < identities.length; offset += 500) {
    const authors = identities.slice(offset, offset + 500);
    const raw = await communityRequest<unknown>(
      community,
      "query",
      [{ kinds: [0], authors, limit: 500 }],
      signal,
    );
    signal.throwIfAborted();
    if (!Array.isArray(raw) || raw.length > 500)
      throw new Error("Invalid community profiles");
    const events = [];
    for (let index = 0; index < raw.length; index += 12) {
      signal.throwIfAborted();
      events.push(...raw.slice(index, index + 12).map(eventDto));
      if (index + 12 < raw.length) await yieldToHost();
    }
    signal.throwIfAborted();
    if (
      events.some(
        (event) => event.kind !== 0 || !authors.includes(event.pubkey),
      )
    )
      throw new Error(
        "Community profile response is outside its identity scope",
      );
    for (const [key, profile] of foldProfiles(events))
      profiles.set(key, profile);
  }
  return profiles;
}
