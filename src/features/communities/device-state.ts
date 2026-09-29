import { forgetChannelSetups } from "../channel-templates/setup";
import { forgetQuickReactions } from "../messages/quick-reactions";
import { purgeOutboxStorage } from "../relay/outbox-storage";
import { createHeadPersistence } from "../relay/persistence";
import { purgeReadStateStorage } from "../relay/read-state-storage";
import { clearViewScope } from "../../shared/view-state";

/** One piece of a left community's device state that could not be cleared. */
export type PurgeFailure = { store: string; error: unknown };

/** Records a store that could not be cleared. The membership is already gone,
 * so the failure is only observable through the console and the caller's
 * report; nothing retries it later. */
export function purgeFailure(
  origin: string,
  store: string,
  error: unknown,
): PurgeFailure {
  console.warn(`Couldn't clear ${store} for ${origin} on this device`, error);
  return { store, error };
}

/** Forgets what this device keeps for one community and viewer: view intent
 * (selected channel, drafts, scroll and sidebar state), channel heads, the
 * read-state journal, the outbox and smaller preference stores. Every store is
 * partitioned by `origin:viewer`, so nothing here can touch another community.
 * Each store is cleared independently: an unavailable one does not keep the
 * others, and the caller has already dropped the membership. Every failure is
 * logged and returned, named by store, so the caller can say some saved data
 * remains. */
export async function purgeCommunityDeviceState(
  origin: string,
  viewer: string,
): Promise<PurgeFailure[]> {
  const scope = `${origin}:${viewer}`;
  const failures: PurgeFailure[] = [];
  const attempt = async (store: string, work: () => void | Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failures.push(purgeFailure(origin, store, error));
    }
  };
  await attempt("view state", () => clearViewScope(scope));
  await attempt("channel setups", () => forgetChannelSetups(scope));
  await attempt("quick reactions", () => forgetQuickReactions(scope));
  await attempt("channel heads", async () => {
    // Without IndexedDB the cache never existed; the persistence reports it as
    // unavailable rather than empty.
    if (typeof indexedDB === "undefined") return;
    const heads = createHeadPersistence(viewer, origin);
    try {
      await heads.clear();
    } finally {
      heads.close();
    }
  });
  await attempt("read state", () => purgeReadStateStorage(scope));
  await attempt("outbox", () => purgeOutboxStorage(scope));
  return failures;
}
