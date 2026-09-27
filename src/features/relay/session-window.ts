import { byteSize } from "./budget";
import { hasTag, type ReadFilter, type RelayEvent } from "./events";
import { channelRowKind, channelRowKinds } from "./kinds";
import type { ReadOptions, RelayReader } from "./reader";
import { WINDOW_PAGE_SIZE, type WindowCursor, type WindowPage } from "./window";

const compare = (a: RelayEvent, b: RelayEvent) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);
const cursorOf = (event: RelayEvent): WindowCursor => ({
  createdAt: event.created_at,
  eventId: event.id,
});
function after(event: RelayEvent, cursor: WindowCursor) {
  return (
    event.created_at < cursor.createdAt ||
    (event.created_at === cursor.createdAt && event.id > cursor.eventId)
  );
}
function paging(cursor: WindowCursor | null) {
  return cursor ? { until: cursor.createdAt, before_id: cursor.eventId } : {};
}

/** Flat conversation paging for ordinary private channels used as sessions.
 * General queries have composite paging but no signed window bounds. Keep that
 * distinction explicit, and fetch complete overlays before displaying a page. */
export async function readSessionWindow(
  reader: RelayReader,
  channelId: string,
  cursor: WindowCursor | null,
  options: ReadOptions,
): Promise<WindowPage> {
  const response = await reader.read(
    [
      {
        kinds: channelRowKinds(),
        "#h": [channelId],
        limit: WINDOW_PAGE_SIZE,
        ...paging(cursor),
      },
    ],
    options,
  );
  const rows = [...new Map(response.map((event) => [event.id, event])).values()]
    .filter(
      (event) => channelRowKind(event.kind) && hasTag(event, "h", channelId),
    )
    .sort(compare);
  if (rows.some((event) => cursor && !after(event, cursor)))
    throw new Error("Session history did not advance. Retry messages.");
  const events = [...rows];
  async function overlays(kinds: number[], ids: string[]) {
    if (!ids.length) return [];
    let next: WindowCursor | null = null;
    const found: RelayEvent[] = [];
    for (;;) {
      const filter: ReadFilter = {
        kinds,
        "#e": ids,
        limit: 500,
        ...paging(next),
      };
      const page = [...(await reader.read([filter], options))].sort(compare);
      const last = page.at(-1);
      if (!last) return found;
      if (page.some((event) => next && !after(event, next)))
        throw new Error(
          "Session message updates did not advance. Retry messages.",
        );
      found.push(...page);
      events.push(...page);
      if (events.length > 2000 || byteSize(events) > 4 * 1024 * 1024)
        throw new Error("Session message updates exceed the read budget.");
      next = cursorOf(last);
      // Continue through short pages: visibility filtering can shrink a response.
    }
  }
  const aux = await overlays(
    [5, 7, 9005, 40003],
    rows.map((event) => event.id),
  );
  await overlays(
    [5, 9005],
    aux
      .filter((event) => [7, 40003].includes(event.kind))
      .map((event) => event.id),
  );
  const last = rows.at(-1);
  // General query pages can be filtered by authorization. Keep offering older
  // history until an empty page, rather than treating a short page as proof.
  return { events, cursor: last ? cursorOf(last) : null, hasMore: !!last };
}
