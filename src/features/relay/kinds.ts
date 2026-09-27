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

/** Core kinds each channel's live route subscribes to. */
export const CHANNEL_LIVE_KINDS: readonly number[] = [
  ...CHANNEL_ACTIVITY_KINDS,
  MEMBERSHIP_KIND,
  40100,
  40003,
  5,
  9005,
  7,
  39000,
  39002,
  39005,
  20002,
];

/** Kinds the host already reads, folds or routes for channels. */
const RESERVED_KINDS = new Set([...CHANNEL_LIVE_KINDS, 39001, 39006]);
/** Plugin-registered row kinds, reference counted by registration. Rows only:
 * never unread, typing, notification or search evidence. */
const pluginKinds = new Map<number, number>();
const kindListeners = new Set<() => void>();
const pluginKind = (kind: unknown): kind is number =>
  Number.isInteger(kind) &&
  (kind as number) >= 0 &&
  (kind as number) <= 65535 &&
  !RESERVED_KINDS.has(kind as number);

/** Adds a kind to channel windows and live routes until the returned release runs.
 * Live routes switch immediately; channels already open read its history on their next load. */
export function registerPluginRowKind(kind: number): () => void {
  if (!pluginKind(kind))
    throw new Error(`Kind ${kind} cannot be a plugin timeline kind`);
  const count = pluginKinds.get(kind) ?? 0;
  pluginKinds.set(kind, count + 1);
  if (!count) for (const listener of kindListeners) listener();
  return () => {
    const count = (pluginKinds.get(kind) ?? 1) - 1;
    if (count) pluginKinds.set(kind, count);
    else {
      pluginKinds.delete(kind);
      for (const listener of kindListeners) listener();
    }
  };
}
export const pluginRowKind = (kind: number) => pluginKinds.has(kind);
export const pluginRowKinds = () =>
  [...pluginKinds.keys()].sort((a, b) => a - b);
/** Calls `listener` whenever the registered kind set changes. */
export function onPluginRowKinds(listener: () => void) {
  kindListeners.add(listener);
  return () => void kindListeners.delete(listener);
}
/** Validates a plugin kind list crossing a process boundary (the live broker). */
export function pluginRowKindList(input: unknown): number[] {
  if (!Array.isArray(input) || input.length > 256 || !input.every(pluginKind))
    throw new Error("Invalid plugin timeline kinds");
  return [...new Set(input)].sort((a, b) => a - b);
}

/** Core row kinds plus every registered plugin kind, for reads and live routes. */
export const channelRowKinds = () => [
  ...CHANNEL_ROW_KINDS,
  ...pluginRowKinds(),
];
export const channelRowKind = (kind: number) =>
  CHANNEL_ROW_KINDS.includes(kind) || pluginKinds.has(kind);
