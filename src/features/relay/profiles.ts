import { avatarSource } from "../../shared/avatar-source";
import { newer } from "./events";
import type { EventData } from "./events";
import type { Profile } from "./contracts";

/** Kind 0 metadata. Only the author's own latest event counts. */
export function foldProfiles(
  events: readonly EventData[],
): Map<string, Profile> {
  const latest = new Map<string, EventData>();
  for (const event of events) {
    if (event.kind !== 0) continue;
    const previous = latest.get(event.pubkey);
    latest.set(event.pubkey, newer(previous, event));
  }
  const profiles = new Map<string, Profile>();
  for (const [pubkey, event] of latest) {
    const auth = event.tags.find(
      (tag) =>
        tag.length === 4 &&
        tag[0] === "auth" &&
        /^[0-9a-f]{64}$/.test(tag[1] ?? "") &&
        /^[0-9a-f]{128}$/.test(tag[3] ?? ""),
    );
    const agent = auth
      ? { isAgent: true as const, ownerPubkey: auth[1] as string }
      : {};
    try {
      const body = JSON.parse(event.content) as {
        display_name?: unknown;
        name?: unknown;
        picture?: unknown;
        about?: unknown;
        nip05?: unknown;
        is_agent?: unknown;
        isAgent?: unknown;
      };
      const name = [body.display_name, body.name].find(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
      const picture = avatarSource(body.picture);
      profiles.set(
        pubkey,
        Object.freeze({
          name: name ?? pubkey.slice(0, 10),
          ...agent,
          ...(picture ? { picture } : {}),
          ...(typeof body.about === "string" && body.about.trim()
            ? { about: body.about.trim() }
            : {}),
          ...(typeof body.nip05 === "string" && body.nip05.trim()
            ? { nip05: body.nip05.trim() }
            : {}),
          ...(body.is_agent === true || body.isAgent === true
            ? { isAgent: true as const }
            : {}),
        }),
      );
    } catch {
      profiles.set(
        pubkey,
        Object.freeze({ name: pubkey.slice(0, 10), ...agent }),
      );
    }
  }
  return profiles;
}
