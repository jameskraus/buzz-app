import { useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  AgentView,
  CloneSettings,
  CommunityResolution,
  ImportSource,
} from "../../features/agents/control";
import {
  agentSetupConfirmationAvailable,
  communityRequest,
} from "../../features/communities/api";
import { Button } from "../../shared/design-system/ui/Button";

export const agentSetupUnavailableMessage =
  "This app version cannot finish setting up imported agents yet.";

/** Uses retained app custody, never a legacy preview or credential import. */
export function LocalInventoryAction({
  control,
  agent,
  pubkey,
  source,
  action,
  destination,
  owner,
  disabled,
  onPending,
  onUsed,
  onClone,
}: {
  control: AgentControl;
  agent?: AgentView | undefined;
  pubkey?: string;
  source?: ImportSource | undefined;
  action: "use" | "clone";
  destination: string;
  owner: string;
  disabled: boolean;
  onPending(pending: boolean): void;
  onUsed(): void;
  onClone(settings: CloneSettings): void;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      onPending(false);
    };
  }, [onPending]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Clone reads saved settings locally; only Use here needs the confirmation.
  if (action === "use" && !agentSetupConfirmationAvailable())
    return <p role="status">{agentSetupUnavailableMessage}</p>;
  return (
    <>
      <p>
        {action === "use"
          ? "Finish setting up this older incomplete import in this community using its existing key. It stays stopped. To copy an agent already configured elsewhere, use Clone."
          : "Review the saved name and instructions before creating a new agent. The original agent does not change."}
      </p>
      {action === "use" && destination && <p>Destination: {destination}</p>}
      {action === "use" && (!destination || !owner) && (
        <p>Connect to the destination community to use this identity there.</p>
      )}
      <Button
        disabled={disabled || pending || !destination || !owner}
        onClick={async () => {
          setPending(true);
          onPending(true);
          setError(null);
          try {
            if (action === "use") {
              if (!control.configureHere || !agent)
                throw new Error("Use here is unavailable.");
              const resolution = await communityRequest<CommunityResolution>(
                destination,
                "resolve-agent-community",
                {
                  pubkey: agent.pubkey,
                  owner,
                  confirmed: true,
                },
              );
              if (!active.current) return;
              await control.configureHere(agent.id, resolution);
              if (active.current) onUsed();
            } else {
              const settings =
                source && pubkey && control.cloneSettings
                  ? await control.cloneSettings(source, pubkey)
                  : agent && control.localCloneSettings
                    ? await control.localCloneSettings(agent.id)
                    : null;
              if (!settings)
                throw new Error(
                  "Cloning this agent is unavailable in this app version.",
                );
              if (active.current) onClone(settings);
            }
          } catch (reason) {
            if (active.current)
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not complete this action. Refresh and try again.",
              );
          } finally {
            if (active.current) {
              setPending(false);
              onPending(false);
            }
          }
        }}
      >
        {action === "use" ? "Use here" : "Review clone"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
