import { useEffect, useState } from "react";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type {
  ChannelLifecycleAction,
  ChannelLifecycleSettings,
} from "../../features/relay/channel-lifecycle-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArchiveIcon,
  SignOutIcon,
  TrashIcon,
} from "../../shared/design-system/icons";

/** Settings reads permissions only while open; the sidebar owns confirmation. */
export function ChannelLifecycleActions({
  channelId,
  lifecycle,
  choose,
}: {
  channelId: string;
  lifecycle: ChannelLifecycleCapability;
  choose(action: ChannelLifecycleAction, trigger: HTMLElement): void;
}) {
  const [state, setState] = useState<{
    channelId: string;
    lifecycle: ChannelLifecycleCapability;
    permissions?: ChannelLifecycleSettings;
    failed?: boolean;
  }>();
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry starts a fresh permission lookup.
  useEffect(() => {
    if (!lifecycle.available) return;
    const controller = new AbortController();
    setState(undefined);
    void lifecycle.load(channelId, controller.signal).then(
      (permissions) => {
        if (!controller.signal.aborted)
          setState({ channelId, lifecycle, permissions });
      },
      () => {
        if (!controller.signal.aborted)
          setState({ channelId, lifecycle, failed: true });
      },
    );
    return () => controller.abort();
  }, [channelId, lifecycle, retry]);
  if (!lifecycle.available)
    return <p>Channel actions unavailable on this connection</p>;
  if (state?.channelId !== channelId || state.lifecycle !== lifecycle)
    return null;
  if (state.failed)
    return (
      <div>
        <p role="alert">Channel actions unavailable</p>
        <Button onClick={() => setRetry((value) => value + 1)}>
          Retry channel permissions
        </Button>
      </div>
    );
  return (
    <>
      {state.permissions?.canLeave && (
        <Button
          variant="destructive"
          onClick={(event) => choose("leave", event.currentTarget)}
        >
          <SignOutIcon size={16} aria-hidden="true" />
          Leave channel
        </Button>
      )}
      {state.permissions?.canArchive && (
        <Button onClick={(event) => choose("archive", event.currentTarget)}>
          <ArchiveIcon size={16} aria-hidden="true" />
          Archive channel
        </Button>
      )}
      {state.permissions?.canDelete && (
        <Button
          variant="destructive"
          onClick={(event) => choose("delete", event.currentTarget)}
        >
          <TrashIcon size={16} aria-hidden="true" />
          Delete channel
        </Button>
      )}
    </>
  );
}
