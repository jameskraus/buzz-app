// NIP-43 leave request shared by the development broker and the native adapter.
// Dependency-free so the Node broker can import it.

export const LEAVE_REQUEST_KIND = 28936;

/** The only leave request either signer produces: empty content and the NIP-70
 * protected tag, dated now so the relay's freshness window admits it. */
export function leaveRequestTemplate(now = Math.floor(Date.now() / 1000)) {
  return {
    kind: LEAVE_REQUEST_KIND,
    content: "",
    created_at: now,
    tags: [["-"]],
  };
}

// Exact relay refusals (buzz-relay handlers/ingest.rs). Anything else,
// including database or internal text, stays a generic summary.
const ABSENT = new Set([
  "invalid: you are not a relay member",
  "invalid: relay membership is not enabled",
]);
const REFUSALS = new Set([
  ...ABSENT,
  "invalid: relay owner cannot leave",
  "blocked: you are banned from this community",
  "community writes are temporarily unavailable",
]);

/** Relay-authored refusal worth returning verbatim; anything else stays generic. */
export function leaveRefusal(body: unknown): string | undefined {
  const reason =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
  return typeof reason === "string" && REFUSALS.has(reason)
    ? reason
    : undefined;
}

/** A refusal meaning the relay holds no membership for the viewer to revoke. */
export function membershipAbsent(reason: string) {
  return ABSENT.has(reason);
}
