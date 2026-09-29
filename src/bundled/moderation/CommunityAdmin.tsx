import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { decode } from "nostr-tools/nip19";
import { communityFromScope } from "../../features/relay/gifs";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { Combobox as BaseCombobox } from "@base-ui/react/combobox";
import {
  usePeople,
  type Recipient,
} from "../../features/direct-messages/usePeople";
import {
  CaretDownIcon,
  CrownIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  ShieldIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import {
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { useCommunityRole } from "../../features/communities/useCommunityRole";
import {
  allowedActions,
  changeMember,
  inviteMintingAvailable,
  mintInvite,
  type Action,
  type Member,
  type MemberChange,
} from "./api";

const DAY = 24 * 60 * 60;
const EXPIRY = [1, 3, 7, 30].map((days) => ({
  value: String(days * DAY),
  label: days === 1 ? "1 day" : `${days} days`,
}));
const USES = [
  { value: "", label: "No limit" },
  ...[1, 5, 10, 25].map((uses) => ({
    value: String(uses),
    label: uses === 1 ? "1 use" : `${uses} uses`,
  })),
];
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
const STALE = "The member list is out of date. Retry before making changes.";
const READ_ONLY =
  "This build can’t create invites or change members, so the member list is read-only here.";

export function CommunityAdmin({
  relay,
  active,
}: {
  relay: RelayData;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  const community =
    connection.status === "ready" && connection.scope
      ? communityFromScope(connection.scope)
      : null;
  return (
    <section aria-labelledby="community-admin-title">
      <h2 id="community-admin-title" className="mt-0 mb-2 text-label">
        Invites
      </h2>
      <p className="text-body-sm text-muted">
        Manage members and community access.
      </p>
      {community && connection.viewer ? (
        <Members
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          community={community}
          viewer={connection.viewer}
          active={active}
        />
      ) : (
        <p role="status">Choose a connected community to manage members.</p>
      )}
    </section>
  );
}

type Pending = { member: Member; action: Action };

function Members({
  session,
  community,
  viewer,
  active,
}: {
  session: RelaySession;
  community: string;
  viewer: string;
  active(): boolean;
}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  // A failed read never erases a confirmed write; it only marks the list stale.
  const { members, role, manager, readError, refreshing, refresh } =
    useCommunityRole(session, community, viewer);
  useEffect(() => {
    if (members) void session.profiles.ensure(members.map((m) => m.pubkey));
  }, [session, members]);
  const stale = !!readError;
  // No new command may start from a roster that is stale or being re-read.
  const locked = stale || refreshing;
  // Invite minting and member changes are broker routes the packaged adapter
  // does not carry, so a native build shows the roster read-only. This is the
  // gate the rail applies to its Invite to community item.
  const canChange = inviteMintingAvailable();
  const baseName = (pubkey: string) =>
    profiles.get(pubkey)?.name || formatPublicKey(pubkey) || pubkey;
  // Every target gets a key qualifier: self-declared names can look identical
  // without being equal strings, so privileged actions must name one identity.
  const qualifiers = publicKeyLabels((members ?? []).map((m) => m.pubkey));
  const name = (pubkey: string) => {
    const base = baseName(pubkey);
    const qualifier = qualifiers.get(pubkey);
    if (!qualifier) return base;
    return profiles.get(pubkey)?.name ? `${base} · ${qualifier}` : qualifier;
  };
  /** Sends one command. Rejects only when the write itself is not confirmed. */
  async function apply(change: MemberChange) {
    if (!active()) return;
    if (locked) {
      setError(STALE);
      throw new Error(STALE);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      try {
        await changeMember(community, change);
      } catch (reason) {
        setError(message(reason));
        throw reason;
      }
      setNotice("Change accepted by the relay.");
      // Stay busy until the roster reflects the write, so no stale row acts.
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const refreshButton = (
    <Button
      loading={refreshing}
      disabled={refreshing || busy}
      onClick={() => void refresh()}
    >
      {readError ? "Retry" : "Refresh"}
    </Button>
  );
  const status = (
    <>
      {notice && (
        <p role="status" className="m-0 text-body-sm">
          {notice}
        </p>
      )}
      {readError && (
        <p role="alert" className="m-0 text-body-sm">
          {readError}
          {members ? " The list below may be out of date." : ""}
        </p>
      )}
    </>
  );
  if (members === undefined) return <p role="status">Loading members…</p>;
  if (members === null || !manager)
    return (
      <div className="mt-4 flex flex-col items-start gap-3">
        {status}
        {!readError && (
          <p role="status" className="m-0">
            {members === null
              ? "This community does not publish a member list, so it has no member administration."
              : "Only community owners and admins can invite people or manage members."}
          </p>
        )}
        {refreshButton}
      </div>
    );
  const needle = query.trim().toLowerCase();
  const shown = members
    .filter(
      (m) =>
        !needle ||
        name(m.pubkey).toLowerCase().includes(needle) ||
        m.pubkey.includes(needle),
    )
    .sort(
      (a, b) =>
        ["owner", "admin", "member"].indexOf(a.role) -
          ["owner", "admin", "member"].indexOf(b.role) ||
        name(a.pubkey).localeCompare(name(b.pubkey)),
    );
  // Revalidate the captured intent against the current roster on every render.
  const target = pending
    ? members.find((m) => m.pubkey === pending.member.pubkey)
    : undefined;
  const confirmable =
    !!pending &&
    !!target &&
    !locked &&
    allowedActions(role, target, target.pubkey === viewer).includes(
      pending.action,
    );
  const verb = {
    promote: "Make admin",
    demote: "Make member",
    remove: "Remove",
  } as const;
  return (
    <>
      <div className="mt-4 flex justify-end gap-2">
        {refreshButton}
        {/* A stale roster cannot prove the viewer still manages this community. */}
        {canChange && !stale && (
          <Button variant="primary" onClick={() => setInviting(true)}>
            Invite to community
          </Button>
        )}
      </div>
      {!canChange && <p className="text-body-sm text-muted">{READ_ONLY}</p>}
      {status}
      {error && (
        <p role="alert" className="text-body-sm">
          {error}
        </p>
      )}
      <h3 className="mt-6 text-label">
        Members <span className="text-muted">{members.length}</span>
      </h3>
      <div className="rounded-xl border border-default p-4">
        <SearchField
          label="Search members"
          placeholder="Search members"
          value={query}
          onValueChange={setQuery}
        />
        <ul className="m-0 mt-3 list-none p-0" aria-label="Members">
          {shown.map((member) => {
            // A stale list must not offer another destructive command, and a
            // native build has no route to carry one.
            const actions =
              stale || !canChange
                ? []
                : allowedActions(role, member, member.pubkey === viewer);
            const label = name(member.pubkey);
            return (
              <li key={member.pubkey} className="flex items-center gap-3 py-2">
                <Avatar
                  src={profiles.get(member.pubkey)?.picture}
                  alt=""
                  fallback={label}
                />
                <div className="min-w-0 flex-1">
                  <p className="m-0 flex min-w-0 items-center gap-1.5 text-body">
                    <span className="truncate">{label}</span>
                    {member.role === "owner" && (
                      <CrownIcon className="shrink-0 text-warning" />
                    )}
                    {member.role === "admin" && (
                      <ShieldIcon className="shrink-0 text-accent" />
                    )}
                  </p>
                  <p className="m-0 text-body-sm text-muted">
                    {member.role[0]?.toUpperCase() + member.role.slice(1)}
                    {member.pubkey === viewer ? " · You" : ""}
                  </p>
                </div>
                {actions.length > 0 && (
                  <MenuRoot>
                    <MenuTrigger
                      render={
                        <IconButton
                          aria-label={`Actions for ${label}`}
                          icon={<DotsThreeIcon />}
                          disabled={busy || refreshing}
                        />
                      }
                    />
                    <MenuPopup align="end">
                      {actions.map((action) => (
                        <MenuItem
                          key={action}
                          onClick={() => setPending({ member, action })}
                        >
                          {verb[action]}
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </MenuRoot>
                )}
              </li>
            );
          })}
        </ul>
        {!shown.length && (
          <p role="status" className="text-body-sm text-muted">
            No members match.
          </p>
        )}
      </div>
      {pending && (
        <AlertDialog
          title={`${verb[pending.action]}: ${name(pending.member.pubkey)}?`}
          description={
            stale
              ? STALE
              : pending.action === "remove"
                ? "They lose access to this community until they are invited again."
                : pending.action === "promote"
                  ? "Admins can invite people and remove members."
                  : "They will no longer be able to invite people or manage members."
          }
          pending={busy}
          onClose={() => setPending(null)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                variant={
                  pending.action === "remove" ? "destructive" : "primary"
                }
                loading={busy}
                disabled={busy || !confirmable}
                onClick={() =>
                  void apply(
                    pending.action === "remove"
                      ? { action: "remove", pubkey: pending.member.pubkey }
                      : {
                          action: "role",
                          pubkey: pending.member.pubkey,
                          role:
                            pending.action === "promote" ? "admin" : "member",
                        },
                  )
                    .then(() => setPending(null))
                    .catch(() => setPending(null))
                }
              >
                {verb[pending.action]}
              </Button>
            </>
          }
        />
      )}
      {canChange && (
        <InviteDialog
          open={inviting}
          close={() => setInviting(false)}
          session={session}
          community={community}
          members={members}
          owner={role === "owner"}
          stale={stale}
          refreshing={refreshing}
          active={active}
          retry={() => void refresh()}
          add={(pubkey, next) => apply({ action: "add", pubkey, role: next })}
        />
      )}
    </>
  );
}

function publicKey(input: string) {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = decode(value);
    if (decoded.type === "npub") return decoded.data;
  } catch {
    // Reported below.
  }
  throw new Error("Enter an npub or 64-character hex public key.");
}

/** Label-left, value-right choice row control, as in the Buzz desktop dialog. */
function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <MenuRoot>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button variant="ghost" size="sm" aria-label={label}>
            {options.find((option) => option.value === value)?.label}
            <CaretDownIcon
              size={14}
              className="buzz-dropdown-chevron"
              aria-hidden="true"
            />
          </Button>
        }
      />
      <MenuPopup align="end">
        <MenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(String(next))}
        >
          {options.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} closeOnClick>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </MenuRoot>
  );
}

const ROLES_OFFERED = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

type Directory = { people: Recipient[]; loading: boolean };
const NO_PEOPLE: Directory = { people: [], loading: false };

function PeopleFeed({
  session,
  query,
  onResult,
}: {
  session: RelaySession;
  query: string;
  onResult(directory: Directory): void;
}) {
  const { people, loading } = usePeople(session, query);
  useEffect(() => onResult({ people, loading }), [people, loading, onResult]);
  return null;
}

/** One field: search the directory or paste an npub/hex key. */
function PersonSearch({
  session,
  members,
  disabled,
  onSelect,
}: {
  session: RelaySession;
  members: readonly Member[];
  disabled: boolean;
  onSelect(person: Recipient, label: string): void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<Directory>(NO_PEOPLE);
  const isMember = (pubkey: string) => members.some((m) => m.pubkey === pubkey);
  let direct: string | null = null;
  try {
    direct = query.trim() ? publicKey(query) : null;
  } catch {
    // Not a key; search by name only.
  }
  const found = query.trim()
    ? directory.people.filter(
        (person) =>
          person.pubkey !== session.viewer && !isMember(person.pubkey),
      )
    : [];
  const people: Recipient[] =
    direct && !isMember(direct) && !found.some((p) => p.pubkey === direct)
      ? [{ pubkey: direct, name: "" }, ...found]
      : found;
  // Names are self-declared; every choice shows a key label unique among them.
  const keys = publicKeyLabels(people.map((person) => person.pubkey));
  const label = (person: Recipient) => {
    const key = keys.get(person.pubkey) ?? person.pubkey;
    return person.name ? `${person.name} · ${key}` : key;
  };
  return (
    <>
      {/* Only search while there is text; browsing would page the whole directory. */}
      {query.trim() && (
        <PeopleFeed
          session={session}
          query={query.trim()}
          onResult={setDirectory}
        />
      )}
      <BaseCombobox.Root<Recipient>
        items={people}
        filter={null}
        value={null}
        inputValue={query}
        open={open && !!query.trim()}
        onOpenChange={setOpen}
        onInputValueChange={(value, details) => {
          if (
            details.reason === "input-change" ||
            details.reason === "input-clear"
          ) {
            setQuery(value);
            setOpen(true);
          }
        }}
        onValueChange={(person) => {
          if (!person) return;
          setQuery("");
          onSelect(person, label(person));
        }}
        itemToStringLabel={label}
        isItemEqualToValue={(a, b) => a.pubkey === b.pubkey}
        disabled={disabled}
      >
        <BaseCombobox.InputGroup
          render={
            <InputGroup
              leading={<MagnifyingGlassIcon size={16} aria-hidden="true" />}
            />
          }
        >
          <BaseCombobox.Input
            data-buzz-ui=""
            className="buzz-input"
            aria-label="Search people or paste an npub"
            placeholder="Search people or paste an npub"
            autoComplete="off"
            spellCheck={false}
          />
        </BaseCombobox.InputGroup>
        <Combobox.Popup
          empty={
            directory.loading
              ? "Searching…"
              : "No people found. Paste a full npub or hex public key to add someone directly."
          }
        >
          <Combobox.List>
            {(person: Recipient) => (
              <Combobox.Item
                key={person.pubkey}
                value={person}
                description={person.name ? undefined : "Public key"}
              >
                <span className="flex items-center gap-3">
                  <Avatar
                    src={session.media(person.picture ?? "", "small")}
                    alt=""
                    fallback={person.name || person.pubkey}
                    size="small"
                    shape={person.isAgent ? "squircle" : "circle"}
                  />
                  <span className="truncate">{label(person)}</span>
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </BaseCombobox.Root>
      {direct && isMember(direct) && (
        <p role="alert" className="m-0 text-body-sm">
          This person is already a community member.
        </p>
      )}
    </>
  );
}

function InviteDialog({
  open,
  close,
  session,
  community,
  members,
  owner,
  stale,
  refreshing,
  active,
  retry,
  add,
}: {
  open: boolean;
  close(): void;
  session: RelaySession;
  community: string;
  members: readonly Member[];
  owner: boolean;
  stale: boolean;
  refreshing: boolean;
  active(): boolean;
  retry(): void;
  add(pubkey: string, role: "admin" | "member"): Promise<void>;
}) {
  const [ttl, setTtl] = useState(String(3 * DAY));
  const [uses, setUses] = useState("");
  const [person, setPerson] = useState<(Recipient & { label: string }) | null>(
    null,
  );
  const [role, setRole] = useState<"admin" | "member">("member");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  // One minted link per settings; a missing entry for these settings mints.
  const settings = `${ttl}:${uses}`;
  const [link, setLink] = useState<{
    settings: string;
    url?: string;
    failed?: boolean;
  } | null>(null);
  const minting = useRef(0);
  // StrictMode replays effects; never mint twice for the same settings.
  const requested = useRef("");
  const current = link?.settings === settings ? link : null;
  const locked = stale || refreshing;
  useEffect(() => {
    // Opening the dialog, or changing its settings, creates the link to share.
    if (!open || locked || current || requested.current === settings) return;
    if (!active()) return;
    requested.current = settings;
    const request = ++minting.current;
    setLink({ settings });
    setCopied(false);
    setError("");
    mintInvite(community, Number(ttl), uses ? Number(uses) : null).then(
      (invite) => {
        if (minting.current === request) setLink({ settings, url: invite.url });
      },
      (reason) => {
        if (minting.current !== request) return;
        requested.current = "";
        setLink({ settings, failed: true });
        setError(message(reason));
      },
    );
  }, [open, locked, current, active, community, settings, ttl, uses]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const url = current?.url;
  const pending = !!current && !url && !current.failed;
  async function invite() {
    if (!person || !active() || locked || adding) return;
    setAdding(true);
    setError("");
    setNotice("");
    try {
      await add(person.pubkey, owner ? role : "member");
      setPerson(null);
      setRole("member");
      setNotice("Member added.");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setAdding(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        minting.current++;
        requested.current = "";
        setLink(null);
        setTtl(String(3 * DAY));
        setUses("");
        setPerson(null);
        setRole("member");
        setError("");
        setNotice("");
        close();
      }}
      preventClose={adding}
      title="Invite to community"
      description="Add someone directly or share a link they can use to join."
    >
      <div className="flex flex-col gap-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {person ? (
              <InputGroup>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Avatar
                    src={session.media(person.picture ?? "", "small")}
                    alt=""
                    fallback={person.label}
                    size="small"
                    shape={person.isAgent ? "squircle" : "circle"}
                  />
                  <span className="truncate text-body">{person.label}</span>
                  <IconButton
                    aria-label={`Remove ${person.label}`}
                    size="sm"
                    icon={<XIcon size={12} aria-hidden="true" />}
                    disabled={adding}
                    onClick={() => setPerson(null)}
                  />
                </span>
                {owner && (
                  <Choice
                    label="Choose member role"
                    value={role}
                    options={ROLES_OFFERED}
                    onChange={(value) => setRole(value as "admin" | "member")}
                    disabled={adding}
                  />
                )}
              </InputGroup>
            ) : (
              <PersonSearch
                session={session}
                members={members}
                disabled={adding}
                onSelect={(chosen, label) => setPerson({ ...chosen, label })}
              />
            )}
          </div>
          {person && (
            <Button
              type="submit"
              variant="primary"
              loading={adding}
              disabled={adding || locked}
            >
              Invite
            </Button>
          )}
        </form>
        <div className="flex items-center gap-3 text-body-sm text-muted">
          <hr className="m-0 flex-1 border-default" />
          Or, copy a link
          <hr className="m-0 flex-1 border-default" />
        </div>
        <InputGroup>
          <Input
            aria-label="Community invite link"
            readOnly
            value={url ?? ""}
            placeholder={
              current?.failed
                ? "Couldn’t create invite link"
                : locked && !current
                  ? "Retry the member list to create a link"
                  : "Creating invite link…"
            }
          />
          <Button
            size="sm"
            loading={pending}
            disabled={current?.failed ? locked : !url}
            onClick={() => {
              if (current?.failed) {
                setLink(null);
                return;
              }
              if (!url) return;
              navigator.clipboard
                .writeText(url)
                .then(() => {
                  setCopied(true);
                  setNotice("Invite link copied.");
                })
                .catch(() => setError("Could not copy the invite link."));
            }}
          >
            {current?.failed ? "Retry" : copied ? "Copied" : "Copy link"}
          </Button>
        </InputGroup>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-4">
            <span className="text-label-sm">Expires after</span>
            <Choice
              label="Choose invite expiry"
              value={ttl}
              options={EXPIRY}
              onChange={setTtl}
              disabled={pending || locked}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-label-sm">Limit number of uses</span>
            <Choice
              label="Choose maximum invite uses"
              value={uses}
              options={USES}
              onChange={setUses}
              disabled={pending || locked}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="m-0 text-body-sm">
            {error}
          </p>
        )}
        {stale && !adding && (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="m-0 text-body-sm">
              {STALE}
            </p>
            <Button
              size="sm"
              loading={refreshing}
              disabled={refreshing}
              onClick={retry}
            >
              Retry
            </Button>
          </div>
        )}
        {notice && (
          <p role="status" className="m-0 text-body-sm">
            {notice}
          </p>
        )}
      </div>
    </Dialog>
  );
}
