import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GlobeIcon, PlusIcon } from "../../shared/design-system/icons/index";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { OpenTarget } from "../navigation/targets";
import { communityFromScope } from "../relay/gifs";
import { useRelayConnection } from "../relay/react";
import { inviteMintingAvailable, requestLeave } from "./api";
import type { Communities, Membership } from "./service";
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
  // The confirm dialog belongs to the rail so it outlives the item it removes.
  const [leaving, setLeaving] = useState<{
    membership: Membership;
    pending: boolean;
  } | null>(null);
  const personalRef = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLElement>());
  const wasLeaving = useRef<Membership | null>(null);
  useEffect(() => {
    // Focus returns to the community when it is still saved (cancel or failure),
    // otherwise to Personal space, where a left selection now lands.
    const previous = wasLeaving.current;
    if (previous && !leaving)
      (buttons.current.get(previous.id) ?? personalRef.current)?.focus();
    wasLeaving.current = leaving?.membership ?? null;
  }, [leaving]);
  const notify = useToastNotification();
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
  /** Publish first; the device forgets the community only once the relay has
   * released the membership or reports it never held one. Anything else keeps
   * the membership and the menu item for a retry. */
  const leave = async () => {
    if (!leaving || leaving.pending) return;
    const { membership } = leaving;
    setLeaving({ membership, pending: true });
    try {
      const outcome = await requestLeave(membership.id);
      await communities.leave(membership.id);
      if (outcome === "already-absent")
        notify(
          `You were no longer a member of ${membership.name}, so it was removed from this device.`,
          "info",
        );
      else notify(`Left ${membership.name}.`, "success");
    } catch (error) {
      notify(leaveFailureText(membership.name, error), "error");
    } finally {
      setLeaving(null);
    }
  };
  return (
    <>
      <nav aria-label="Communities" className={styles.rail}>
        <Tooltip content="Personal space" side="right">
          <IconButton
            ref={personalRef}
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
              leaving={
                leaving?.membership.id === membership.id && leaving.pending
              }
              onSelect={select}
              onOpenTarget={onOpenTarget}
              // Roles can change while the app runs; opening the selected
              // community's menu re-reads the roster it gates on.
              onMenuOpen={selected && invites ? role.refresh : undefined}
              onLeave={(target) =>
                setLeaving({ membership: target, pending: false })
              }
              buttonRef={(node) => {
                if (node) buttons.current.set(membership.id, node);
                else buttons.current.delete(membership.id);
              }}
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
      {leaving && (
        <AlertDialog
          title={`Leave ${leaving.membership.name}?`}
          description={`This sends a leave request to the community’s relay, then removes ${leaving.membership.name} from this device along with its saved drafts and reading positions. Rejoining may need a new invite.`}
          pending={leaving.pending}
          onClose={() => setLeaving(null)}
          // The rail's own effect places focus once the dialog is gone.
          finalFocus={false}
          actions={
            <>
              <Button
                disabled={leaving.pending}
                onClick={() => setLeaving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={leaving.pending}
                onClick={() => void leave()}
              >
                Leave community
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

/** Relay-authored refusals the viewer can act on read verbatim-ish; everything
 * else, including timeouts and unreachable relays, keeps one retry message. */
function leaveFailureText(name: string, error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "invalid: relay owner cannot leave")
    return `The relay owner can’t leave ${name}.`;
  if (reason === "blocked: you are banned from this community")
    return `${name} has blocked this identity, so the leave request was refused.`;
  return `Couldn’t leave ${name}. Check your connection and try again.`;
}
