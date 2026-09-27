import type { CustomEmoji } from "./emoji";
import { validatedBlurhash } from "./blurhash";
import { threadReference } from "./thread-reference";
import { emojiTags } from "./emoji";
import { objectBody } from "./body";
import { newer } from "./events";
import type { EventData } from "./events";
import {
  MAX_ATTACHMENT_DURATION_SECONDS,
  type Attachment,
  type ChannelMessage,
} from "./contracts";
import {
  projectMarkdownAttachments,
  relayHashBasename,
  safeAttachmentName,
  safeMessageUrl,
} from "./message-content";

import { channelRowKind, MEMBERSHIP_KIND } from "./kinds";
import { membershipChange } from "./membership";
import { compareMessages, eventMs } from "./message-order";
const HEX64 = /^[0-9a-f]{64}$/;

function isLegacyVoiceNote(mime: string | undefined, name: string | undefined) {
  // Old Buzz uploads voice notes as video/mp4: a 16x16 H.264 black track plus AAC
  // because the relay video validator requires a video track; classify by filename convention.
  return (
    (mime === "video/mp4" || mime?.startsWith("video/mp4;") === true) &&
    name?.startsWith("voice-note-") === true &&
    name.endsWith(".mp4")
  );
}

function attachmentKind(
  fields: Record<string, string>,
  url: string,
  detectionName: string | undefined,
): Attachment["kind"] {
  const mime = fields.m?.toLowerCase();
  const voiceNoteName = detectionName?.toLowerCase();
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("audio/") || isLegacyVoiceNote(mime, voiceNoteName))
    return "audio";
  if (mime?.startsWith("video/")) return "video";
  if (fields.m) return "file";
  if (/\.(mp4|webm)(?:\?|$)/i.test(url)) return "video";
  if (/\.(png|jpe?g|gif|webp|avif)(?:\?|$)/i.test(url)) return "image";
  return "file";
}

function attachmentName(url: string): string | undefined {
  const segment = new URL(url).pathname.split("/").pop();
  if (!segment) return undefined;
  try {
    const decoded = decodeURIComponent(segment);
    return !relayHashBasename(decoded)
      ? safeAttachmentName(decoded)
      : undefined;
  } catch {
    return !relayHashBasename(segment)
      ? safeAttachmentName(segment)
      : undefined;
  }
}

export function imetaAttachmentUrls(event: EventData): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const entry of event.tags) {
    if (entry[0] !== "imeta") continue;
    const fields = Object.fromEntries(
      entry.slice(1).map((field) => {
        const split = field.indexOf(" ");
        return [field.slice(0, split), field.slice(split + 1)];
      }),
    );
    const url = fields.url ? safeMessageUrl(fields.url) : undefined;
    if (url) urls.add(url);
  }
  return urls;
}

export function parseAttachments(
  event: EventData,
  markdownImages: readonly string[],
  markdownLinkNames: ReadonlyMap<string, string> = new Map(),
): Attachment[] {
  const result: Attachment[] = [];
  const seen = new Set<string>();
  for (const entry of event.tags) {
    if (entry[0] !== "imeta") continue;
    const fields = Object.fromEntries(
      entry.slice(1).map((field) => {
        const split = field.indexOf(" ");
        return [field.slice(0, split), field.slice(split + 1)];
      }),
    );
    const url = fields.url ? safeMessageUrl(fields.url) : undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // Treat signed metadata as untrusted layout input. Invalid/missing dimensions
    // use the renderer's stable fallback rather than image-load-driven geometry.
    const dim = /^(\d{1,6})x(\d{1,6})$/.exec(fields.dim ?? "");
    const width = Number(dim?.[1]),
      height = Number(dim?.[2]);
    const blurhash = validatedBlurhash(fields.blurhash);
    const previewUrl =
      fields.image || fields.thumb
        ? safeMessageUrl(fields.image ?? fields.thumb ?? "")
        : undefined;
    const parsedSize = /^[1-9]\d*$/.test(fields.size ?? "")
      ? Number(fields.size)
      : undefined;
    // Treat signed metadata as untrusted layout input. Invalid/unbounded duration
    // uses a stable unknown-duration fallback.
    const parsedDuration = /^\d+(?:\.\d+)?$/.test(fields.duration ?? "")
      ? Number(fields.duration)
      : undefined;
    const duration =
      parsedDuration !== undefined &&
      parsedDuration > 0 &&
      parsedDuration <= MAX_ATTACHMENT_DURATION_SECONDS
        ? parsedDuration
        : undefined;
    const filename = fields.filename
      ? safeAttachmentName(fields.filename)
      : undefined;
    const basename = attachmentName(url);
    const name = markdownLinkNames.get(url) ?? filename ?? basename;
    const detectionName = filename ?? markdownLinkNames.get(url) ?? basename;
    const kind = attachmentKind(fields, url, detectionName);
    result.push({
      url,
      kind,
      ...(fields.m ? { mime: fields.m } : {}),
      ...(parsedSize !== undefined && Number.isSafeInteger(parsedSize)
        ? { size: parsedSize }
        : {}),
      ...(name ? { name } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(blurhash ? { blurhash } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      ...(width > 0 && height > 0 ? { dimensions: { width, height } } : {}),
    });
  }
  for (const url of markdownImages) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (/\.(mp4|webm)(?:\?|$)/i.test(url)) result.push({ url, kind: "video" });
    else result.push({ url, kind: "image" });
  }
  return result;
}

function parseSummary(
  event: EventData | undefined,
): Pick<ChannelMessage, "replyCount" | "participants"> {
  if (!event) return { replyCount: 0, participants: Object.freeze([]) };
  try {
    const body = objectBody(event.content);
    if (!body) return { replyCount: 0, participants: Object.freeze([]) };
    const replyCount =
      typeof body.descendant_count === "number" &&
      Number.isInteger(body.descendant_count) &&
      body.descendant_count >= 0
        ? body.descendant_count
        : typeof body.reply_count === "number" &&
            Number.isInteger(body.reply_count) &&
            body.reply_count >= 0
          ? body.reply_count
          : 0;
    const participants = Array.isArray(body.participants)
      ? body.participants.filter(
          (value): value is string =>
            typeof value === "string" && HEX64.test(value),
        )
      : [];
    return {
      replyCount,
      participants: Object.freeze([...new Set(participants)]),
    };
  } catch {
    return { replyCount: 0, participants: Object.freeze([]) };
  }
}

/** Folds one window's top-level messages with their aux overlays: author deletes (5/9005),
 * author edits (40003, latest wins), reactions (7) and relay-signed thread summaries (39005).
 * Replies stay out of the top level. Output is ascending by time; ties break on id so windows merge deterministically. */
export function foldMessages(
  channelId: string,
  relayAuthor: string,
  events: readonly EventData[],
  { includeReplies = false }: { includeReplies?: boolean } = {},
): ChannelMessage[] {
  const overlays = new Map<string, EventData[]>();
  const summaries = new Map<string, EventData>();
  for (const event of events) {
    if (channelRowKind(event.kind)) continue;
    if (event.kind === 39005) {
      const target = event.tags.find((entry) => entry[0] === "e")?.[1];
      if (target && event.pubkey === relayAuthor)
        summaries.set(target, newer(summaries.get(target), event));
      continue;
    }
    for (const entry of event.tags) {
      if (entry[0] !== "e" || !entry[1]) continue;
      const list = overlays.get(entry[1]) ?? [];
      list.push(event);
      overlays.set(entry[1], list);
    }
  }
  const deleted = (event: EventData) =>
    overlays
      .get(event.id)
      ?.some(
        (item) => [5, 9005].includes(item.kind) && item.pubkey === event.pubkey,
      ) ?? false;
  const rows: ChannelMessage[] = [];
  for (const event of events) {
    if (!channelRowKind(event.kind)) continue;
    if (!event.tags.some((entry) => entry[0] === "h" && entry[1] === channelId))
      continue;
    if (
      !includeReplies &&
      event.tags.some((entry) => entry[0] === "e" && entry[3] === "reply") &&
      !event.tags.some((entry) => entry[0] === "broadcast" && entry[1] === "1")
    )
      continue;
    const aux = overlays.get(event.id) ?? [];
    if (deleted(event)) continue;
    if (event.kind === MEMBERSHIP_KIND) {
      const membership = membershipChange(event, relayAuthor);
      if (membership)
        rows.push(
          Object.freeze({
            id: event.id,
            channelId,
            authorId: event.pubkey,
            createdAt: event.created_at,
            createdAtMs: eventMs(event),
            content: "",
            membership,
            mentions: Object.freeze([]),
            attachments: Object.freeze([]),
            reactions: Object.freeze([]),
            replyCount: 0,
            participants: Object.freeze([]),
          }),
        );
      continue;
    }
    const edits = aux
      .filter(
        (item) =>
          item.kind === 40003 && item.pubkey === event.pubkey && !deleted(item),
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    let content = edits[0]?.content ?? event.content;
    if (event.kind === 40002) {
      const body = objectBody(content);
      if (typeof body?.content === "string") content = body.content;
    }
    const attachmentEvent =
      edits.find((edit) => edit.tags.some(([name]) => name === "imeta")) ??
      event;
    const imetaUrls = imetaAttachmentUrls(attachmentEvent);
    // Every CommonMark image begins with `![`, and every attachment title link
    // needs an imeta URL match; avoid parsing ordinary messages.
    const projected =
      event.kind !== 40008 && (content.includes("![") || imetaUrls.size)
        ? projectMarkdownAttachments(content, imetaUrls)
        : {
            content,
            urls: Object.freeze([] as string[]),
            names: Object.freeze([]),
          };
    const attachmentNames = new Map<string, string>();
    for (const { url, name } of projected.names)
      if (!attachmentNames.has(url)) attachmentNames.set(url, name);
    rows.push(
      Object.freeze({
        id: event.id,
        channelId,
        threadRootId: threadReference(event)?.rootId,
        replyParentId: threadReference(event)?.parentId,
        authorId: event.pubkey,
        createdAt: event.created_at,
        createdAtMs: eventMs(event),
        content: projected.content,
        ...(projected.content !== content ? { sourceContent: content } : {}),
        ...(event.kind === 40002 ? { agentEnvelope: true as const } : {}),
        ...(event.kind === 40008
          ? {
              diff: Object.freeze({
                filePath: event.tags.find(([name]) => name === "file")?.[1],
                repoUrl: event.tags.find(([name]) => name === "repo")?.[1],
                commitSha: event.tags.find(([name]) => name === "commit")?.[1],
                description: event.tags.find(
                  ([name]) => name === "description",
                )?.[1],
                truncated: event.tags.some(
                  ([name, value]) => name === "truncated" && value === "true",
                ),
              }),
            }
          : {}),
        ...(edits.length ? { edited: true as const } : {}),
        ...(projected.content !== content &&
        projected.content !== content.trimEnd()
          ? { attachmentContentRemoved: true as const }
          : {}),
        mentionReferences: Object.freeze([
          ...new Set(
            event.tags.flatMap((tag) =>
              tag.length === 2 &&
              tag[0] === "mention" &&
              tag[1] &&
              HEX64.test(tag[1])
                ? [tag[1]]
                : [],
            ),
          ),
        ]),
        mentions: Object.freeze([
          ...new Set(
            event.tags.flatMap(([name, value]) =>
              name === "p" && value && HEX64.test(value) ? [value] : [],
            ),
          ),
        ]),
        ...(attachmentEvent !== event
          ? { attachmentSourceId: attachmentEvent.id }
          : {}),
        attachments: Object.freeze(
          parseAttachments(attachmentEvent, projected.urls, attachmentNames),
        ),
        emoji: emojiTags(
          edits[0]?.tags.some(([name]) => name === "emoji") ? edits[0] : event,
        ),
        reactions: groupReactions(
          aux.filter((item) => item.kind === 7),
          deleted,
        ),
        ...parseSummary(summaries.get(event.id)),
      }),
    );
  }
  return rows.sort(compareMessages);
}

/** Count people, but retain event IDs for author-only removal and duplicate cleanup. */
export function groupReactions(
  events: readonly EventData[],
  deleted: (event: EventData) => boolean = () => false,
) {
  const groups = new Map<
    string,
    {
      content: string;
      emoji?: CustomEmoji;
      events: { id: string; authorId: string }[];
      firstAt: number;
      firstId: string;
    }
  >();
  for (const event of events) {
    const emoji = emojiTags(event).find(
      (entry) => event.content.toLowerCase() === `:${entry.shortcode}:`,
    );
    const content = emoji ? `:${emoji.shortcode}:` : event.content;
    const key = JSON.stringify([content, emoji?.url]);
    const group = groups.get(key) ?? {
      content,
      ...(emoji ? { emoji } : {}),
      events: [],
      firstAt: event.created_at,
      firstId: event.id,
    };
    if (
      event.created_at < group.firstAt ||
      (event.created_at === group.firstAt && event.id < group.firstId)
    ) {
      group.firstAt = event.created_at;
      group.firstId = event.id;
    }
    if (!deleted(event) && !group.events.some((entry) => entry.id === event.id))
      group.events.push(
        Object.freeze({ id: event.id, authorId: event.pubkey }),
      );
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()]
      .filter((group) => group.events.length > 0)
      .sort(
        (a, b) => a.firstAt - b.firstAt || a.firstId.localeCompare(b.firstId),
      )
      .map(({ content, emoji, events }) =>
        Object.freeze({
          content,
          ...(emoji ? { emoji } : {}),
          events: Object.freeze(events),
        }),
      ),
  );
}
