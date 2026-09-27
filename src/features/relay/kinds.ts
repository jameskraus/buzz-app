/** Timeline event kinds. Every read, live route, fold, unread, typing and search
 * path that asks "is this a channel message?" derives its answer from here. */

/** Authored message rows: chat (9), agent envelope (40002) and code diff (40008). */
export const MESSAGE_KINDS: readonly number[] = [9, 40002, 40008];
export const isMessageKind = (kind: number) => MESSAGE_KINDS.includes(kind);

/** Relay-signed membership notices. */
export const MEMBERSHIP_KIND = 40099;

/** Content rows retained by channel history/live windows, not the unread kind set. */
export const CHANNEL_ROW_KINDS: readonly number[] = [
  ...MESSAGE_KINDS,
  MEMBERSHIP_KIND,
];

/** Kinds that advance a channel's last-activity time, including forum posts and comments. */
export const CHANNEL_ACTIVITY_KINDS: readonly number[] = [
  ...MESSAGE_KINDS,
  45001,
  45003,
];

/** Kinds the host already reads, folds or routes for channels. */
const RESERVED_KINDS = new Set([
  ...CHANNEL_ROW_KINDS,
  ...CHANNEL_ACTIVITY_KINDS,
  5,
  7,
  9005,
  20002,
  39000,
  39001,
  39002,
  39005,
  39006,
  40003,
  40100,
]);
/** Plugin-registered row kinds, reference counted by registration. Rows only:
 * never unread, typing, notification or search evidence. */
const pluginKinds = new Map<number, number>();

/** Adds a kind to channel windows and live routes until the returned release runs.
 * Channels already open pick it up on their next load. */
export function registerPluginRowKind(kind: number): () => void {
  if (!Number.isSafeInteger(kind) || kind < 0 || RESERVED_KINDS.has(kind))
    throw new Error(`Kind ${kind} cannot be a plugin timeline kind`);
  pluginKinds.set(kind, (pluginKinds.get(kind) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pluginKinds.get(kind) ?? 1) - 1;
    if (count) pluginKinds.set(kind, count);
    else pluginKinds.delete(kind);
  };
}
export const pluginRowKind = (kind: number) => pluginKinds.has(kind);
export const pluginRowKinds = () => [...pluginKinds.keys()];

/** Core row kinds plus every registered plugin kind, for reads and live routes. */
export const channelRowKinds = () => [
  ...CHANNEL_ROW_KINDS,
  ...pluginRowKinds(),
];
export const channelRowKind = (kind: number) =>
  CHANNEL_ROW_KINDS.includes(kind) || pluginKinds.has(kind);
