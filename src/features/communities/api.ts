import { nativeIdentityEnabled } from "../identity/service";
import { nativeCommunityRequest } from "./native-api";
import { connectCommunityTransport, registerCommunity } from "./connection";
import { settledRefusal, type SettledRefusal } from "./leave-protocol";
import type { RelaySession } from "../relay/session";
import type { PersonalProfile } from "./service";
export type CommunityInfo = {
  name?: string;
  icon?: string;
  policy: {
    version: string;
    terms_markdown?: string;
    privacy_markdown?: string;
    age_attestation_required: boolean;
  } | null;
};
/** Invite minting is a broker-only route; the packaged native adapter has no
 * `invite` allowlist entry (nor a `member` one for roster changes), so surfaces
 * offering invites hide those controls there. The community rail's Invite to
 * community item and the bundled moderation plugin's Invites card share this
 * one gate rather than each deciding for themselves. */
export const inviteMintingAvailable = () => !nativeIdentityEnabled();
export async function communityRequest<T>(
  id: string,
  route: string,
  body?: unknown,
): Promise<T> {
  if (nativeIdentityEnabled())
    return nativeCommunityRequest(id, route, body) as Promise<T>;
  const response = await fetch(
    `/api/relay/${encodeURIComponent(id)}/${route}`,
    {
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(25000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error ?? `Community request failed (${response.status})`,
    );
  return result as T;
}
export async function inspectProfile(id: string, session?: RelaySession) {
  // Existing-community editors use the captured session so confirmed reads also
  // update its shared profile directory. Joining uses the selected host adapter.
  const transport =
    session ??
    (await connectCommunityTransport(id, AbortSignal.timeout(12000)));
  if (!transport.viewer) throw new Error("Profile identity is unavailable");
  const filters = [
    {
      kinds: [0],
      authors: [transport.viewer],
      limit: 5,
      ...(nativeIdentityEnabled() ? { consistency: "strong" as const } : {}),
    },
  ];
  const events =
    "read" in transport
      ? await transport.read(filters, {
          signal: AbortSignal.timeout(12000),
          fresh: true,
        })
      : await transport.query(filters, AbortSignal.timeout(12000));
  const event = events
    .filter((e) => e.kind === 0 && e.pubkey === transport.viewer)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const parsed: unknown = event ? JSON.parse(event.content) : {};
  const existing: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const profile: PersonalProfile = {
    name: String(existing.display_name ?? existing.name ?? ""),
    picture: typeof existing.picture === "string" ? existing.picture : "",
    about: typeof existing.about === "string" ? existing.about : "",
  };
  return { existing, profile, exists: !!event };
}
export async function publishProfile(
  id: string,
  profile: PersonalProfile,
  existing: Record<string, unknown>,
) {
  const receipt = await communityRequest<{
    accepted: boolean;
    event_id: string;
    message?: string;
  }>(id, "profile", { ...profile, existing });
  if (!receipt.accepted || !receipt.event_id)
    throw new Error(receipt.message ?? "Profile publication was not confirmed");
}
export type LeaveOutcome = "left" | SettledRefusal;
/** Publishes a NIP-43 leave request to the community's relay by origin, without
 * acquiring a session. Resolves only once the relay accepts it, answers that
 * it holds no membership for the viewer, or refuses the viewer as banned (the
 * membership stays on the relay, but no retry can reach it while the ban
 * lasts); any other refusal, transport failure or timeout throws and leaves
 * the membership for the caller to retry. */
export async function requestLeave(id: string): Promise<LeaveOutcome> {
  await registerCommunity(id, AbortSignal.timeout(12000));
  try {
    const receipt = await communityRequest<{
      accepted: boolean;
      event_id: string;
      message?: string;
    }>(id, "leave", {});
    if (!receipt.accepted || !receipt.event_id)
      throw new Error(receipt.message ?? "The leave request was not confirmed");
    return "left";
  } catch (error) {
    const settled =
      error instanceof Error ? settledRefusal(error.message) : undefined;
    if (settled) return settled;
    throw error;
  }
}
