import { memo, useMemo } from "react";
import { useKnownAgentPubkeys } from "../agents/use-known";
import { useRowProfiles } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { MessageRow, type MessageRowProps } from "./MessageRow";

/** Geometry needs the loaded window; a mounted row only needs its identities. */
export const TimelineMessageRow = memo(function TimelineMessageRow(
  props: Omit<
    MessageRowProps,
    "session" | "profile" | "participantProfiles" | "agentPubkeys"
  > & { session: RelaySession },
) {
  const profiles = useRowProfiles(props.session.profiles, [props.row]);
  const known = useKnownAgentPubkeys(props.session, profiles);
  const keys = [props.row.authorId, ...props.row.participants]
    .filter((id) => known.has(id))
    .sort()
    .join(":");
  const agentPubkeys = useMemo(
    () => new Set(keys ? keys.split(":") : []),
    [keys],
  );
  return (
    <MessageRow
      {...props}
      profile={profiles.get(props.row.authorId)}
      participantProfiles={profiles}
      agentPubkeys={agentPubkeys}
    />
  );
});
