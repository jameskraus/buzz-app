import { InventoryIdentityCard } from "./InventoryIdentityCard";
import { useState, type ReactNode } from "react";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
  ImportSource,
} from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import type { Profile } from "../../features/relay/contracts";
import { relayOrigin } from "../../features/communities/destination";
import { AgentCard } from "./AgentCard";
import {
  localHereGroup,
  localOtherGroup,
  relayGroup,
  inventoryDecision,
  inventoryGroups,
} from "./inventory-decisions";
import type { AgentInventoryIdentity } from "./inventory-model";
import type { identityTiles } from "./identity-tiles";

type InventoryEntry = {
  row: AgentInventoryIdentity;
  decision: ReturnType<typeof inventoryDecision>;
};
function communitySections(group: string, identities: InventoryEntry[]) {
  if (group !== localOtherGroup && group !== relayGroup)
    return [{ community: "", identities }];
  const sections = new Map<string, InventoryEntry[]>();
  for (const entry of identities) {
    // A saved setup owns local placement; relay sightings must not move it.
    const communities =
      group === localOtherGroup
        ? [
            ...entry.row.localSetups.keys(),
            ...entry.row.unconfiguredSetups.map((setup) =>
              setup.relayUrl ? relayOrigin(setup.relayUrl) : "",
            ),
          ]
        : [...entry.row.knownCommunities];
    // First sorted community wins, just as the top-level categories do.
    // Keep every setup/association on the one identity row.
    const community = communities.filter(Boolean).sort()[0] ?? "";
    const members = sections.get(community) ?? [];
    members.push(entry);
    sections.set(community, members);
  }
  return [...sections]
    .sort(([a], [b]) => (a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0))
    .map(([community, identities]) => ({
      community: community || "Community unknown",
      identities,
    }));
}

/** Final inventory presentation; discovery and transport lifetime stay with the caller. */
export function InventoryView({
  state,
  control,
  session,
  destination,
  rows,
  profiles,
  publicProfiles,
  sourceProfiles,
  edit,
  duplicate,
  remove,
  importedId,
  onUseHere,
  onImport,
  children,
}: {
  state: AgentControlState;
  control: AgentControl;
  session: RelaySession;
  destination: string;
  rows: ReadonlyMap<string, AgentInventoryIdentity>;
  profiles: ReturnType<typeof identityTiles>["profiles"];
  publicProfiles: ReadonlyMap<string, Profile>;
  sourceProfiles: ReadonlyMap<string, Profile & { community: string }>;
  edit(agent: AgentView, avatar?: string): void;
  duplicate?: ((agent: AgentView) => void) | undefined;
  remove?: ((agent: AgentView) => void) | undefined;
  importedId: string | null;
  onUseHere(
    pubkey: string,
    action: "use" | "clone",
    source?: ImportSource,
  ): void;
  onImport(pubkey: string, source?: ImportSource): void;
  children?: ReactNode;
}) {
  const [selectedSources, setSelectedSources] = useState<
    Record<string, ImportSource>
  >({});
  const data = state.data;
  if (!data) return null;
  const groups = new Map<string, InventoryEntry[]>();
  for (const row of rows.values()) {
    const decision = inventoryDecision(row, destination);
    const group = decision.group;
    groups.set(group, [...(groups.get(group) ?? []), { row, decision }]);
  }
  const orderedGroups = inventoryGroups.flatMap((group) => {
    const identities = groups.get(group);
    return identities ? [[group, identities] as const] : [];
  });
  for (const identities of groups.values()) {
    identities.sort(
      (a, b) =>
        a.row.displayName.localeCompare(b.row.displayName, undefined, {
          sensitivity: "base",
        }) || a.row.pubkey.localeCompare(b.row.pubkey),
    );
  }
  profiles.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
  return (
    <section aria-label="My agents" className="flex flex-col gap-6">
      {children}
      {!rows.size && <p>No agents yet. Add an agent to get started.</p>}
      {orderedGroups.map(([group, identities]) => (
        <section key={group} aria-label={group} className="flex flex-col gap-3">
          <h2 className="m-0 text-heading">{group}</h2>
          {communitySections(group, identities).map(
            ({ community, identities }) => (
              <section
                key={community}
                aria-label={community || undefined}
                className="flex min-w-0 flex-col gap-2"
              >
                {community && (
                  <h3 className="m-0 break-all text-label text-secondary">
                    {community}
                  </h3>
                )}
                <div
                  className={
                    group !== localHereGroup
                      ? `overflow-hidden rounded-xl border border-primary ${group === relayGroup ? "agent-relay-inventory" : ""}`
                      : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] items-start gap-4"
                  }
                >
                  {identities.map(({ row, decision }) => (
                    <InventoryIdentityCard
                      key={row.pubkey}
                      row={row}
                      decision={decision}
                      community={community}
                      state={state}
                      control={control}
                      session={session}
                      destination={destination}
                      publicProfiles={publicProfiles}
                      sourceProfiles={sourceProfiles}
                      edit={edit}
                      duplicate={duplicate}
                      remove={remove}
                      importedId={importedId}
                      onUseHere={onUseHere}
                      onImport={onImport}
                      selectedSource={selectedSources[row.pubkey]}
                      onSourceChange={(source) =>
                        setSelectedSources((saved) => ({
                          ...saved,
                          [row.pubkey]: source,
                        }))
                      }
                    />
                  ))}
                </div>
              </section>
            ),
          )}
        </section>
      ))}
      {!!profiles.length && (
        <section aria-label="Profiles without identities" className="space-y-3">
          <h2 className="text-heading">Profiles without identities</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
            {profiles.map((profile) => (
              <AgentCard
                key={profile.id}
                name={profile.name}
                avatar={profile.avatar}
                identities={[]}
                session={session}
              />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
