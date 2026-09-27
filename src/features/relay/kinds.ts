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
export const channelRowKind = (kind: number) =>
  CHANNEL_ROW_KINDS.includes(kind);

/** Kinds that advance a channel's last-activity time, including forum posts and comments. */
export const CHANNEL_ACTIVITY_KINDS: readonly number[] = [
  ...MESSAGE_KINDS,
  45001,
  45003,
];
