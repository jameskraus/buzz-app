# Channels, relay data, and plugin panels

## Run the integration

Configure your public `BUZZ_DEV_VIEWER` pin in `.env.local` using the
[development setup](../README.md#relay-channels), then run `just web` or
`just desktop` (one at a time); the development broker starts with the dev server.
Add a community using the top-left community switcher, open Messages and click a supported GitHub URL in a message to open its object
in a side panel. Pull requests show title, state, author, branches, change counts,
and description; issues, commits, and repositories show their relevant details.
The panel reads GitHub's public API on demand. Private or unavailable objects and
API limits show an explanation with a direct GitHub link. File and branch links
continue to open normally. No GitHub account connection is configured yet.

Descriptions support GitHub-flavored Markdown with inline images, video, and
audio. Other files remain links; media that cannot load keeps a fallback link.
Use **Open on GitHub** for attachments that require repository access.

On desktop, an ordinary click on an unhandled HTTP(S) link with
`target="_blank"` uses the native Tauri opener to launch the default browser,
including attachments and **Open on GitHub**. A plugin that handles the click prevents that fallback; disabling
GitHub restores it. The main-window capability allows only HTTP(S) URLs, not
arbitrary file paths or application commands. Web keeps ordinary browser link
behavior. Adding the native opener requires rebuilding/restarting desktop;
frontend hot reload alone is not enough.

Settings independently enables/disables Channels and GitHub. Disabling GitHub
removes its link handler and open panel; shared channel data remains available.
Channels is required by the current host; optional page removal does not dispose
the app-owned sidebar or session data.

The broker uses the existing authorized Buzz identity in the OS secret store (macOS
Keychain, Linux secret service) and
signs authenticated reads and channel messages in Node. In this broker mode no
private key reaches browser JavaScript; there is a bounded message-signing and
publishing endpoint. The broker is restricted to loopback hosts, same-origin
POSTs, valid Nostr kinds/event IDs, and bounded filters. Without a configured
`BUZZ_DEV_VIEWER` pin, native macOS offers [identity setup](identity.md); web and
unsupported native platforms retain the unavailable shell. The separate native
import/reveal/copy UI deliberately passes private strings through JavaScript.
Packaged builds do not include the development broker. A saved native identity
does not enable relay access: join and community profile editing stay unavailable.
The broker supports explicitly scoped typed relay origins;
see [destination routing and trust limits](communities.md#development-broker-boundary).
This is not a new native login.

## Ownership

- `app/services.ts` constructs client/community, pages, and panels services.
  See [community ownership](communities.md) for selection and join lifetimes.
- `features/relay` owns the [session query core](relay-queries.md), shared profiles,
  and retained channel snapshots. Components use
  its React hooks without creating connections or owning persistence.
- `features/panels` owns target resolution and panel rendering. Panels receive
  `{ target, close }`; their plugins inject additional capabilities as needed.
- `features/messages` owns reusable `ChannelTimeline`, `MessageRow`, `ThreadPanel`,
  `MessageComposer`, delivery presentation, styles and reading geometry. They accept
  ordinary props over the shared session; none owns a connection or outbox.
- `features/channel-navigation` owns the persistent sidebar and its scoped UI handoff
  for session draft rows and preparing DMs. App composes it beside independent pages;
  sidebar actions use the normal navigation controller. It reuses session capabilities
  and existing sidebar components without another relay/cache or plugin registry.
- `bundled/channels` owns page registration, conversation selection/navigation,
  diagnostics, layout and panel placement. `shared/view-state.ts` partitions persisted
  drafts and view intent by community/viewer scope.
- `bundled/github` registers and implements the panel. Channels uses the panel
  contract and does not import the GitHub implementation.
- `plugins/contributions.ts` owns registration identity, readiness, and disposal
  for both extension points.

See [plugin architecture](plugin-architecture.md) for the authoring contracts.
To build another page, follow `bundled/channels/index.tsx`: declare injected
capabilities, register the page, and pass those capabilities to its React tree.
Keep page-specific navigation and arrangement in the plugin; compose shared message
components rather than copying them. Session reconciliation, authorization, retained
reads and durable outbox recovery remain host-owned even if Channels is disabled.

The sidebar and Channels workspace React keys include community/viewer scope **and**
connection generation. This resets their session-owned state on switching or
reconnecting, not unrelated page drafts;
drafts, channel selection and reading geometry retain their stable scope keys.

Saved sidebar groups, ordering, assignments, stars, mutes and sorting live in the
session's `sidebarPreferences` snapshot, not in the mounted Messages page. `ensure()` shares
one initial read; `refresh()` explicitly reloads/retries while retaining the last
good snapshot through loading/errors. Page exits neither restart nor cancel that
read. Cache clearing and session disposal cancel it and discard decoded data;
late completion cannot repopulate a retired snapshot. These are account-owned
preferences, not channel access grants: sidebar sections still intersect the
authorized roster. Local-first launch also restores a display-only copy from the
existing account/relay-scoped device store; this does not add automatic cross-device sync.

The development broker and packaged native host expose narrow **Mute/Unmute** commands. Each
re-reads the viewer's signed encrypted `channel-mutes` coordinate, changes only the
requested entry, publishes through existing relay admission, and confirms via
readback. The development broker publishes through its existing authenticated live
socket, scoped to the requesting session/community; a missing or disconnected owner
fails without HTTP fallback or automatic replay. Packaged native uses the signed
`POST /events` writer and never automatically replays an unconfirmed write.
Unrelated fields and explicit unmute tombstones survive. Invalid, unreadable, or over-budget heads fail closed; only a successful absent-head read
can seed a record. Same-host writes serialize per relay. This is confirmed
whole-record replacement, not atomic cross-device merging or a durable outbox;
simultaneous writers on different hosts can still race. Failure requires explicit
retry. Group/star writes use their separate narrow commands;
[section sorting](#sidebar-sort-persistence) uses its separate preference coordinate.

Rows expose mute/read actions through right-click/long-press, Shift+F10, or the
Context Menu key. They extend the persistent sidebar’s existing menu after
**New session**, separated from session entry; DM removal stays separate.
Mute closes immediately and optimistically changes the next menu action, not
unread truth or notification policy before confirmation. Failure rolls back to
confirmed state and shows an app notification with Retry (same intent) and Dismiss.
Newer clicks supersede older completion UI; session-owned writes and sidebar
pending/error presentation survive page switches. Session replacement discards
that presentation. Cache clear/disposal abort
pending work but cannot retract an accepted relay publication.

Mark as Read delegates to the [durable unread owner](unread.md), without selecting
the row, and closes after the local transaction commits. Observed unread or a
manual mark offers **Mark as Read**; otherwise the menu offers **Mark as Unread**
with its device-only tooltip. An open menu subscribes to the shared projection,
without fetching history or inventing exact counts. Read errors remain in-menu
for explicit retry. Focus resolves the current row by identity even if saved
preferences relocated it during the transaction. Read actions require
`frontier-sync`; hosts lacking mute writes keep read-only preference projection.
The packaged host decodes verified self-encrypted sidebar records and signs
only validated sidebar coordinates; it uses its signed HTTP writer and confirms
via readback. Sidebar records and channel recipes share kind 30078, so that
writer selects the admission contract by the event's `d` coordinate: the four
sidebar coordinates must match what the sidebar signer produces, and every
other coordinate must satisfy the recipe contract.

Move channel, Create new, exclusive Starred placement and startup presentation also
belong to this persistent sidebar. Rows in saved groups and **Channels** can also be
dragged with a pointer onto another saved group or **Channels**; the drop is the same
Move intent, with the same gate, optimistic placement, rollback notice and Retry.
Only a channel's select surface starts a drag, the surface its row menu wraps; its
sessions and session draft do not.
Starred, Forums and Direct messages take no part in dragging, and the row menu
remains the keyboard path. The session serializes placement, sort and mute
writes through one queue, retaining one confirmed preferences snapshot beneath
pending Move and Sort projections. Each confirmation updates only its owned fields
before reapplying pending intent; failure cannot roll back unrelated confirmed
state. Field-only confirmations cannot recover a failed full preference read or
hide its Retry. Move stays gated until that read succeeds. Mute optimism remains
presentation-only; notification policy continues to use confirmed mutes. This
composition does not change the whole-record cross-device limitation below.

Collapsed section keys and sidebar scroll remain separate, scoped view intent.
They survive page switches in the same mounted sidebar, are saved when that
sidebar exits its session, and restore before paint when the roster and groups
are available; navigation history does not own them. Search lives in the top-bar
palette; legacy sidebar filters are ignored. The saved-groups
browser regression records every visible return frame and holds the redundant
decode path, so eventual restoration cannot conceal a fallback-group/scroll jump.

Channel row actions share one sidebar-owned `ContextMenuRoot` / `MenuPopup`, labelled
`Actions for <channel>`. **New session** comes first; additional sidebar actions
should extend that popup, with a separator only when another action group follows.
`ChannelSidebarItem` owns the context trigger inside its memo boundary, using stable
`onOpenMenu` props. It wraps the activity select surface rather than merging popup
props onto the activity button; session disclosure and child rows stay outside.
The popup and trigger are enabled only when `rowActions` supplies actual items;
each action owns its eligibility, so Sessions availability never gates sibling
actions. `useChannelRowMenu` owns channel id, the full rendered section key
(`starred`, `channels`, `group:<id>`, etc.), and the keyboard anchor. It clears
that state if the row leaves that section or loses its last action; moving back
or restoring eligibility does not reopen the menu. For future group commands,
derive the saved group id separately from `group:<id>` rather than conflating it
with rendered placement. Right-clicking the separate session disclosure remains
outside the parent menu trigger, as do child-session rows.

Sidebar create-channel dialogs stay available on other pages. Channel admission
(creation plus verified viewer membership) is fenced to the originating relay
session and navigates to a normal conversation destination. Remaining template
setup continues in that session; failure produces a dismissible notice without
navigating again. Frozen setup receipts and delivery evidence remain saved, but
there is no template Resume or automatic startup continuation. An uncertain
admission keeps the original form locked to its channel identity. **Retry channel**
checks that creation first; if delivery remains unknown, an explicit click may
republish only the exact saved Create event, with the same UUID and signature.
It never continues template writes or retries in the background. Successful recovery opens that channel and reports
any unfinished setup for manual inspection. Closing/reopening retains the attempt;
after session replacement, unresolved ordinary creations (including pre-upgrade
Outbox entries) restore for the same identity-preserving retry. Already-admitted partial
setups do not occupy a new Create form. New-session intent uses the Channels version-1
page route `{ kind: "new-session", parentId }`; Channels checks parent access/type
and Sessions availability. Only parent intent, never draft text, enters history.
Preparing-DM suppression captures the pre-open roster and exact member set, hiding
only newly prepared DMs until confirmation; leaving New message or replacing the
session clears that handoff. Timeline readers and reading leases stay in visible
conversation content and unmount when leaving Messages.

## Sidebar sort persistence

Each sidebar section can independently select **A–Z** (the default) or **Recent**.
The development broker and packaged native host save these choices in the desktop-compatible encrypted
kind-30078 `channel-sort` record: `{ version: 1, groups: { ... }, meta: { v: 1, g: { ... } } }`.
A–Z writes a null register and removes that group's legacy override. Sections use
`meta: { v: 1, s: { ... }, a: { ... } }`: per-section name/icon/order/live registers
and per-channel assignments. Upgraded readers project metadata as authoritative;
writers regenerate the legacy fields and preserve unrelated registers, including
section deletion (`live=false`) and assignment/sort reset (`null`) tombstones.
Stars and mutes keep their existing `updatedAt` entries, not this register schema.

A register is `[version, device, value]`, with a nonnegative safe-integer millisecond
version and 16 lowercase hex device ID. Meta-less relay heads import at event
seconds × 1,000 with the zero device ID. Edits exceed every observed register
version and use a random in-memory device ID. Sections sort by canonical `(order,id)`
and project dense display orders; new sections append after the canonical live
maximum. Orphan assignments are omitted from the legacy projection, not deleted
from metadata. Read projection accepts Desktop string values on retained section
name/icon registers; only projected live text receives UI length limits. Already
satisfied intents return without rewriting the head, including assignment removal
when its register is absent, explicitly null, or points to a nonprojecting section.
Actual rewrites still reject
out-of-policy retained values rather than dropping or truncating them.
Unsupported/malformed metadata fails closed, including unknown fields;
this is not general forward-schema salvage. Live projection caps remain 100
sections, 1,000 assignments and 104 sort overrides; retained tombstones are bounded
by the existing 128 KiB plaintext budget, not live counts. Native signing/admission
additionally requires legacy fields to equal the validated register projection.

Saving preserves unrelated top-level fields and known register choices present in
the strong head read before publication. This is wire-format compatibility, not
the older Desktop's local-authoritative register cache or automatic reconciler.

Persistence is **whole-record last-write-wins**, not conflict-safe per-section
merging. Two devices can read the same record and save different sections; the
winning replacement can silently erase the other device's choice even when both
saves report success. The broker's mutation queue serializes its own writes only.
Read-back checks the requested section at that moment; it cannot detect an unseen
choice overwritten in another section or guarantee preservation against later
writes. “Independent” describes selecting a mode per section, not simultaneous
cross-device save guarantees. Retaining the shared record preserves compatibility
with existing desktop writers; convergence across unseen heads would require a
separately designed reconciliation lifecycle or atomic relay support.

`dev/sidebar-sort.test.mjs` deterministically exercises that accepted limitation
through the real mutation helper: another section saves and confirms between a
read and publication, then the stale whole-record replacement wins and also
confirms. This is contract coverage, not a concurrency fix.

## Starting a direct message

The **+** action in the DMs sidebar header opens **New message**, a routed empty
conversation in Messages. The header remains available before the first DM exists. Its inline **To:**
field owns a paginated people picker and up to eight recipient chips, excluding
this viewer. Agent profiles are offered only when their exact public key appears
in the ready native control snapshot for this community. Public profile hints and
the compatibility library do not establish control; this filter also applies to
searches and cached results. Selected agent chips are revalidated against the
current ready control snapshot before a fresh open and again before enqueueing.
Already queued messages retain exact-event recovery. Namesake identities show
unambiguous shared public-key labels in their options and selected chips. Human profiles remain available while controls load
or fail. The shared popover hugs shorter result lists up to ten rows (or available
viewport space), then scrolls. Search placeholders retain the previous result count
within that cap. An initial 15-profile preview paints first; bounded background batches
continue without scrolling, including for searches. Pages containing only excluded
agents keep loading; an empty result is shown only after all matching pages finish.
Directory reads use the verified scheduler without
admitting browse results into shared conversation profiles, so a large directory
cannot evict sidebar names. Each incoming batch shares the mention pickers' name
ranking, but new identities append so visible rows never reshuffle. This is not a
globally alphabetical directory: the relay pages by profile update time. Completed
pages and recent searches stay in memory for this account/community session, so
returning or clearing a search resumes the same results. Typing immediately filters
loaded names without replacing local matches with a loading placeholder. Once the
browse directory is complete, searches stay local; while it is incomplete, remote
matches can append in the background. A failed background read
keeps existing people visible and offers retry. Mentions retain their conversation-specific
eligibility. Before a DM exists, a composer-local `DraftMentionRoster` supplies
only the selected recipient identities and names to both mention tools. Removing
a selection updates both menus; an already-inserted mention still requires actual
DM membership on Send. Mentioning never opens the DM early or adds recipients.
The existing `MessageComposer` owns the draft and ordinary input behavior. Its placeholder is blank before selection and lists the selected names
afterward. Disabled mention and emoji icons stay unfilled. No timeline is mounted before the first message is confirmed. DMs omit the date
pill at the beginning of their complete history, while retaining message times
and date separators between days.

`features/direct-messages` owns selection, scoped view intent, and the isolated
chip-removal effect. The five-frame effect lasts 400 ms (a gentler 180 ms fade
with reduced motion); audio is best effort. The copied assets retain their MIT
notice in `public/recipient-removal/LICENSE.txt`.

The relay session exposes `directMessages` over its existing verified reader and
outbox. People are kind-0 pages: a 15-profile browse preview (30 for search), followed by
30-profile browse batches. Searches retain 30-profile pages because profile metadata
can be large enough to exceed the read budget in larger batches. Remote name
searches are debounced by 150 ms.
Opening uses the development broker's purpose-bound `/direct-message` endpoint:
it signs kind 41010 with one to eight distinct other participant keys, checks the
exact command receipt, and returns the canonical channel ID. A unique client tag
allows reissuing this participant-set command after a lost response without
receiving a generic duplicate-event receipt. No private key or arbitrary signing
capability is exposed to the page. Other host adapters report this capability as
unavailable until they implement it.

Before sending, the session requires signed DM metadata and an exact signed roster
containing the viewer and selected people. The first kind-9 message then uses the
normal durable outbox. Navigation waits for an accepted receipt or verified echo.
A failure retains recipients and draft; an uncertain delivery retries its exact
event ID. The outbox persists recovery metadata with the operation before publication and
retains it through confirmed delivery until the composer durably acknowledges it.
Hydration must finish before a fresh send; one recovery key prevents duplicate
first sends. Definitively failed operations restore newer editable draft and recipient
views; uncertain operations keep their durable recovery payload authoritative.
Before acknowledgement retires recovery, saved views are removed and their absence
is verified. Cleanup failure retains recovery for confirmation-only retry. A page
reopened during acknowledgement resets its recovered editor when retirement finishes.
Local storage is a convenience for editable drafts. Only a
definitively failed recovery operation can be removed (including through
Diagnostics), releasing the preserved draft for editing or a changed recipient set. A changed set also invalidates the prepared destination.
Page exit cancels preparation and its delivery waiter, while the outbox retains
ownership of already queued messages. Reopening recovers the pending event rather
than enqueueing a duplicate.

Focused coverage lives in `NewMessage.test.tsx`, `direct-messages.test.ts`,
`relay-broker-api.test.mjs`, and the Chromium/WebKit `new-message.spec.mjs` journey.
The browser journey uses the production app and broker with ephemeral identities
and modeled upstream I/O; it does not send messages to a live community.

## Channel header actions

The conversation header’s **Channel actions** ellipsis opens the shared, default-size
(non-compact) menu. **View channel details** is first and opens or focuses the existing
Channel Settings tab; selecting it again never closes the pane. Editing is available
from that pane, not directly from the menu. **View canvas**, optional **Save as template…** and
**New session**, **Move channel**, **Mute/Unmute**, and **Mark as Read/Unread**
reuse the sidebar’s action composition and persistent mutation/recovery owners.
Move replaces the redundant Personal group shortcut. Permission-gated lifecycle
actions follow in **Leave → Archive → Delete** order, with Delete in the shared
danger tone. DMs retain Hide conversation and the separate Remove from Messages
action; their permissions are not inferred from stream channels. Members retains its adjacent button and Diagnostics remains inside Settings.
Session headings are unchanged. Header moves and dialog cancellation return focus
to the ellipsis, while session creation hands focus to its composer. Read-only, cached, archived and DM eligibility stays
with the existing capabilities. Opening the menu reads permissions, never publishes
a lifecycle command. Menu Escape/outside dismissal returns to the header; Canvas, template
and lifecycle confirmation cancellation also return there. Dialog owners outlive menu dismissal,
while channel/session navigation retires header-origin dialogs. Canvas is bound to
its opening channel and visit, so navigation never mounts another channel’s editor.
The sidebar’s own dialogs and session-owned writes/recovery keep their existing
lifetime; retiring a header does not undo a command already sent. The redundant Canvas card and saved-content
preview are omitted from Channel Settings; opening details does not read Canvas.

## Channel lifecycle

Lifecycle actions extend the persistent sidebar’s existing context popup after
New session and the mute/read group. Lifecycle items use shared leading icons and
a separator only when they resolve and earlier actions exist. Right-click
and keyboard access reuse the existing row trigger; no ⋮ control or second popup
is added. Session creation, attention actions and child-session navigation keep
their existing owners; sessions do not receive lifecycle actions. Move/Star/grouping
controls share this popup with independent eligibility; lifecycle actions do not
change shared-menu styling.

The row menu resolves fresh relay-authored metadata (`39000`), administrators
(`39001`) and membership (`39002`) at exact channel coordinates before offering
Archive/Unarchive/Delete/Leave or DM Hide. Archive and Unarchive require a direct
owner/admin role;
Delete is offered to a direct owner or a member with verified ownership evidence
for an owner-role agent; the last direct owner cannot Leave. The menu omits Leave
when it is forbidden, without an ownership-transfer explanation. Action labels
have no trailing ellipsis. DMs offer Hide only.

Owner-agent eligibility follows the desktop's profile-based UX: read the channel
owners' latest signed kind-0 profiles in bounded exact-author batches, then verify
the unique NIP-OA tag, target binding, owner signature and conditions against the
profile event. Display-only owner fields and agent hints never qualify. The
existing shared verifier owns these checks; no new relay query or deployment is
needed. Direct owners, DMs, archived channels and Archive/Unarchive/Leave
execution do not require these optional profile reads. A failed five-second owner-profile lookup
preserves independently established Archive/Leave, omits Delete and exposes
"Delete check unavailable" with explicit retry in both surfaces. Settings keeps
its retry button focusable and busy during a fresh read, without retaining stale
actions. Pending progress stays inside the button spinner, not a duplicate visible
status sentence. If focus is still on recovery when the read finishes, it moves to the
retry, an allowed action (Delete first), or a no-actions status. Moving focus
elsewhere while waiting cancels that handoff.

**Profile provenance is not the relay's persisted authorization mapping.** It is
an eligibility hint for offering an attempt, not proof the command will succeed.
A profile without the attestation may hide Delete from a human the relay would
accept; a conflicting valid attestation may expose an attempt the relay rejects.
Profile replacement does not establish relay ownership transfer or revocation.
The viewer signs the unchanged Delete command and the relay enforces its stored
ownership and current channel state. A definitive rejection retains the channel
and recoverable confirmation; uncertain delivery still blocks blind resubmission.
Archive/Unarchive/Leave depend only on the viewer's own channel role. Existing
membership requirements remain; nonmember access, owner-agent Archive/Unarchive authority and
community-admin overrides are not added.
Membership accepts NIP-29 `p` tags with optional relay and role fields
(`["p", pubkey, relay_hint?, role?]`), including the relay's four-field roster.
These fields never substitute for the separate administrator record. Invalid
member keys and duplicate entries still fail closed. Failed menu permission reads
show "Channel actions unavailable" with retry, not raw protocol errors. Pending
permission reads show neither a loading row nor a lifecycle separator; the
separator appears with the resolved actions or unavailable/retry section, and is
omitted when there are no lifecycle items. Actions appear only after verification.

Channel Settings also offers **Leave channel**, **Archive channel** and **Delete
channel** in its tools area, using one fresh lifecycle permission check. Each
entry follows its own permission result: a last owner can Archive/Delete even
though Leave is forbidden, while an ordinary admin without owner-agent evidence can Archive but not Delete.
Forbidden entries are omitted; failed checks offer retry and unsupported
connections explain unavailability. DMs, sessions and read-only nonmember/cached views have no channel
lifecycle entries. Archived channels cannot be deleted:
the relay rejects Delete while archived. A direct owner/admin can restore it with
**Unarchive channel**, which replaces Archive in the same Settings position, before
deletion.
These controls hand off to the same persistent sidebar confirmation/navigation
owner, so confirmed removal can unmount Settings without cancelling completion.
Cancellation returns focus to the originating Settings button (or the sidebar
fallback if that entry has gone away). Archive retains the current conversation,
messages, membership and open Settings, replacing Archive with Unarchive after a
fresh permission read. The conversation stays selected after reload; archived
write restrictions still apply. When refreshed Settings actions remount, focus
returns to its persistent Settings-tab close control instead of an unrelated sidebar row;
joined archived channels remain available by name in search, labeled **Archived
channel**, but stay out of the sidebar and Recent activity. Open the search result
and Settings to restore it. This uses the existing membership discovery and exact
navigation, not a new archived-channel directory or nonmember discovery.
Unarchive publishes the existing narrow `9002` command with `archived=false` and
requires fresh relay metadata with a missing/false archive tag before updating
shared discovery; a missing record is not success. Restoration returns the sidebar
row and keeps the current conversation and Settings open, with fresh actions.
When upgrading an already-running development server, restart the **Node process**
before trying Unarchive: Vite's in-process restart can retain the broker's imported
archive-only validator even while the browser has the new action. A page reload
alone does not update that host module.
Archive, Unarchive and Leave use the default button style in Settings. Archive,
Unarchive, Leave and Hide confirmation primary actions use the prominent variant; Delete remains destructive and Cancel
keeps the default secondary style. Every shared confirmation shows its pending
state inside the primary button using the standard loading spinner (with an
accessible status), without adding a visible status paragraph. Duplicate submission
and Cancel/Escape remain blocked until the operation settles; rejection restores
the action, while an uncertain outcome still blocks blind resubmission.
Delete keeps the named-channel warning and destructive confirmation button without
requiring the channel name to be typed. Metadata and member-role editing remain
separate.

Each command has explicit confirmation. The lifecycle owner rechecks signed channel state and, for owner-agent Delete,
profile eligibility before signing and again before publication, validates
the returned command, and confirms relay-owned state before removing a row. Archive retains membership;
confirmed Delete/Leave use the existing access-loss purge. Commands use narrow
development-broker routes or the packaged native `relay_channel_sign` and
`relay_channel_publish` commands, never the message outbox or automatic replay.
Both hosts admit only the exact two-tag `9002` shape with `archived=true` (Archive)
or `archived=false` (Unarchive); other values, extra tags, cross-route commands and
altered or foreign signatures are rejected. Hosts without this capability display
an unavailable notice. Native Unarchive requires rebuilding/restarting the desktop
binary; updating the frontend alone does not update the Rust validator. Rust
validator and production-IPC tests cover both values, but do not establish an
installed desktop Archive → Unarchive round trip against a live relay; that
acceptance remains outstanding.

Main’s DM × remains local removal, including restoration on new message evidence.
The separate, confirmed Hide conversation action publishes `41012`, not Leave or Delete. The separate relay-authored `30622`
visibility snapshot (`d=viewer`, `p=viewer`, hidden DM `h` tags) only filters sidebar
rows; it does not deny access or prevent exact conversation navigation. Visibility
refreshes with the channel roster, preserves the last good set on failure and
rejects older snapshots. Live cross-device visibility updates and an in-app DM
reopen/unhide flow are deferred; opening a DM through another supported client's
`41010` flow and refreshing restores the row.

A definitive rejection offers retry without optimistic removal. If publication or
confirmation has an uncertain outcome, the dialog warns that the command may have
taken effect, disables blind resubmission and asks the user to close and refresh
channels. Cancellation/cache clear/session replacement fence late results but cannot
retract a request already sent. Cancellation returns focus to the originating row;
confirmed Delete, Leave or Hide moves an active conversation to another available destination
(or the neutral Messages page) with a visible sidebar-row focus fallback. Last-row
Delete/Leave/Hide completion uses the explicit version-1 Channels route `"empty"`, which bypasses
saved/default conversation selection, including after reload. Retained archived or
hidden membership cannot reopen itself through that destination; intentional exact
navigation to a hidden DM remains supported.

## Channel-management modal dismissal

Channel-management modals explicitly opt into the shared Dialog's backdrop-click
cancellation. Canvas, Members, lifecycle confirmations, new sections, personal
groups and templates/teams use the same Close/Cancel path for outside clicks.
Create and Edit details use their Close path: untouched forms close immediately;
changed drafts require discard confirmation, while explicit Cancel discards immediately.
Clicks inside or in portaled controls do not dismiss them.
The non-modal Settings panel is unchanged; the shared Dialog default stays opt-in.

Canvas reload, template/team deletion and template replacement use nested shared
Dialogs rather than host-owned confirmation prompts. Cancel, Close, Escape or a
backdrop click dismisses only that confirmation, keeps the parent draft/library,
and never executes the action. Confirmations initially focus Cancel and return
focus to their initiating control; lifecycle focus remains sidebar-owned.

Existing pending operations continue to block dismissal. Members remains closable
while session-owned invitations/recovery continue. Canvas keeps its local draft;
uncertain Create/Edit and lifecycle outcomes retain their existing recovery rules.
No dismissal saves, retries, replaces setup or confirms a destructive action.

## Editing channel details

Channel Settings shows the signed name, description and explicit visibility for
ordinary channels; missing visibility stays **Not available**, not implicitly
Public. The centered title opens the same editor, revealing a pencil with a short
left-to-right fade on hover or keyboard focus (always visible on touch, no animation
for reduced motion). The pencil follows the final text line;
balanced side padding keeps the text centered and lets long titles wrap without clipping it.
Description and Visibility have small pencils immediately after their labels,
revealed with a short left-to-right fade on whole-row hover or keyboard focus
(always visible on touch, no animation for reduced motion) without shifting layout;
each whole row opens the shared Dialog with one Name/Description/Duration/Private draft.
Opening Description focuses its textarea; the title and Visibility still focus Name.
Only authorized editors get the interactive rows; other viewers retain plain metadata.
Members has a right chevron and opens the existing member list. Channel ID has a
small inline copy icon with the same hover/focus/touch behavior; selecting its row
copies the exact ID. Only a successful copy opens a confirmation tooltip, without
growing the row; hovering or focusing does not open a hint or replay old feedback.
Clipboard failure shows an inline error and leaves the row available to retry. The redundant standalone
Edit details button, header-menu Edit details entry and informational Channel type
row are omitted.
Duration uses Create's Ongoing/Temporary cards, and Private uses the same
switch in the action row. These controls stage changes; neither publishes immediately.
**Save changes** submits the draft together and is enabled only for valid, changed values.
**Cancel** explicitly discards edits and closes without confirmation. Close, Escape
and backdrop clicks close untouched forms immediately; changed drafts first show
**Discard changes?** with **Keep editing** initially focused. Keep editing, Escape,
Close or a backdrop click in that confirmation returns to the intact form.
**Discard changes** drops the draft and returns focus to its originating control without
closing Settings, as does the form’s explicit **Cancel**. Pending saves and status
checks block dialog dismissal and show a
loading spinner on the disabled edit control without changing its label.
Saving and permission loading do not add text status rows or reserve empty space;
viewers without editing authority see neither edit controls nor an explanatory hint.
Actionable errors and uncertain-save warnings remain visible.
After an uncertain outcome, the edit controls re-enable so the save may be closed
and reopened for check-only recovery, never a blind resend. The panel retains its
own Close/Escape focus return, conversation and collapsed Diagnostics.
Names accept 1–120 code points and descriptions up to 1,000. Typing and paste
are capped at those limits without splitting Unicode code points; a middle edit
keeps the existing suffix and accepts only the inserted text that fits. Existing
over-limit relay values are preserved: edits may reduce or replace text without
growing the excess, and Save stays invalid until both fields meet the limits. Character
counts appear at the trailing end of the label row only within the last 10% of
each limit (`108/120` or `900/1,000`). Visible counters are numeric; the connected
accessible description retains the full character-count meaning.
Names follow the relay’s Unicode whitespace and leading-hash canonicalization
before validation, signing and confirmation. Empty descriptions clear the value. The internal `Buzz session (` marker is
rejected with a specific explanation only when present, not as part of length
feedback. Command validation still rejects oversized input independently of the UI.

### Create/Edit form parity

The dialogs share `ChannelTextField` for Name and Description: the same code-point
input caps, middle-edit preservation, label-row counters and connected errors.
Both forms canonicalize names with `canonicalDetailsName` before handing off the
draft. `ChannelDurationField` shares the Ongoing/Temporary cards and draft-only
subtle minus/plus controls beside the selected Temporary card. Unselected copy is
“Cleans up without activity.”; selected copy is “Cleans up **after [duration]** without
activity.” `motion/react` expands/collapses the middle phrase and the adjustment
space together over 200ms, without scaling text. The middle phrase uses Medium
weight and standard text color against muted surrounding copy. Reduced motion and
keyboard navigation switch immediately; hidden controls are inert and excluded
from accessibility, with one complete accessible description per state.
Steps are **1 day ↔ 7 days ↔ 2 weeks**, starting at seven days, with
unavailable directions disabled. Switching to Ongoing and back retains the chosen
time within the draft. Private reuses the shared switch, left-aligned in each
footer with matching enabled/disabled label treatment. Both forms use a compact
12px header-to-body gap and 16px field spacing. Write ownership stays with each
workflow.

Both forms show Description immediately; Create opens with Name focused and keeps
Description optional. The workflows intentionally remain distinct: Create owns
template setup plus frozen creation retry; Edit shows the
saved description, retains custom durations, and owns authority/conflict checks,
Save/Cancel and check-only uncertainty recovery. Create still trims optional
Description on submission; Edit preserves its exact text and can explicitly clear it.

Both dialogs opt into backdrop dismissal and guard Close, Escape and backdrop
dismissal with an in-dialog discard confirmation when the draft differs. Comparison covers raw
text, staged privacy and effective duration; Create also compares accepted template
setup, treating the opening group's automatic default as initial data. Reverting
all fields removes the warning. Pending operations still block dismissal, and
frozen/uncertain requests remain owned by recovery rather than being offered for
discard. Returning from a discard confirmation focuses Name and retains the draft.

Create has no destination picker. Opening from a saved group's sidebar + fixes
that destination for the draft and titles the modal **Create a channel in [icon]
[group name]**, reusing the sidebar's decorative Unicode/custom-emoji renderer.
Opening from the general Channels section stays ungrouped and uses **Create a
channel**. Group placement remains managed through the left-nav Move action.
Group template defaults and frozen retry input remain unchanged; unavailable groups
block a new create rather than silently falling back to a different destination.

Create's session and existing creation helper also use `canonicalDetailsName`,
including template preflight and ordinary recovery matching. New frozen intent and
signed names retain the relay's Unicode rules: trim Unicode White_Space and leading
hashes, preserve U+FEFF, then enforce the code-point limit. This is cleanup, not a
new invisible-character policy. Recovery derives its comparison name without
rewriting a saved command: retry still publishes the exact original signed event.

Editing requires fresh relay-authored metadata (`39000`), administrators (`39001`)
and membership (`39002`) for the exact channel, plus current session participation.
Only direct channel owners/admins may edit ordinary stream/forum channels. Cached,
read-only, archived, DM and work-session views do not offer this editor. A local
key, delegated agent role or community-admin status does not imply channel authority.
Public ↔ private is supported as a draft choice, never an immediate mutation.
In both Create and Edit, a Private toggle normally replaces the form with a confirmation
step in the same modal. The whole surface crossfades using `motion/react`: the form scales from
1 to 1.05 and blurs while confirmation sharpens from 0.95 to 1. Returning reverses
the transition; reduced motion and keyboard navigation swap immediately. Outgoing
controls are inert, with one backdrop and focus trap throughout. This happens
before changing the switch, including a reversal back to the saved
value. There is one backdrop and focus trap, not a second overlaid modal. Public → private says
“Only channel members will have access.” Private → public explicitly warns that everyone in
this community can view the channel's full history. Continue
only stages the choice; Create channel or Save changes still performs the write. Cancel/Escape or
the confirmation's Close control leaves the switch unchanged and returns to the
intact form with focus on the switch. All other draft fields—including Create's
selected destination and accepted template setup—survive either path. The consequence
is shown once in the confirmation body, connected as the dialog's accessible description.
**Don’t show me this again** is saved only on **Continue** and skips both public and
private warnings. It is a device-local preference shared by Create and Edit for the
same community/viewer scope, using the existing view-state storage. Existing opt-outs
for either direction also skip both warnings. Cancel, Escape,
Close and backdrop dismissal do not remember it. If storage is unavailable or invalid,
the warning remains enabled. Skipping the warning still only stages the choice:
Create/Save, authorization and discard protection are unchanged. Busy/frozen creation
cannot open confirmation, and restoring a frozen attempt dismisses an open confirmation.
In Edit, visibility is sent only when changed (`private` or `open`);
text-only edits omit it so they do not reopen the channel in the remaining write race.
The relay remains the final authority.

Temporary defaults to seven days without activity, matching Create. Existing custom
positive durations are shown accurately and retained until explicitly adjusted;
minus/plus selects the nearest offered shorter/longer step without silently rounding
on open. Frozen Create recovery displays the exact original duration and disables
adjustment. Editing text or toggling back to the original lifetime does not reset
the relay cleanup deadline. A duration change
emits the existing `ttl` command (positive seconds for Temporary, empty to clear for
Ongoing). Absent signed metadata TTL means Ongoing; malformed/duplicate TTL fails
closed. Confirmation checks the exact duration alongside the other draft fields.

`features/relay/channel-details.ts` owns the command and uncertain intent. It
rechecks authority and the edit's metadata version immediately before signing and
publication, verifies the signed command, and requires matching fresh metadata
readback—not merely a publication receipt. Confirmed relay metadata feeds existing
shared discovery so the panel, conversation header and sidebar use the same values.
The version check detects observed conflicts but is not a relay-side compare-and-swap:
concurrent writers can still race after the last read.

A definitive rejection keeps the editable draft. **Reload details** rechecks the
base without discarding text edits. Untouched visibility and duration follow the
reloaded base; explicit choices stay in the draft. A duration-only comparison baseline
survives failed reloads, so an untouched duration follows the next successful read
while an explicit change to Ongoing remains staged. This baseline never grants
editing authority: a failed read still clears the current base and disables Save.
If a failed reload has lost the prior base, privacy adopts the fresh value
conservatively: a stale public text draft must not become reopening intent. Choose
visibility again after that recovery. Inspect the retained edits before
saving again. A lost publication response or failed/mismatched readback locks the submitted draft and
offers **Check save status**, which only reads and never republishes. Uncertain
intent survives panel close/reopen and cache clear within the same session; no
background polling, automatic replay or durable recovery record is added. If
status cannot be confirmed, inspect the channel rather than assume failure.
Session replacement drops the in-memory attempt; it does not retract a sent write.
Channel/session changes fence old drafts and late completions. Operations use a
20-second deadline so a stalled read/write becomes explicit recovery, not an
indefinite saving state.

### FOUNDATION integration rationale

This is migration of an existing Buzz user feature, not a session redesign.
The current session already owns community/viewer identity, verified reads,
participation, shared metadata and cancellation. Composing the dedicated details
owner there keeps those authorities together instead of constructing a second
connection or making the panel a command owner. The approved `session.ts` change
is limited to constructor/import, capability exposure, cancellation, cache clear
and disposal (13 added lines). Policy and write logic remain in the feature owner.

The development broker exposes separate `channel-details-sign` and
`channel-details-publish` routes, accepting only bounded name/about and optional
open/private visibility plus an optional bounded TTL change/clear. Existing archive-state-only
lifecycle, invitation and message-outbox admission are unchanged. Publishing reuses the same community's authenticated live
socket; no HTTP fallback or new connection is added. Restart an already-running
dev broker to load these routes. `just web` supports this complete browser flow;
`just desktop` is not required. Hosts without the dedicated capability stay
read-only; packaged/native uses dedicated purpose-bound commands for these edits.

Behavior matrices live in `channel-details.test.ts`,
`ChannelDetailsEditor.test.tsx`, `store.test.ts` and `relay-broker-api.test.mjs`.
Real-relay Save/privacy changes require deliberate testing on a disposable channel;
unit/broker tests and a browser Cancel walkthrough do not establish live-write or
native acceptance.

## Member administration

**Channel members** has a scoped conversation history visit (`panel: "members"`)
through the host navigation owner. Opening creates a visit; browser Back dismisses
and Forward restores the list. Reload restores the same channel and Members,
including the underlying message/thread address when present. Close, Escape and
outside dismissal open the underlying conversation as a new visit, so Back can
recover the list. Profile/DM handoffs dismiss Members without replacing the new
destination, and history traversal never repeats a DM open or membership mutation.
Search, role filters, menus and confirmations are transient, not address data.
Scoped history still requires the original viewer, joined community and current
channel access. Tabs remain session-owned: navigation preserves them, but this
change does not add disk persistence for tab sets. Draft persistence is unchanged.
A covering Members modal owns focus while underlying exact-message readers verify
and restore their targets without focusing through the modal. Session conversations
have no Members surface; a restored/handwritten Members route to a session resolves
to its underlying conversation/message without that panel.

The existing **Channel members** dialog keeps ordinary invitations and adds
verified roles plus per-member administration. Current members appear in separate
**Owners**, **Admins**, **Members** and **Agents** groups with sticky headings and counts.
Verified authority alone places someone in Owners or Admins, including agents.
Everyone else is grouped by the same agent identity evidence used for avatar shapes:
agent identities in Agents, other identities in Members, without asserting a default
protocol role or treating the Bot role as agent identity. Each group is alphabetical
by displayed name (public key breaks ties). Initial opening shows one accessible
loading spinner inside the existing scrollport until the roster, role and member-name
attempts settle; no provisional identity rows or groups appear. Missing names or
failed reads settle to public-key fallback and the existing refresh recovery rather
than blocking forever. A warm reopen with a settled role result (including an honest failure fallback)
and all member profiles already available renders immediately. Later refreshes retain usable content and
preserve the last verified groups on failure. Visible member names request foreground
priority; avatars, presence and manager enrichment never gate the initial list.
Search filters
each group, omits empty elevated and agent groups, and preserves full group counts.
Non-member search ranking is unchanged. Relay matches followed by matching known
agents share a 30-row initial invitation page after member/archive exclusion and
identity deduplication. **Show more results** reveals 30 more already-loaded matches
before requesting another relay page. Query changes and explicit refresh reset the
visible page; no matches are silently discarded. Only displayed invitation agents
join ownership observation, so the first character cannot mount/enrich the entire
known-agent inventory. Unchanged identity rows retain their rendered
profile/avatar/menu trees across query and loading updates; changed names, permissions,
manager evidence, presence and invitation state still update through their existing owners.
Current-member avatars and rows open the existing Profiles panel when its contribution
is enabled; the Members dialog closes and closing the profile returns focus to the
Channel members button. Names and smaller, muted inline **managed by** hints sit
centered at rest with no pills. Hover reveals a longer abbreviated npub underneath
using the existing 140ms height/opacity transition, just like invitation rows;
keyboard focus and reduced motion reveal it immediately. The abbreviation shows
`npub1` plus six leading payload characters and six trailing characters. It stays
abbreviated: no dwell timer, inline expansion, copy icon, or identity card. Shared
identity previews on other surfaces remain unchanged. Available presence status
stays on the profile control. The manager link opens
Profiles with the same focus handoff; row-profile and owner-profile controls are
siblings, never nested. Every current member has a separate
ellipsis button (not nested inside profile navigation), with **View profile** first,
then **View owner profile** for agents with verified ownership and available profile
navigation, or **Send message** for other humans on a DM-capable connection,
followed by permitted administration actions. Copying the full npub belongs to
Profiles, not the member or invitation menu.
Send message reuses the session's verified direct-message opener and the current
conversation navigation owner; it sends no message automatically. One dialog-owned
waiter blocks duplicate opens, shows pending/error status and allows explicit retry.
Closing Members cancels that waiter and suppresses late navigation; a successful
handoff leaves destination focus alone. Owner/self protection, missing
writer support and pending/uncertain writes suppress mutations, not the profile
menu. If Profiles is unavailable, View profile is disabled. Pointer hover, keyboard
focus and an open menu reveal the reserved action slot without moving row content;
non-hover/touch input keeps the trigger visible. Right-click, Context Menu and
Shift+F10 open the same action list through the shared context menu. The ellipsis
uses a separate shared Menu root/trigger so each input retains its platform
interaction owner; only one menu is open per row. The trigger owns toggling and
outside-press dismissal. Scrolling the member list dismisses either menu without
resetting the scroll position; scrolling inside a menu does not dismiss it.
Focus in a portaled menu is not row focus: once hover and physical row focus leave,
the npub and its reserved space collapse together, recentering the name.
Escape returns focus to the originating row
control; profile navigation hands focus to the panel and returns to the external
Channel members button when closed. Invitation rows reuse the same avatar, name,
managed-by hint and public-key hover/focus presentation, without a channel-role
badge. Their avatars and identity rows open Profiles just like current members;
only the separate, extra-small prominent **Add / Adding…** button invites someone.
Invitation results expose the same identity menu through right-click, long-press,
Context Menu or Shift+F10 only, with no ellipsis button. Add stays separate and
there are no role/removal actions. People and agent avatars both use the
shared 32px default size. Both row types
share a 48px minimum height, growing with their content rather than
clipping it; profile targets fill the row height, with identity and actions centered.
Profile navigation stays available during an invitation; missing Profiles support
leaves the identity static without disabling the separate Add button.
The dialog retains its shared surface. A quiet `border-standard` outline frames
one scrolling viewport, with Owners, Admins, Members, Agents and Not in this channel
separated inside it without extra boxes or fills. Every group heading sticks to the
top of this viewport while scrolling within its own section, with an opaque matching
surface so rows do not show through. There is no outer top padding to scroll away:
when a group starts the list, its heading is pinned from the first scroll pixel;
the heading itself owns the text's top inset. A compact ghost refresh button sits in the
fixed dialog header immediately left of Close, matching its button and 16px icon size;
its tooltip and accessible name are **Refresh member data**. It refreshes this
dialog's member-related data, not the whole application. It is the single retry
control for roster, verified roles, missing member names, shared agent choices,
archive visibility, agent ownership/manager names and the active directory search. Errors stay near their data,
without separate fetch-retry buttons. The current search text is retained; directory
refresh starts at page one rather than mixing old pages with fresh results. Empty
queries and view-only membership do not trigger directory searches. Cached names
reuse the shared profile directory; failed/missing names are retried. The separate
roster read remains usable when role verification fails. The refresh icon spins
linearly until all these reads settle (except with reduced motion), but stays still
while the initial list spinner is showing so only one spinner is active. It exposes
`aria-busy` and keeps its focus target. Duplicate clicks
and refresh during membership writes are blocked. Optional-name loading/failure does
not disable Add once the roster is verified. Failed invitations keep their explicit
Retry; data refresh never resubmits an invitation, role change or removal.
Supporting buttons use outline emphasis; **Show more results** uses the small size
and is horizontally centered beneath the search results.
Role confirmations use prominent, and removal remains destructive.
The search has a role dropdown on its right when at least two roster groups are
present. It defaults to All and offers only populated Owners, Admins, Members and
Agents groups, with whole-roster counts (including the All total), using the shared
compact Select with its popup aligned to the trigger’s right edge. The popup has
an 11.25rem minimum and reserves checkmark space to avoid width jumps on selection.
Counts form a partition: each identity appears once, with Owners/Admins taking precedence
over agent identity. Any search input, including whitespace, resets to All and animates
the picker out while the search expands. Clearing the input restores All; search
never combines with a role filter, and ordinary invitations stay available.
Reduced motion makes the transition immediate. Existing owner/admin
precedence over agent identity is unchanged. Selecting a role returns the list to
the top; a vanished group or a single-group roster returns to All. Closing and
reopening Members resets the filter. This is display state, not role authority.
The member action trigger retains its compact width and fills the row height, with
right-hand corners matching the row. Inverse left corners carry its hover/pressed
fill around the profile's rounded edge; its hover matches the profile row highlight
rather than the brighter floating-button fill. Profile and action targets remain
separate.
The title, channel name and search stay fixed. Members uses the shared Dialog
with `dismissOnOutsideClick` enabled. Adjacent role groups use an 8px gap in
addition to the heading’s own top inset; invitation/recovery spacing is unchanged.
The search composition reduces the shared header-to-body gap by `--space-2`
(16px normally, 8px at the compact breakpoint) without affecting other dialogs.
The member-list area flexes into the remaining dialog height and owns the only
scrollbar, including search results and recovery messages. The role groups and
Not in this channel flow naturally one after the other; only the bordered viewport fills spare
height, never a group inside it. The shared Dialog's opt-in flex body
keeps the outer body non-scrolling; other dialogs are unchanged.
Agent runtime/access management is not added to the member menu.

Manager attribution uses the existing NIP-OA verifier on each agent's winning
signed kind-0 head, combining one dialog-owned live observation with retained
profile-directory evidence. Filtering retains the current roster in that observation;
matching non-member agents join only while displayed on the invitation page.
Verification is event-bound: newer invalid or missing
auth removes the claim; older reads cannot restore it. The dialog reuses verification
for the same identity and signed head while filtering; a changed head is verified
again, and explicit refresh or session changes reset that reuse. Identity hints, local agent
inventory and channel roles never establish ownership. Missing/invalid evidence
shows no manager hint. Read/admission/name failures join the shared refresh; an
unavailable owner name falls back to their public key. Verified public evidence
can remain during a failed background read. No private/runtime authority is granted.

Agent avatar shapes describe identity type, not the channel's protocol role.
Human and agent avatars reuse the shared online/away/offline presence badge from
message bylines, including its lower-right cutout and accessible status description.
Only mounted rows demand presence from the existing bounded session directory;
filtering or closing releases their demand. Unavailable, stale or failed evidence
leaves the avatar unbadged, never falsely Offline. No presence reader or timer is
added. This is community session status, not agent process state.

Role and archive pills are omitted. Verified roles and archive state remain in
profile-link accessible names and the existing profile surface. A verified Bot
role for an agent identity is still called Member in the accessible name; underlying
Bot roles, invitation defaults and administration permissions are unchanged.
Before the first role read finishes no role is asserted. Missing or unfamiliar
roles after a completed read remain unverified/unknown rather than defaulting to
Member. An open dialog reloads idle role data when session access invalidation
clears it, but only for a current, non-cached channel. Failed reads require explicit
refresh; recovery never replays writes.

`features/channel-members/administration.ts` owns this session-scoped capability;
`session.ts` only composes its reader, narrow writer, access guard, discovery
updates and teardown. The dialog does not own a connection, privileged outbox or
retry loop. Each fresh read verifies exact relay-authored metadata (`39000`),
administrators (`39001`) and the complete roster (`39002`). Administrator and
roster roles must agree; malformed or inconsistent snapshots fail closed.

Current direct owners/admins of an unarchived stream/forum channel can manage
another non-owner member:

| Target role | Change role | Remove from this channel |
| --- | --- | --- |
| Admin / Member / Guest | Admin / Member, excluding the current role | Yes |
| Bot | Admin / Member, after explicit confirmation | Yes |
| Owner, self, unknown or inconsistent | No | No |

Agent identity is independent of channel role. Explicitly promoting a Bot to Admin grants authority to that agent’s own public key and preserves its verified agent identity; the human owner’s roles do not confer authority.

The menu deliberately omits **Make guest** while Guest's permission contract is
unsettled: the inspected relay message path does not enforce the role's documented
read-only meaning, while Git push policy does distinguish Guest from Member.
Existing Guest roles remain available to the permission/confirmation flow and can be deliberately changed to Member or
Admin, or removed; they are never automatically converted. This is a menu-only
restriction, not a change to relay semantics or the broker's supported commands.

DMs and session channels have no administration actions. No ownership transfer,
community-admin override, delegated agent-owner authority or new invitation
restriction is introduced. Personal Leave remains a separate lifecycle operation;
removing a member neither deletes their identity nor stops their agents.

Role change and removal use separate deliberate confirmations, initially focused
on Cancel. The service checks fresh actor/target state before signing and again
before publication, rejects altered signer payloads, and confirms the requested
role or roster absence with a fresh read. Relay acceptance alone is not success.
Pending intent survives dialog close/reopen and suppresses duplicate actions.
Definitive failure preserves the last confirmed roles and offers explicit refresh;
an uncertain outcome offers readback only, never automatic resubmission. If the
requested result still cannot be observed, administration remains blocked in that
session. Cache clear and access loss discard role authority but retain sent,
unconfirmed intent for fresh readback only. They fence late completions, as does
disposal, but cannot retract a request already sent. Unsent work is canceled;
recovery is in-memory, not durable across session disposal or restart.

The development broker advertises a separate `memberAdministration` capability
and admits only exact `9000` Admin/Member/Guest changes or `9001` other-member
removals through its purpose-bound routes. Generic invitation signing is unchanged;
the relay still enforces the authoritative ACL. Hosts without this writer can
read verified roles but expose no management controls. Native/direct-signer parity
is deferred rather than silently falling back to an unrestricted writer.

**Accepted protocol limitation:** role commands are existing relay upserts, not
conditional updates. A departure after final preflight can be undone by the role
command re-adding the target; a concurrent role edit can be overwritten. Client
checks/readback reduce uncertainty but do not provide atomic conflict rejection.
Preventing these races requires separately scoped relay support.

Regression coverage lives in `administration.test.ts`,
`MemberAdministration.test.tsx`, and `dev/relay-broker-api.test.mjs`; existing
`ChannelMembersDialog.test.tsx` invitation coverage remains. Synthetic confirmed
writes/recovery and a real-app read/confirmation/cancel exercise do not establish
native or deployed destructive-write acceptance. Those checks and human tryout
remain separate delivery gates.

## Performance and correctness carried from Astra

The port retains the prepared-store implementation and its behavior tests:

- 64 prepared heads / 4 MiB serialized memory budget, separate from history.
- Three unpinned history windows; each caps at 2,400 rows or 8 MiB. Mounted readers
  are not evicted by speculative preparation. A budget cap is distinct from EOF.
- Three read slots, at most one background request, with foreground promotion and
  deduplication. Hover/focus prepares at most one speculative head at a time;
  superseded hints do not form a backlog. That shared head keeps foreground
  priority so selection cannot inherit a host-side background wait. Discovery
  restores reverified disk heads against saved, display-only membership before
  network authorization, without waiting for optional channel names, and does not
  fetch heads across the roster.
  Verified heads save before optional profile enrichment; changed profiles can
  enrich the disk record afterward. Network reads belong to intent, selection and
  retained-window live catch-up. Optional profile enrichment stays background.
  Selecting an already-queued catch-up promotes that existing read without adding
  a request or resetting its deadline.
- 1,024 profile entries / 2 MiB signed-record budget, narrow row profile selectors,
  and request-warmed avatars (fetched and decoded, nothing retained; disabled
  under the Save-Data preference). Signature verification yields in batches.
- Account/relay-scoped IndexedDB: 64 records / 8 MiB global disk budget, 24-hour
  expiry. Signed cached events are reverified before display. The same database
  stores account/relay-scoped startup discovery and sidebar organization (a separate
  8 MiB global budget); old version-1 head records survive the version-2 upgrade.
- A 60-second head freshness lease; warm revisits reuse heads without new reads.
  Partial discovery never treats an omitted channel as a membership revocation.
  Explicit denial or signed membership removal invalidates private cached views.
- Viewer membership discovery follows 500-event roster pages using the relay's
  `(until, before_id)` cursor (timestamp descending, event ID ascending), then
  fetches names in batches of at most 500 channel IDs. Verified grants become
  available page by page; successful paged exhaustion confirms scan-start
  omissions with fresh exact roster reads before reconciling against the roster
  versions present when the scan began. Failure, cancellation, nonadvancing
  cursors and the separate 1,024-entry roster/metadata retention caps leave
  coverage partial. Each scan is bounded to three roster-page reads plus at most
  eight 128-channel confirmation reads; metadata failure preserves successful
  membership evidence and earlier name batches.
- Conventional top-down virtua timeline, prepend anchoring, near-bottom following,
  and eight cached geometries keyed by session, channel, content, profiles, and width.
  These inert measurements can survive folded-window eviction when the retained
  head still matches; they do not increase history retention or live catch-up work.

Connection generations and store epochs reject late results after disconnect,
replacement, disposal, or access revocation. The data service outlives plugin
components; it is disposed with the app runtime.

## Local-first launch

The selected community and conversation reuse the existing device view-state.
The relay service restores a read-only session from the account/relay-scoped cache
concurrently with the real connection handshake. Saved groups, stars and channel
names are display data, not a confirmed preference mutation base. No cache means
the ordinary cold connection flow; unavailable/corrupt storage never grants access.

A cached roster can display previously downloaded, reverified history for up to
24 hours. It cannot authorize head/history reads, unread evidence, typing or
publishing. Unconfirmed membership is not resaved with a fresh lease. An identical
or newer fresh signed roster promotes it; a complete roster omission or explicit
denial purges both the view and the next-launch record. Partial roster reads do
not prove absence. The live transport's relay identity remains authoritative.

A failed or timed-out handshake retains usable saved content with Retry; browser
online/visibility signals retry the connection. The successor restores its local
read models and materializes retained windows before replacing the cached owner.
The workspace generation stays stable for that promotion, so selection, the
channel timeline DOM and its reading state survive. Ordinary reconnect, account
or community changes still reset presentation lifetimes. Drafts remain scope-keyed.
Cache clearing/disconnect/disposal fence pending restoration and connection results.

`index.html` shows a centered Buzz mark on the synchronously selected light/dark
background before React loads. This is a document launch surface, not a native
pre-webview splash; the native window's initial paint remains separate.
`tests/browser/startup.spec.mjs` exercises IndexedDB reload, held/failed handshake,
in-place recovery, denial-by-omission and both document themes in Chromium/WebKit.
`features/relay/startup.test.ts` covers signed-cache admission and authority boundaries.

## DM label recovery invariant

Access-loss purges remain authoritative: never keep old profiles just to preserve
sidebar names. After roster membership changes, visible DMs must reacquire their
missing names through the shared profile directory at background priority, without
blocking conversation opening. Recovery must cover both loaded profiles being
purged and an initial profile read being cancelled before any name arrives.

`ChannelsPage` passes the **full** roster to `useChannelLabels`; the hook filters
visible conversations for display/profile demand, but derives its recovery trigger
from all channel IDs. Deleting an already-hidden or archived channel can still
invalidate shared profiles. Missing-profile and membership keys remain stable on
ordinary message/preview updates: missing/failed responses must not start a
render-driven request loop. Key fragments remain the fallback for unavailable names.

`useChannelLabels.test.tsx` binds the mounted hook to real session roster omission,
including hidden/archived deletion, stale in-flight replies and unsuccessful name
reads. `tests/browser/dm-labels.spec.mjs` guards the production page wiring and DOM
labels through the real Refresh channels control and broker. These are foundational
recovery constraints, not a new shared-session API or a guarantee of general
profile retry after every cache clear/network failure. See [browser coverage and
limits](browser-testing.md#dm-label-recovery).

## Membership activity

Channel history and the existing live route include relay-signed kind-40099
`member_joined`, `member_left` and `member_removed` summaries. Only recognized,
channel-scoped payloads from the connected relay become activity rows; malformed,
unknown and other authors' summaries are not rendered as JSON. These events do not
grant/revoke access: the existing signed roster remains authoritative.

The timeline groups adjacent arrivals/departures into compact avatar-and-text rows.
Messages, local-day changes and gaps over an hour break groups; removals by different
actors stay separate. Same-adder additions use “added by you” for the viewer;
mixed arrivals do not invent an adder. Grouping is presentation-only: signed event
IDs, pagination cursors and retention budgets remain per event. Profiles reuse the
shared background directory/cache, and reading anchors can resolve a member of a
group. Activity has no message actions, thread, unread evidence or chat preview.

An already-running development broker needs a coordinated restart to load the
expanded live filter; frontend hot reload alone changes only the history/rendering
path. No native or relay changes are required.

## Viewing threads

Click a message's reply count to open its root and replies in the right column.
Up to three overlapping participant avatars appear beside the count, with `+N`
for additional summary participants; missing/unavailable pictures use initials.
They reuse the channel's existing shared profile/media path, not extra per-row reads.
On a supporting relay, the panel opens at the newest 10 replies and loads older
pages of 50 when you scroll upward; there is no Load more replies button. It validates
signed NIP-CW thread bounds on every page. A prior scroll gesture wins over initial
bottom placement. New replies arrive through the existing session and the panel
follows near the bottom, preserving reading position above it. Sending a reply is
explicit navigation intent and reveals the new local row.

**Bounded history:** strict mode retains at most ten pages (10 initial replies
plus nine pages of 50); legacy mode retains at most ten pages of 50. A limit notice is
not a completeness claim. An older relay returning verified replies without thread
bounds on the initial probe triggers a clean legacy restart: automatic oldest-first
traversal, whose bottom may not be the newest reply in a long thread. An empty
unsigned probe is ambiguous with access denial and stays retryable/unavailable.
Malformed bounds, failed requests and missing bounds after strict support never
downgrade. Media review still eagerly loads its bounded comment range.
The thread and a linked object panel share that slot; a companion can remain below.
Close or Escape returns focus to the reply button when it is still mounted. Changing
channel/community or disabling Channels disposes the owned thread view.

The footer reuses `MessageComposer` and defaults to a direct reply to the resolved
root through `session.messages.reply`. Reply on a child selects that message as the
parent without changing the root-keyed draft; canceling the target returns to the
root. Channel and thread drafts are separate and survive reconnection; failed
replies remain inline with the shared retry action and retain their signed ancestry.
Read-only connections keep the existing composer capability notice; missing/revoked
roots do not expose a composer. Exact navigation can retain and focus a selected
reply beyond the traversal range; it does not extend that range or promise complete history.

Ordinary replies remain flat beneath the root. Replies to those replies form nested
lists, with ascending timestamp/event-ID order among siblings. Nested branches start
closed and expand one level at a time; once opened, they stay open for the lifetime
of the thread view, including through child disappearance and rearrival. Expanding
moves focus to the first revealed reply; deleting a focused reply returns focus to
its available parent or thread history. Labeled expansion controls remain available
when visual indentation is capped in narrow panels. Exact links reveal available
ancestors; a reply whose parent is outside loaded history remains visible with a
notice. Sessions remain inline.
Retry appears only after a failed read; there is no routine Refresh control. Names
are optional shared background enrichment. The panel describes **replies loaded**,
not visible rows or complete history.
The relay can filter rows after its limit, and summaries/EOSE are not proof of
exhaustion. See [the thread owner and bounds](relay-queries.md#thread-views).

## Validation and limits

`just scan` runs frontend checks/build, runtime/CLI tests, relay behavior tests,
panel lifecycle tests, GitHub parsing/API tests, headless Chromium/WebKit scroll
journeys, and native checks. See [browser setup, structural limits and diagnostic
measurements](browser-testing.md). Reading intent includes a message anchor for
cold/oversized geometry; legacy positions or anchors outside retained history fall
back to an offset without a same-message guarantee.

Channels supports plain-text Markdown authoring with a shared durable outbox and bounded history.
Channel and thread messages render CommonMark plus GFM headings, emphasis, lists, quotes,
tables, task lists, strikethrough and code, while preserving chat-style single line breaks.
Only credential-free HTTPS links are active; raw HTML is ignored and inline remote images
are not loaded. Existing image Markdown is projected as an attachment instead. Custom emoji remain
event-local and are not substituted inside links or code.
Authenticated live traffic reconciles through the same session. Channel creation is not
implemented. In the composer, typing the third character of a line holding only ```` ``` ```` or
`~~~` turns that line into a code block at once, and one undo restores the typed characters.
Shift+Enter on an empty last line leaves the block. Only a fence that opens a block converts: a
fence typed inside an existing code block stays literal, and so does pasted or restored fenced
text, including its closing fence line, so Enter after a pasted or edited fenced block sends or
saves as usual and the text still renders as code once sent.
Typing the space after a list or quote marker that starts a line (`- `, `* ` or `+ `, a number
with a dot or parenthesis such as `1. ` or `3) `, or `> `) turns that line into a bullet, a
numbered item starting at that number, or a quoted paragraph at once, the same block the
formatting toolbar creates, and one undo restores the typed marker and its space. Inside a
quote the markers nest: `- ` opens a list and `> ` a second quote. Inside a list item only a
marker of the item's own list kind, typed as the only text of an item after the first,
converts, nesting that item as Tab does. A marker typed after prose on the same line, inside
a code block or inside pasted fenced text stays literal and renders as prose or code once
sent. A marker on a line holding a mention, emoji or link, a quote marker or a marker of the
other list kind typed inside a list item, and any marker typed in a list's first item or
beside an item's prose also stay literal text in the composer but still render once sent: the
timeline shows the list or quote, nested inside the item, where the composer shows the marker.
Two lists of one kind typed one after the other, or separated only by empty lines, send with
alternating markers (`-` then `*`, `1.` then `1)`) so they stay separate lists once sent.
Typing an inline span (`**bold**` or `__bold__`, `_italic_` or `*italic*`, `~~strike~~`,
`` `code` ``) converts it to formatting as the closing delimiter is typed, including on a
heading line such as `# Title **bold**`, and one undo restores the typed characters. Heading
lines themselves stay text in the composer and render as headings once sent. A single `~`
never strikes, and pasted or restored delimiters stay literal text that still renders once
sent. Reply counts open a bounded thread view; attachments are
links. Routine freshness labels are not shown; Channel Settings → Diagnostics
exposes refresh, outbox inspection and timings. Packaged builds do not
include the development relay broker. GitHub fetches public data only; signed-in
GitHub actions remain on GitHub. A saved-groups/stars failure keeps its specific
reason under **Channel Settings → Diagnostics → Saved groups and stars**.
`Preference query` includes reader queueing, transport and verification; use relay
timings to separate those. `Preference decode` identifies the local decoder stage.
The diagnostic does not trigger another request or change retry policy.

Sending appears immediately in the timeline and shared channel-preview data;
the current sidebar does not render preview text. Delivery
status and retries come from the [unified relay session](relay-queries.md), and a
stale read cannot erase the retained local operation.

Use `session.messages.send(channelId, text)` for channel messages or
`session.messages.reply(channelId, resolvedRootId, text)` for thread replies. Confirmed sends
leave the pending outbox automatically and remain in bounded retained data.
**Outbox → Relay timings** captures and exports stage timings, including in-flight
signing and publishing, without logging message content.


## Reusing conversation UI

Source plugins can import from `features/messages` without depending on bundled
Channels. Pass the current `RelaySession`, stable community/viewer `scope`, channel
identity and navigation callbacks. `ChannelTimeline` also receives the current
`ChannelWindow`; `ThreadPanel` owns allocation/disposal of its thread reader.

`ChannelTimeline`, `ThreadPanel` and `MessageComposer` reset their internal state on
session, scope or destination changes. Callers may retarget ordinary props without
supplying React keys; old thread evidence, scroll state or drafts cannot pair with
a new destination. Persistent draft keys remain `draft:<channelId>` and
`draft:<channelId>:thread:<resolvedRootId>` inside stable scope, not connection generation.
`MessageRow` receives folded data, profiles/media and optional reply/retry callbacks.

This is shared source composition, not a new registry or versioned external UI SDK.
See `tests/fixtures/messages.tsx` for a second consumer that deliberately supplies no
caller remount keys. Its browser regression runs real React StrictMode/session/outbox
with local ephemeral signing keys; it does not contact the deployed relay.

## Community emoji

The smile button in channel and thread composers opens Emoji Mart with standard
Unicode emoji, skin tones, and the selected community's custom category. Its data
and search load only when opened. Search by name/shortcode, then choose an emoji
to insert at the cursor; Enter selects a search result and Escape closes the picker
and returns focus. You can also type `:shortcode:`. The picker follows the host
Light/Dark choice, including while already open, without recreating its search or
dictionary. It does not independently follow the operating system.

The session owns the catalog and its live updates. Reopening reuses the ready
catalog, without hiding custom results behind a fresh read. Catalog failures expose
Retry while leaving Unicode available and retaining drafts. Only one picker owns
Emoji Mart's global dictionary at a time; scoped custom IDs and disposal prevent
old community entries leaking into search or Frequent. Historical messages and
existing reactions keep their signed emoji URLs after catalog changes.
Emoji-only messages stay at the large 42px size regardless of count; normal text
returns the message to its usual size. Long runs wrap instead of shrinking.
Selecting and copying custom emoji preserves their `:shortcode:` in plain text,
along with surrounding text and line breaks. Pasting into a community with that
emoji available resolves the shortcode through its existing composer catalog.
In the composer, Shift+Left/Right selects each rendered custom emoji as one unit,
preserving its full shortcode for copying, replacement and deletion. Reversing
direction shrinks the selection by one emoji. Visible shortcode text and emoji
that cannot be rendered retain ordinary text selection.
Custom emoji autocomplete adds no trailing space. The native caret uses the
regular composer text size while the emoji preview remains large.

Message and thread reaction rows have a Lucide smile-plus button after existing
reactions. Messages without reactions do not show it. The Emoji plugin supplies
the emoji-only picker
through its optional conversation tool `reactionComponent`; the shared message
row owns publication. The picker opens outside the scrolling list, closes on
selection or Escape, and returns focus to the plus button. Failed or unconfirmed
reaction delivery offers Retry reaction through the same outbox. Read-only
connections and archived channels do not expose the action.

The composer shows its GIF tab as soon as relay support is confirmed. Unsupported
results are retried when the picker reopens; the broker caches confirmed support
without retaining negative discovery results. Pickers
without tabs use a search radius equal to the container radius minus the 10px
inset; tabbed pickers keep the smaller 8px search radius.

Emoji uploads and management remain in the existing community workflow.

See [the shared catalog/send contract](relay-queries.md#community-emoji). The local
`/tests/fixtures/emoji.html` diagnostic uses ephemeral identities and no live relay.


## Unread badges and reading intent

The sidebar renders the session-owned [unread capability](unread.md): observed
counts, not exact relay totals. Selecting/preloading a channel is not reading.
Focused, fully visible, settled timeline/thread rows receive an individual marker
after dwell; no automatic channel-prefix advance hides unseen siblings. Conversation
options exposes local-only manual unread, explicit mark-through and sync recovery.
Older synchronized hints may expire under bounded retention. Synced manual-unread
and OS notifications are not enabled by this feature.


### Attachment layout and scrolling

Message rows show images as fixed square thumbnails with centered `cover` cropping:
small images scale up and wide or tall images crop to fill the tile without stretching.
Inline video previews and their posters also fill their bounded frames with `cover`.
Image and video thumbnails share smoothed corners and a 1px outer hairline, black at
10% in light mode and white at 10% in dark mode. The expanded viewer shows the full
media against a pure-black canvas; thumbnail cropping does not change the original.

For non-thumbnail attachment surfaces, the following reserved-layout contract applies.
Image attachments reserve their preview geometry before loading and across virtualized
row remounts. Valid `imeta dim` metadata supplies the aspect ratio, bounded to 360px wide
and 320px tall without enlarging the frame beyond the original dimensions.
Missing/invalid dimensions use a stable 360:320 frame that shrinks with the available
width. Images scale proportionally and crop centrally to fill their reserved frame,
including when their dimensions were initially unknown. Loading,
failure, or retry does not resize it or force an above-bottom reader to the newest row.
Valid message-carried `imeta blurhash` is decoded locally into a 32×32 canvas in
that same frame when it intersects the viewport. No thumbnail is fetched. The
preview is removed entirely (including behind transparency) only after the lazy
original decodes; failure retains the preview. Missing/invalid hashes or canvas
failures keep the existing background. Syntax validation bounds hashes to 166
base83 characters / 9×9 components; folding does no pixel work. Preview work is
per-mounted-image and uncached, visibility-gated even in nonvirtualized threads.
Without IntersectionObserver, only the ordinary placeholder/original is used.
This favors bounded visible work over instant offscreen previews on scrolling.
`tests/browser/image-scroll.spec.mjs` covers delayed/failed loads, actual remounts,
bottom following, reading anchors and narrow layout in Chromium and WebKit.

## Opening an exact message

Message-addressed conversations reuse the normal timeline and thread panel. A
verified, loaded top-level target is revealed in the timeline. An off-window
message opens as the root in the existing thread panel; a reply opens there with
its actual root and bounded surrounding replies. No around-message channel query
or separate detail screen is added. The presentation choice stays fixed for that
navigation attempt; exact reads do not insert isolated old rows into channel history.

Navigation completes only after the exact folded target is visible and focused.
Reclick/Back reveals again; live/profile updates do not steal focus. The shared
rows preserve Markdown, profile links, composers and background enrichment.
Opening never marks read directly: the ordinary focus/visibility/dwell hook applies.
Missing/deleted targets, access loss and failed reads expose failure/retry instead
of channel-head success. An accessible reply remains visible when its root is
unavailable, without a thread composer. See [the evidence contract](relay-queries.md#exact-message-navigation).
