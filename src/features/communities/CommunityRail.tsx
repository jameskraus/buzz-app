import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GlobeIcon, PlusIcon } from "../../shared/design-system/icons/index";
import type { OpenTarget } from "../navigation/targets";
import { communityFromScope } from "../relay/gifs";
import { useRelayConnection } from "../relay/react";
import { inviteMintingAvailable } from "./api";
import type { Communities } from "./service";
import { CommunityDialog } from "./CommunityDialog";
import { CommunityRailItem } from "./CommunityRailItem";
import { communityDestination } from "./destination";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Communities.module.css";
import { fetchCommunityIcon } from "./community-icon";
import { useCommunityRole } from "./useCommunityRole";

/** Shell navigation only: selecting a community remains owned by Communities. */
export function CommunityRail({
  communities,
  onSelect,
  onOpenTarget,
}: {
  communities: Communities;
  onSelect?: ((id: string | null) => void) | undefined;
  /** Menu destinations (Invites, Community settings) open through the host's navigation. */
  onOpenTarget?: ((target: OpenTarget) => void) | undefined;
}) {
  const [joining, setJoining] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const wasJoining = useRef(false);
  useEffect(() => {
    if (wasJoining.current && !joining) addRef.current?.focus();
    wasJoining.current = joining;
  }, [joining]);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  // The compatibility reader follows selection, so this is only ever the
  // selected community's session; inactive communities stay unacquired.
  const connection = useRelayConnection(communities.relay);
  const selectedOrigin = client.selected
    ? communityDestination(client.selected).url
    : null;
  const session =
    connection.status === "ready" &&
    connection.scope &&
    communityFromScope(connection.scope) === selectedOrigin
      ? connection.session
      : undefined;
  // Roles come from the relay-signed roster, as the Invites card derives them.
  // Skip the read where no item could use it.
  const invites = inviteMintingAvailable() && !!onOpenTarget;
  const role = useCommunityRole(
    invites ? session : undefined,
    selectedOrigin,
    client.viewer,
  );
  const [icons, setIcons] = useState<Record<string, string>>({});
  const membershipIds = client.memberships
    .map((membership) => membership.id)
    .join("\n");
  useEffect(() => {
    if (client.status !== "ready" || !client.relayAvailable) return;
    const controller = new AbortController();
    // Icon discovery is optional. Reserve browser connections for foreground work
    // even when saved relays hold their NIP-11 responses indefinitely.
    const ids = membershipIds.split("\n").filter(Boolean);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(2, ids.length) },
      async () => {
        while (next < ids.length && !controller.signal.aborted) {
          const id = ids[next++];
          if (id === undefined) break;
          try {
            const icon = await fetchCommunityIcon(id, controller.signal);
            if (icon !== undefined && !controller.signal.aborted)
              setIcons((previous) => ({ ...previous, [id]: icon }));
          } catch {
            // Unreachable relay: retain saved icon or initials.
          }
        }
      },
    );
    void Promise.all(workers);
    return () => controller.abort();
  }, [client.status, client.relayAvailable, membershipIds]);
  const select = (id: string | null) => {
    if (onSelect) onSelect(id);
    else communities.select(id);
  };
  return (
    <>
      <nav aria-label="Communities" className={styles.rail}>
        <Tooltip content="Personal space" side="right">
          <IconButton
            aria-label="Personal space"
            aria-current={client.selected === null ? "true" : undefined}
            data-selected={client.selected === null || undefined}
            icon={<GlobeIcon size={22} aria-hidden="true" />}
            onClick={() => select(null)}
          />
        </Tooltip>
        {client.memberships.map((membership) => {
          const selected = client.selected === membership.id;
          return (
            <CommunityRailItem
              key={membership.id}
              membership={membership}
              icon={icons[membership.id] ?? membership.icon}
              selected={selected}
              viewer={client.viewer}
              session={selected ? session : undefined}
              manager={selected && invites && role.manager}
              onSelect={select}
              onOpenTarget={onOpenTarget}
              // Roles can change while the app runs; opening the selected
              // community's menu re-reads the roster it gates on.
              onMenuOpen={selected && invites ? role.refresh : undefined}
            />
          );
        })}
        <Tooltip content="Add a community" side="right">
          <IconButton
            ref={addRef}
            aria-label="Add a community"
            icon={<PlusIcon size={22} aria-hidden="true" />}
            onClick={() => setJoining(true)}
          />
        </Tooltip>
      </nav>
      {joining && (
        <CommunityDialog
          communities={communities}
          mode="join"
          onJoined={(id) => select(id)}
          close={() => setJoining(false)}
        />
      )}
    </>
  );
}
