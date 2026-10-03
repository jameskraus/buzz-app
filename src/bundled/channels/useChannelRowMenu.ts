import { useCallback, useState } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";

type Section = { key: string; rows: readonly ChannelSummary[] };
type RowMenu = {
  channelId: string;
  sectionKey: string;
  anchor?: HTMLElement;
};

/** Sidebar-owned menu identity follows rendered placement, not a saved group id. */
export function useChannelRowMenu<Action>(
  sections: readonly Section[],
  actionsFor: (
    channel: ChannelSummary,
    sectionKey: string,
  ) => readonly Action[],
) {
  const [rowMenu, setRowMenu] = useState<RowMenu>();
  // Clear during render so children cannot commit a stale portal after a move.
  // Merely masking `open` leaves the old identity able to resurrect on return.
  if (rowMenu) {
    const channel = sections
      .find((section) => section.key === rowMenu.sectionKey)
      ?.rows.find((channel) => channel.id === rowMenu.channelId);
    if (!channel || actionsFor(channel, rowMenu.sectionKey).length === 0)
      setRowMenu(undefined);
  }
  const open = useCallback(
    (channel: ChannelSummary, sectionKey: string, anchor?: HTMLElement) => {
      setRowMenu({
        channelId: channel.id,
        sectionKey,
        ...(anchor ? { anchor } : {}),
      });
    },
    [],
  );
  const close = useCallback(() => setRowMenu(undefined), []);
  return { rowMenu, open, close };
}
