import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { Contribution } from "../../plugins/contributions";
import type { ContributionReader, MessageRenderer } from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

function rendererFor(
  renderers: readonly Contribution<MessageRenderer>[],
  message: ChannelMessage,
) {
  return renderers.find((entry) => {
    try {
      return entry.matches(message);
    } catch {
      return false;
    }
  });
}
const noRenderers: readonly Contribution<MessageRenderer>[] = [];
const idle = () => () => {};
const none = () => noRenderers;

/** Plugin rows no active renderer claims are left out, not shown as placeholders. */
export function useRenderableRows(
  registry: ContributionReader<MessageRenderer> | undefined,
  rows: readonly ChannelMessage[],
) {
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? idle,
    registry?.snapshot ?? none,
    registry?.snapshot ?? none,
  );
  return useMemo(
    () =>
      rows.some((row) => row.plugin)
        ? rows.filter((row) => !row.plugin || rendererFor(renderers, row))
        : rows,
    [rows, renderers],
  );
}

/** First active match wins; a broken optional renderer leaves the host fallback. */
export function MessageBody({
  registry,
  message,
  children,
}: {
  registry: ContributionReader<MessageRenderer>;
  message: ChannelMessage;
  children: ReactNode;
}) {
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const renderer = rendererFor(renderers, message);
  if (!renderer) return children;
  const Render = renderer.component;
  return (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${message.channelId}:${message.id}`}
      fallback={children}
    >
      <Render message={message} />
    </ContributionBoundary>
  );
}
