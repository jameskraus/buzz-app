import { avatarPictureError } from "../profiles/avatar-upload";
import {
  connectNativeTransport,
  nativeRelayInfo,
  nativeRelayRequest,
  nativeRelaySigner,
} from "../relay/native";
import { leaveRefusal, leaveRequestTemplate } from "./leave-protocol";
import type { PersonalProfile } from "./service";

export async function nativeCommunityRequest(
  community: string,
  route: string,
  body?: unknown,
): Promise<unknown> {
  const signal = AbortSignal.timeout(25_000);
  if (route === "info") {
    const info = await nativeRelayInfo(community, signal);
    const response = await nativeRelayRequest(
      community,
      "/api/join-policy",
      undefined,
      signal,
    );
    const raw =
      response.status === 404 ? null : (await readResponse(response)).policy;
    if (
      raw !== null &&
      raw !== undefined &&
      (typeof raw !== "object" || Array.isArray(raw))
    )
      throw new Error("Invalid community join policy");
    const policy = raw as Record<string, unknown> | null | undefined;
    if (
      policy &&
      (typeof policy.version !== "string" ||
        typeof policy.age_attestation_required !== "boolean" ||
        (policy.terms_markdown != null &&
          typeof policy.terms_markdown !== "string") ||
        (policy.privacy_markdown != null &&
          typeof policy.privacy_markdown !== "string"))
    )
      throw new Error("Invalid community join policy");
    return {
      name: typeof info.name === "string" ? info.name : undefined,
      icon: typeof info.icon === "string" ? info.icon : undefined,
      policy: policy
        ? {
            version: policy.version,
            age_attestation_required: policy.age_attestation_required,
            terms_markdown: policy.terms_markdown ?? undefined,
            privacy_markdown: policy.privacy_markdown ?? undefined,
          }
        : null,
    };
  }
  if (route === "session") {
    const transport = await connectNativeTransport(community, signal);
    return { viewer: transport.viewer, relayAuthor: transport.relayAuthor };
  }
  if (route === "claim" || route === "accept-policy") {
    const input = body as
      | {
          code?: unknown;
          policy_version?: unknown;
          age_confirmed?: unknown;
          policy_receipt?: unknown;
        }
      | undefined;
    if (
      !input ||
      typeof input.code !== "string" ||
      !/^[a-zA-Z0-9._-]{1,256}$/.test(input.code)
    )
      throw new Error("Invalid invite code");
    const value =
      route === "claim"
        ? { code: input.code, policy_receipt: input.policy_receipt }
        : {
            code: input.code,
            policy_version: input.policy_version,
            age_confirmed: input.age_confirmed === true,
          };
    const result = await readResponse(
      await nativeRelayRequest(
        community,
        `/api/invites/${route}`,
        value,
        signal,
      ),
    );
    if (
      route === "accept-policy" &&
      (typeof result.receipt !== "string" || !result.receipt)
    )
      throw new Error("Policy acceptance was not confirmed");
    return result;
  }
  if (route === "profile") {
    const profile = body as PersonalProfile & {
      existing?: Record<string, unknown>;
    };
    if (
      !profile ||
      typeof profile.name !== "string" ||
      !profile.name.trim() ||
      profile.name.length > 100 ||
      typeof profile.picture !== "string" ||
      avatarPictureError(profile.picture) ||
      (profile.about !== undefined &&
        (typeof profile.about !== "string" || profile.about.length > 500))
    )
      throw new Error("Check your profile name, picture and description");
    const content = JSON.stringify({
      ...profile.existing,
      name: profile.name.trim(),
      display_name: profile.name.trim(),
      picture: profile.picture,
      about: (
        profile.about ??
        (typeof profile.existing?.about === "string"
          ? profile.existing.about
          : "")
      ).trim(),
    });
    if (new TextEncoder().encode(content).length > 16000)
      throw new Error("Profile too large");
    const event = await nativeRelaySigner(community).signEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    });
    const result = await readResponse(
      await nativeRelayRequest(community, "/events", event, signal),
    );
    if (result.event_id !== event.id || result.accepted !== true)
      throw new Error("Profile publication was not confirmed");
    return result;
  }
  if (route === "leave") {
    // The membership refusals come back verbatim so the caller can tell an
    // already-absent membership from a failed request.
    const event = await nativeRelaySigner(community).signEvent(
      leaveRequestTemplate(),
    );
    const result = await readResponse(
      await nativeRelayRequest(community, "/events", event, signal),
      leaveRefusal,
    );
    if (result.event_id !== event.id || result.accepted !== true)
      throw new Error("The leave request was not confirmed");
    return result;
  }
  throw new Error("This operation is unavailable on the packaged connection");
}

/** Exact invite admission refusal codes (buzz-relay api/invites.rs). */
function admissionRefusal(result: unknown) {
  const body = result as { error?: unknown; reason?: unknown } | null;
  return [
    "invite_expired",
    "invite_exhausted",
    "invite_invalid",
    "join_policy_required",
    "join_policy_not_accepted",
  ].find((value) => body?.error === value || body?.reason === value);
}

async function readResponse(
  response: Response,
  refusal: (result: unknown) => string | undefined = admissionRefusal,
): Promise<Record<string, unknown>> {
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      refusal(result) ?? `Community request failed (${response.status})`,
    );
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid community response");
  return result;
}
