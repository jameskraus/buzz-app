import { useIdentityNames } from "../../features/identity-names/react";
import type { IdentityNameView } from "../../features/identity-names/service";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { selectProfiles } from "../../features/relay/profile-selection";

/** Visible labels share the session's bounded profile directory, not per-row fetches. */
export function useChannelLabels(
  roster: readonly ChannelSummary[],
  queries: ProfileQueries,
  names?: IdentityNameView,
) {
  const resolveName = useIdentityNames(names);
  const channels = useMemo(
    () =>
      roster.filter(
        (channel) =>
          !channel.archived &&
          (!channel.hidden || channel.channelType === "dm"),
      ),
    [roster],
  );
  const key = [
    ...new Set(channels.flatMap((channel) => channel.participants ?? [])),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  const ids = useMemo(() => (key ? key.split(":") : []), [key]);
  const selection = useMemo(() => selectProfiles(queries, ids), [queries, ids]);
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  // Access loss can purge loaded names or abort a cold fetch without changing
  // DM participants. Retry for missing names or changed channel membership,
  // not for message previews/renders; keep enrichment in the background.
  const membership = roster
    .map((channel) => channel.id)
    .sort()
    .join(":");
  const missing = ids.filter((id) => !profiles.has(id)).join(":");
  useEffect(() => {
    if (membership && missing)
      void queries.ensure(missing.split(":"), "background").catch(() => {});
  }, [queries, missing, membership]);
  const labelled = useRef(
    new WeakMap<
      ChannelSummary,
      {
        name: string;
        channel: ChannelSummary;
        profiles: ReadonlyMap<string, Profile>;
        resolveName: typeof resolveName;
      }
    >(),
  );
  const labelledChannels = useMemo(
    () =>
      channels.map((channel) => {
        if (channel.channelType !== "dm" || !channel.participants)
          return channel;
        const previous = labelled.current.get(channel);
        if (
          previous?.profiles === profiles &&
          previous.resolveName === resolveName
        )
          return previous.channel;
        const name = channel.participants.length
          ? channel.participants
              .map((id) =>
                resolveName(
                  id,
                  profiles.get(id)?.name ?? id.slice(0, 10),
                  channel.participants,
                ),
              )
              .join(", ")
          : "Notes to self";
        const result =
          previous?.name === name ? previous.channel : { ...channel, name };
        labelled.current.set(channel, {
          name,
          channel: result,
          profiles,
          resolveName,
        });
        return result;
      }),
    [channels, profiles, resolveName],
  );
  return { channels: labelledChannels, profiles };
}
