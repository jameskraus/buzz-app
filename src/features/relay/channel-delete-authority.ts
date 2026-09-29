/** A current, authenticated relay decision, not a profile claim or a write grant. */
export type ChannelDeleteAuthority = (
  channelId: string,
  signal: AbortSignal,
) => Promise<boolean>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function deleteAuthorityCommunity(value: unknown): string | undefined {
  if (
    record(value) &&
    value.version === 1 &&
    typeof value.community_id === "string" &&
    uuid.test(value.community_id)
  )
    return value.community_id;
}

export function deleteAuthorityFilter(channelId: string, viewer: string) {
  if (!uuid.test(channelId)) throw new Error("Invalid channel target");
  return [
    {
      kinds: [9008],
      "#h": [channelId],
      "#p": [viewer],
      channel_delete_authority: 1,
    },
  ];
}

export function deleteAuthorityTarget(
  value: unknown,
  viewer: string,
): string | undefined {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) return;
  const filter = value[0];
  const channel = Array.isArray(filter["#h"]) ? filter["#h"][0] : undefined;
  if (typeof channel !== "string" || !uuid.test(channel)) return;
  const expected = deleteAuthorityFilter(channel, viewer)[0];
  if (!expected) return;
  if (Object.keys(filter).sort().join() !== Object.keys(expected).sort().join())
    return;
  if (
    Object.entries(expected).every(
      ([key, val]) => JSON.stringify(filter[key]) === JSON.stringify(val),
    )
  )
    return channel;
}

export function parseDeleteAuthority(
  value: unknown,
  community: string,
  viewer: string,
  channel: string,
): boolean {
  if (
    !record(value) ||
    value.channel_delete_authority !== 1 ||
    value.community_id !== community ||
    value.pubkey !== viewer ||
    value.channel_id !== channel ||
    typeof value.can_delete !== "boolean"
  )
    throw new Error("Delete authority unavailable or mismatched");
  return value.can_delete;
}

/** Bound the tiny envelope at both HTTP boundaries before parsing. */
export async function deleteAuthorityText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Delete authority response missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 4096) throw new Error("Delete authority response too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
