# Shell design

The shell is owned by `src/app/shell`, independently of relay operations and page
content. `App.tsx` composes startup/recovery, built-in Settings, and the
existing contributed-page lifecycle. Messages is the landing page; legacy Home
targets resolve to Messages in the same visit. Channels is required, including
when older preferences saved it disabled. Navigation removes disabled optional plugins
from page choices; a retained destination whose provider is unavailable displays
an explicit failure with retry instead of silently selecting another page.
Browser controls, host shortcuts and toolbar arrows traverse the same visit history.
Settings sections are destinations. Personal-space page visits use explicit null
scope, distinct from a plugin's unspecified community scope. Focus-only skip links
do not add visits. Plugin recovery remains available in Settings → Plugins without
blocking Profile or Appearance.

See [design system and appearance](design-system.md) for Light/Dark settings,
semantic tokens, UI authoring rules and the local component reference.

## Where to change the design

- `src/shared/styles/globals.css` owns the semantic palette exposed to Tailwind:
  `ink`, `muted`, `line`, `soft`, `shell`, and `shadow-surface`. Default element
  styles live in Tailwind's base layer, so utilities can override them normally.
  Existing feature CSS variables remain available for incremental adoption.
- `src/app/shell/presentation.ts` owns page labels, icons and navigation ordering.
  Messages comes first, then Projects; other contributed pages follow by
  displayed label with a full contribution-key tie-breaker. Sidebar navigation and
  page search share this policy, independent of plugin activation/re-enable order.
  Channels is presented as Messages. Legacy tone props are retained for
  compatibility; all pages share the supplied gradient and repeating CSS dots.
  Add recognized page presentation here without changing plugin contracts.
- `AppShell.tsx` owns the 56px header, vertical page navigation, contributed panel
  launchers, Settings access, community rail, and page frames. Page navigation sits
  above the channel list outside Settings, using its saved sidebar width
  and resize behavior. Settings replaces that card with `SettingsSidebar.tsx`,
  preserving the same width (220px minimum) and returning to the previous view
  with Back. `App.tsx` composes `features/channel-navigation/ChannelSidebar`
  through an ordinary render prop; there is no portal or plugin contract expansion.
  Sidebar session state resets on scope/connection generation without remounting
  unrelated pages. Its own error boundary keeps page navigation and Settings usable.
  Page buttons use shared navigation rows and focus the main region on selection.
  A scrollable page list leaves room for channels at short heights.
  At widths up to 650px, every page collapses navigation behind the header’s
  Show navigation button to preserve readable content at 200% text size. The
  220px disclosure overlays content, supports Escape, and keeps sidebar state
  mounted. A navigation selection closes the phone drawer and hands focus to the
  main content; this includes conversation and Settings-section selections.
  Desktop layouts retain the visible sidebar and saved width.
  The header keeps history and account/search actions, with no second navigation row.
  Full-height pages get a 16px outer gutter (8px on narrow screens) and own their
  card surfaces. The shell adds no white backing behind them. Document pages
  scroll inside the remaining viewport.
- `SettingsSidebar.tsx` presents community and app sections in the shell's
  replacement sidebar. `Settings.tsx` renders the selected detail pane and retains
  drafts across section changes. The detail pane scrolls independently and keeps
  an accessible level-one Settings heading. Standalone Settings fixtures retain
  their embedded navigation, which becomes a compact row at narrow widths.
  Native buttons use normal Tab/Enter navigation and expose the current section.
  `ProfileSettings.tsx` edits the local default inline with Save and Cancel,
  sharing fields and validation with community setup. Cancel restores the saved
  profile; switching sections retains an unsaved draft while Settings is open.
  Leaving Settings discards that draft. Saving does not publish to communities.
  Plugin rows retain accessible native-button switches and show only names and
  controls. A Folder/Git import area above the list previews plugin subfolders and
  requires explicit install/update; its draft survives section switching, but
  leaving Settings discards it. Import controls are desktop-only. Management errors remain visible.
  Switches use aria-disabled plus a busy guard so a management transition does
  not discard keyboard focus.

Use utilities for layout and component styling. Shared navigation states live in
small component classes; avoid adding unlayered global rules that override
utilities or reaching into a page's CSS module from the shell. Respect reduced
motion with Tailwind's `motion-reduce` variant.

## Desktop chrome

Tauri uses `titleBarStyle: Overlay` and `hiddenTitle` on macOS. Native traffic
lights have a reserved 104px left area before the community switcher only in the
macOS desktop runtime. Web gets no
inset or imitation window controls. Other
platforms retain their native decorations. Drag regions are limited to the
header background; controls remain clickable. On macOS, double-clicking that
background follows the current system title-bar preference (Fill/Zoom, Minimize,
or no action); changing the preference does not require restarting Buzz. Other
platforms retain Tauri's native drag-region behavior. The main-window capability
grants only titlebar dragging and the internal maximize action used by that
handler, plus scoped HTTP(S) opening for
[external links](channels.md#run-the-integration). See
[Tauri window customization](https://v2.tauri.app/learn/window-customization/).

The top-right group contains enabled plugin launchers (Bestie supplies the snake),
a page finder, and the local avatar. `ProfileButton.tsx` subscribes to the community
service's local default profile and opens an anchored account dropdown containing
local presence controls and Settings; there is no separate top-bar Settings button.
The avatar dot shows local intent (Online/Away/Offline). The shared account menu
provides Online, Away and Offline choices: arrow keys move focus, and
Enter/Space selects without closing the menu. See
[presence ownership and limitations](presence.md). Escape, outside click and Tab
leaving dismiss the menu; Escape returns focus to the avatar. Selecting Settings
focuses the main region after the menu finishes closing, unless focus has already
moved into the page.
The avatar does not display the selected community's profile. It uses a configured
HTTPS picture directly, with the name's first letter on a missing/failed picture
or a person icon when unnamed. No sample person's photo is used as the user's
identity. See [community/profile ownership](communities.md).
`PageSearch.tsx` uses a native modal dialog for focus containment, Escape dismissal,
and searching available page destinations. Projects is a bundled, enabled-by-default
page scaffold with only a centered title; Apps waits for a functional destination.
`CommunityRail.tsx` shows Personal space, saved communities and Add persistently
beside page content; it only delegates selection to the existing membership owner.
The rail's Add control opens the existing join dialog and returns focus to its
trigger. The former header picker is not mounted; the rail is the sole selector.
The rail reads saved-community NIP-11 icons through the same-origin broker with at
most two concurrent optional reads, including inactive communities without
opening sessions; slow icon responses cannot occupy all foreground connections.
Unavailable or unsupported images fall back to a saved icon or name initial.
Each saved community has a context menu (right-click, the ContextMenu key or
Shift+F10, labelled “Actions for <name>”) built from the shared context-menu
primitives, in the original's order: Mark all as read, then Copy community URL,
Invite to community and Community settings, then a separator and the destructive
Leave community. Copy writes the canonical HTTPS
origin and reports through the host toast stack. Mark all as read acts only on
the selected community's ready session and only while its read state can sync;
elsewhere it stays visible but disabled with a note saying why. Invite to
community appears only on the selected community, only when the relay-signed
roster names the viewer an owner or admin (the same derivation the Invites
settings card uses), and never in native builds, which cannot mint invites; it
opens the Invites settings card scoped to that community. Community settings is
on every community and opens Settings scoped to that community's origin, which
selects it on the way. Leave community is on every community and opens an alert
dialog owned by the rail (“Leave <name>?”) whose destructive confirm shows a
pending state while the request runs; the menu item itself is disabled and reads
“Leaving…” for that community until the relay answers. The rail publishes the
NIP-43 leave request to the community's relay by origin, then asks the
communities service to forget it; the relay's acceptance or its "not a member"
answer removes the community and reports through the toast stack, while any
other failure keeps the membership and reports the reason. Focus returns to the
community when it is still saved and to Personal space once it is gone. Closing
a menu opened from the keyboard returns focus to
that community; closing one opened by pointer restores whatever had focus
before, so a right-click while typing does not move the caret to the rail.
Opening a menu or running any item never acquires an inactive session, and the
rail still claims no unread total: the unread capability provides bounded
observed evidence, not exact community totals ([unread ownership](unread.md)).

Visible copy uses Buzz, never “workspace.” The legacy `workspace` layout identifier
and CSS variable are implementation details retained for plugin compatibility.

## Assets

`public/` contains browser icons copied from Buzz's desktop icon family. Tauri's
PNG, ICNS, and ICO files are in `src-tauri/icons` and explicitly configured in
`tauri.conf.json`. Replace both sets together when the source branding changes.
The source attribution is in `NOTICE.md`. `public/shell-gradient.png` is the
exact supplied 564×1002 image, stretched across the shell to retain the complete
blue/yellow/white composition. A 36px repeating CSS radial gradient supplies dots
behind, never over, opaque cards; it makes no relay request at runtime.

## Review

Run `just iterate` for UI changes and `just scan` for the broader review checks.
Check Messages and Settings; toggle an optional bundled plugin off/on and confirm its
navigation entry follows; inspect a narrow viewport. On macOS, verify titlebar
alignment, dragging, each macOS title-bar double-click preference, and Settings
access in a built app.

## Messages

The host owns the persistent rounded sidebar card; Messages owns conversation
and contributed panel cards, with 16px gutters. A single right panel fills the conversation height;
the right-column grid splits available height evenly between a local link card
and the launched companion card. Below 1000px
the right column overlays the conversation; it also overlays when the content
pane is too narrow for two columns. Below 650px it fills the page area.
Each card contains its own overflow, keeping the composer and close control visible.
Channels opts into the reusable companion prop and owns both cards, including a
companion-only view without a selected channel or relay. Settings and legacy
pages use the host fallback frame; opening from those pages does not navigate away.
Disabling Bestie removes its snake and open card without evicting a local link card.
The shell supplies the outer page gutter. Channel previews, roster labels, and routine refresh
and freshness indicators are omitted. Channel Settings → Diagnostics keeps
manual refresh, outbox inspection, and timing capture available on demand.

The composer preserves the session's text sending and keyboard behavior. Its
rounded input and lavender send arrow follow the reference; unsupported upload,
mention, and rich-formatting actions are not presented as working controls.
Delivery renders like an ordinary message immediately. After ten seconds from the
message timestamp, unsuccessful/unconfirmed sends show a small notice. Confirmed
messages never show a success label. Retry remains available for failed/unknown
operations. `delivery.test.ts` covers the timing boundary and terminal states.

The shared conversation layer now supplies bounded thread reading/replies and
[session-owned unread indicators](unread.md). These are separate from this styling
pass: counts remain observed rather than exact, manual unread is local-only, and
reading intent belongs to reusable conversation UI rather than shell navigation.
