import { communityProfiles } from "./community-profiles";
import type { Profile } from "../../features/relay/contracts";
import { useEffect, useState } from "react";
import { communityRequest } from "../../features/communities/api";
import { relayOrigin } from "../../features/communities/destination";
import type { ClientSnapshot } from "../../features/communities/service";
import type { RelaySnapshot } from "../../features/relay/service";

type Read = {
  identities?: string[];
  error?: boolean;
  profiles?: ReadonlyMap<string, Profile>;
  profileError?: boolean;
};

/** Discovery only: scoped reads never acquire sessions or grant local custody. */
export function useCommunityInventory(
  connection: RelaySnapshot,
  client: ClientSnapshot | undefined,
  destination: string,
  refresh: number,
) {
  const viewer = client ? client.viewer : connection.viewer;
  const ready = client
    ? client.status === "ready"
    : connection.status === "ready";
  const communities = [
    ...new Set(
      client
        ? client.memberships.map((m) => relayOrigin(m.id))
        : destination
          ? [destination]
          : [],
    ),
  ].sort();
  const scope = JSON.stringify([
    viewer,
    ready ? communities : [],
    refresh,
    connection.generation,
  ]);
  const [read, setRead] = useState<{
    scope: string;
    results: Record<string, Read>;
  }>();
  const [known, setKnown] = useState<{
    viewer?: string;
    identities: Record<string, string[]>;
  }>({ identities: {} });
  useEffect(() => {
    setRead({ scope, results: {} });
    if (!ready || !viewer) return;
    const controller = new AbortController();
    // The scope serializes the exact request inputs, so selection is not authority.
    const [, requested] = JSON.parse(scope) as [string, string[]];
    for (const community of requested) {
      void communityRequest<{ identities: string[] }>(
        community,
        "agent-inventory",
        {},
        controller.signal,
      )
        .then(async ({ identities }) => {
          if (controller.signal.aborted) return;
          setKnown((saved) => ({
            viewer,
            identities: {
              ...(saved.viewer === viewer ? saved.identities : {}),
              [community]: identities,
            },
          }));
          setRead((saved) => ({
            scope,
            results: { ...saved?.results, [community]: { identities } },
          }));
          try {
            const profiles = await communityProfiles(
              community,
              identities,
              controller.signal,
            );
            if (!controller.signal.aborted)
              setRead((saved) => ({
                scope,
                results: {
                  ...saved?.results,
                  [community]: { identities, profiles },
                },
              }));
          } catch {
            if (!controller.signal.aborted)
              setRead((saved) => ({
                scope,
                results: {
                  ...saved?.results,
                  [community]: { identities, profileError: true },
                },
              }));
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setRead((saved) => ({
              scope,
              results: { ...saved?.results, [community]: { error: true } },
            }));
        });
    }
    return () => controller.abort();
  }, [scope, ready, viewer]);
  const results = read?.scope === scope ? read.results : {};
  const errors = communities.filter((id) => results[id]?.error);
  const pending = ready && communities.some((id) => !results[id]);
  const communityIdentities = new Map<string, string[]>();
  if (known.viewer === viewer) {
    for (const [id, identities] of Object.entries(known.identities)) {
      if (!client || communities.includes(id))
        communityIdentities.set(id, identities);
    }
  }
  const profiles = new Map<string, Profile & { community: string }>();
  // Stable source choice, independent of response order. Never cross viewer scope.
  for (const community of communities) {
    for (const [key, profile] of results[community]?.profiles ?? [])
      if (!profiles.has(key)) profiles.set(key, { ...profile, community });
  }
  return {
    profiles,
    profileErrors: communities.filter((id) => results[id]?.profileError),
    communityIdentities,
    errors,
    pending,
    currentReadComplete: ready && !pending && !errors.length,
  };
}
