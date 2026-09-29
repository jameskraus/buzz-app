import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { OpenTarget } from "../navigation/targets";
import type { UnreadCapability } from "../relay/unread";
import {
  ChecksIcon,
  GearIcon,
  LinkIcon,
  SignOutIcon,
  TicketIcon,
} from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuIcon,
  MenuItem,
  MenuNote,
  MenuPopup,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { communityDestination } from "./destination";
import type { Membership } from "./service";
import styles from "./Communities.module.css";

/** The bundled moderation plugin's Invites card, addressed by contribution key. */
export const INVITES_SECTION = "buzz.moderation/invites";

/** A community the menu can act on through its own ready session. Absent for
 * inactive communities: no item here ever acquires a session. */
export type SelectedSession = {
  unread: Pick<
    UnreadCapability,
    "sync" | "subscribeSync" | "markAllChannelsRead"
  >;
};

const noSubscription = () => () => {};

/** One rail button and its context menu. Selection stays with the rail. */
export function CommunityRailItem({
  membership,
  icon,
  selected,
  viewer,
  session,
  manager,
  leaving,
  onSelect,
  onOpenTarget,
  onMenuOpen,
  onLeave,
  buttonRef,
}: {
  membership: Membership;
  icon: string | undefined;
  selected: boolean;
  viewer: string | undefined;
  /** The selected community's session once it is ready; never another community's. */
  session: SelectedSession | undefined;
  /** The viewer is an owner or admin of this community, and this build can mint invites. */
  manager: boolean;
  /** A leave request for this community is in flight. */
  leaving: boolean;
  onSelect: (id: string) => void;
  onOpenTarget?: ((target: OpenTarget) => void) | undefined;
  onMenuOpen?: (() => void) | undefined;
  /** Asks the rail to confirm and run a leave; the rail owns the dialog. */
  onLeave: (membership: Membership) => void;
  /** Lets the rail return focus here after its dialogs close. */
  buttonRef?: ((node: HTMLElement | null) => void) | undefined;
}) {
  // A keyboard open anchors to the rail item; a pointer open leaves the anchor
  // to Base UI's cursor point.
  const [menu, setMenu] = useState<{
    anchor: HTMLElement | undefined;
  } | null>(null);
  const button = useRef<HTMLElement | null>(null);
  const navigated = useRef(false);
  // Outlives `menu`, which is already null when the closing menu asks where
  // focus should go.
  const fromKeyboard = useRef(false);
  useEffect(() => {
    if (menu) fromKeyboard.current = menu.anchor !== undefined;
  }, [menu]);
  const notify = useToastNotification();
  const { name } = membership;
  const origin = communityDestination(membership.id).url;
  const scope = viewer ? { viewer, communityOrigin: origin } : undefined;
  /** Both entry points open here, so the roster refresh runs for each. */
  const openMenu = (anchor?: HTMLElement) => {
    navigated.current = false;
    // Some browsers synthesise a contextmenu event for Shift+F10, which re-enters
    // through Base UI while the keyboard open is in flight: the first anchor wins.
    setMenu((current) => current ?? { anchor });
    onMenuOpen?.();
  };
  const openFromKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      openMenu(event.currentTarget);
    }
  };
  const open = (target: OpenTarget) => {
    navigated.current = true;
    onOpenTarget?.(target);
  };
  const copy = () =>
    navigator.clipboard.writeText(origin).then(
      () => notify("Community URL copied.", "success"),
      () => notify("Couldn’t copy the community URL.", "error"),
    );
  return (
    <ContextMenuRoot
      open={menu !== null}
      onOpenChange={(next) => {
        if (next) openMenu();
        else setMenu(null);
      }}
    >
      <ContextMenuTrigger
        render={<div className={styles.item} />}
        onKeyDown={openFromKeyboard}
      >
        <Tooltip content={name} side="right">
          <IconButton
            ref={(node) => {
              button.current = node;
              buttonRef?.(node);
            }}
            aria-label={`Switch to ${name}`}
            aria-current={selected ? "true" : undefined}
            data-selected={selected || undefined}
            icon={
              <Avatar
                size="small"
                shape="squircle"
                alt=""
                fallback={name}
                src={icon}
              />
            }
            onClick={() => onSelect(membership.id)}
          />
        </Tooltip>
      </ContextMenuTrigger>
      <MenuPopup
        aria-label={`Actions for ${name}`}
        size="compact"
        anchor={menu?.anchor}
        side={menu?.anchor ? "right" : "bottom"}
        finalFocus={() => {
          // Opening Settings hands focus to the page, like the account menu does.
          if (navigated.current) {
            const main = document.getElementById("main-content");
            return main && !main.contains(document.activeElement)
              ? main
              : false;
          }
          // A keyboard open came from the rail, so focus goes back there. A
          // pointer open may have interrupted typing elsewhere; Base UI's
          // default restores whatever was focused before.
          return fromKeyboard.current ? (button.current ?? false) : true;
        }}
      >
        <MarkAllReadItem
          name={name}
          selected={selected}
          session={session}
          notify={notify}
        />
        <MenuSeparator />
        <MenuItem onClick={() => void copy()}>
          <MenuIcon>
            <LinkIcon size={14} />
          </MenuIcon>
          Copy community URL
        </MenuItem>
        {selected && manager && scope && onOpenTarget && (
          <MenuItem
            onClick={() =>
              open({
                version: 1,
                kind: "settings",
                section: INVITES_SECTION,
                scope,
              })
            }
          >
            <MenuIcon>
              <TicketIcon size={14} />
            </MenuIcon>
            Invite to community
          </MenuItem>
        )}
        {scope && onOpenTarget && (
          <MenuItem
            onClick={() =>
              open({ version: 1, kind: "settings", section: "profile", scope })
            }
          >
            <MenuIcon>
              <GearIcon size={14} />
            </MenuIcon>
            Community settings
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          tone="danger"
          disabled={leaving}
          onClick={() => {
            if (!leaving) onLeave(membership);
          }}
        >
          <MenuIcon>
            <SignOutIcon size={14} />
          </MenuIcon>
          {leaving ? "Leaving…" : "Leave community"}
        </MenuItem>
      </MenuPopup>
    </ContextMenuRoot>
  );
}

/** Mounted only while the menu is open, so the read-state subscription is too. */
function MarkAllReadItem({
  name,
  selected,
  session,
  notify,
}: {
  name: string;
  selected: boolean;
  session: SelectedSession | undefined;
  notify: ReturnType<typeof useToastNotification>;
}) {
  const noteId = useId();
  const unread = session?.unread;
  const subscribe = useCallback(
    (listener: () => void) =>
      unread ? unread.subscribeSync(listener) : noSubscription(),
    [unread],
  );
  const capability = useSyncExternalStore(
    subscribe,
    () => unread?.sync().capability,
    () => unread?.sync().capability,
  );
  // Read state is session-bound and validated against the relay snapshot, so an
  // inactive community cannot be marked without acquiring it.
  const reason = !selected
    ? "Only the selected community can be marked as read."
    : !unread
      ? `Waiting for ${name} to connect.`
      : capability !== "frontier-sync"
        ? "Read state can’t sync on this connection."
        : undefined;
  return (
    <>
      <MenuItem
        disabled={!!reason}
        aria-describedby={reason ? noteId : undefined}
        onClick={() => {
          if (!unread || reason) return;
          void unread.markAllChannelsRead().then(
            () => notify("Marked all as read.", "success"),
            () => notify("Couldn’t mark everything as read.", "error"),
          );
        }}
      >
        <MenuIcon>
          <ChecksIcon size={14} />
        </MenuIcon>
        Mark all as read
      </MenuItem>
      {reason && <MenuNote id={noteId}>{reason}</MenuNote>}
    </>
  );
}
