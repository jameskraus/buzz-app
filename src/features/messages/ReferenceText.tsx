import { useChannelIdentityNames } from "../identity-names/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { AtIcon, RobotIcon } from "../../shared/design-system/icons/index";
import type { RelaySession } from "../relay/session";
import type { ChannelList, ChannelSummary, Profile } from "../relay/contracts";
import { messageReferences } from "./message-references";
import { MessageLink } from "../conversation/MessageLink";
import type { ConversationExtensions } from "../conversation/contracts";
import { parseBuzzLink } from "../navigation/buzz-links";
import type { AgentLibrary } from "../agents/library";
import styles from "../../shared/InlineReference.module.css";

const emptyProfiles: ReadonlyMap<string, Profile> = new Map();
/** The only channel fields a reference may read; the rest can be out of date. */
export type ReferenceChannel = Pick<
  ChannelSummary,
  "id" | "name" | "channelType" | "private" | "archived"
>;
const emptyChannels: readonly ReferenceChannel[] = [];
const emptyAgents: AgentLibrary["identities"] = [];
export const emptyReferenceDirectory = {
  profiles: emptyProfiles,
  channels: emptyChannels,
  agents: emptyAgents,
};
const noop = () => () => {};
const profilesSnapshot = () => emptyProfiles;
const channelsSnapshot = () => emptyChannels;
const agentsSnapshot = () => undefined;
type ChannelLists = Pick<RelaySession["channels"], "list">;
const referenced = new WeakMap<
  ChannelLists,
  { list: ChannelList; channels: readonly ReferenceChannel[] }
>();
/** Previews and activity replace the list and its summaries on every message.
 * Retain the prior channels while every field a reference reads is unchanged,
 * so mounted rows render only when a label could change. */
function referenceChannels(queries: ChannelLists) {
  const list = queries.list();
  const prior = referenced.get(queries);
  if (prior?.list === list) return prior.channels;
  const channels =
    prior?.channels.length === list.channels.length &&
    list.channels.every((channel, index) => {
      const old = prior.channels[index];
      return (
        old?.id === channel.id &&
        old.name === channel.name &&
        old.channelType === channel.channelType &&
        old.private === channel.private &&
        old.archived === channel.archived
      );
    })
      ? prior.channels
      : list.channels;
  referenced.set(queries, { list, channels });
  return channels;
}

export function useReferenceDirectory(
  session: RelaySession | undefined,
  selectedProfiles?: ReadonlyMap<string, Profile>,
) {
  const profiles = useSyncExternalStore(
    selectedProfiles ? noop : (session?.profiles?.subscribe ?? noop),
    selectedProfiles
      ? () => selectedProfiles
      : (session?.profiles?.snapshot ?? profilesSnapshot),
    profilesSnapshot,
  );
  const queries = session?.channels;
  const channels = useSyncExternalStore(
    queries?.subscribeList ?? noop,
    queries?.list ? () => referenceChannels(queries) : channelsSnapshot,
    channelsSnapshot,
  );
  const agents = useSyncExternalStore(
    session?.agentLibrary?.subscribe ?? noop,
    session?.agentLibrary?.snapshot ?? agentsSnapshot,
    agentsSnapshot,
  );
  return {
    profiles,
    channels,
    agents: agents?.identities ?? emptyAgents,
  };
}

/** Buzz links carry no community, so they always name a channel in the receiving one. */
export function channelForLink(
  url: string,
  channels: readonly ReferenceChannel[],
) {
  const parsed = parseBuzzLink(url);
  const target = parsed?.format === "legacy" ? parsed : undefined;
  return target && channels.find((item) => item.id === target.channelId);
}

export function channelLinkLabel(
  url: string,
  channels: readonly ReferenceChannel[],
) {
  const channel = channelForLink(url, channels);
  const parsed = parseBuzzLink(url);
  const target = parsed?.format === "legacy" ? parsed : undefined;
  return channel
    ? `${channel.channelType === "dm" || target?.messageId ? "" : "#"}${channel.name}`
    : undefined;
}

export function ReferenceText({
  text,
  mentions,
  directory,
  renderText,
  onOpenLink,
  extensions,
  session,
  scope,
  channelId,
  interactive = true,
}: {
  text: string;
  mentions: readonly string[];
  directory: ReturnType<typeof useReferenceDirectory>;
  renderText(text: string): ReactNode;
  onOpenLink(url: string): boolean;
  extensions?: ConversationExtensions | undefined;
  session?: RelaySession | undefined;
  scope?: string | undefined;
  channelId?: string | undefined;
  interactive?: boolean;
}) {
  const resolveName = useChannelIdentityNames(session, channelId, mentions);
  const references = messageReferences(
    text,
    mentions,
    directory.profiles,
    directory.channels,
    directory.agents,
  );
  if (!references.length) return renderText(text);
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const reference of references) {
    parts.push(
      <span key={`text:${offset}`}>
        {renderText(text.slice(offset, reference.start))}
      </span>,
    );
    const label =
      reference.kind === "channel"
        ? reference.label.slice(1)
        : resolveName(reference.id, reference.label.slice(1));
    const Icon = reference.kind === "agent" ? RobotIcon : AtIcon;
    parts.push(
      reference.kind === "channel" ? (
        <MessageLink
          key={reference.start}
          url={`buzz://channel/${encodeURIComponent(reference.id)}`}
          label={reference.label}
          registry={extensions?.links}
          onOpenLink={onOpenLink}
          session={session}
          scope={scope}
          interactive={interactive}
          channelPrivate={!!reference.private}
        />
      ) : (
        <span
          key={reference.start}
          className={styles.link}
          data-mention-kind={reference.kind}
          title={`${reference.kind === "agent" ? "Agent" : "Person"}: ${label}\n${reference.id}`}
        >
          <Icon aria-hidden="true" className={styles.icon} />
          {label}
        </span>
      ),
    );
    offset = reference.end;
  }
  parts.push(
    <span key={`text:${offset}`}>{renderText(text.slice(offset))}</span>,
  );
  return <>{parts}</>;
}
