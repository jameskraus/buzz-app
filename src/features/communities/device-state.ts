import { forgetChannelSetups } from "../channel-templates/setup";
import { forgetQuickReactions } from "../messages/quick-reactions";
import { purgeOutboxStorage } from "../relay/outbox-storage";
import { createHeadPersistence } from "../relay/persistence";
import { purgeReadStateStorage } from "../relay/read-state-storage";
import { clearViewScope } from "../../shared/view-state";

/** Forgets what this device keeps for one community and viewer: view intent
 * (selected channel, drafts, scroll and sidebar state), channel heads, the
 * read-state journal, the outbox and smaller preference stores. Every store is
 * partitioned by `origin:viewer`, so nothing here can touch another community.
 * Each store is cleared independently: an unavailable one does not keep the
 * others, and the caller has already dropped the membership. */
export async function purgeCommunityDeviceState(
  origin: string,
  viewer: string,
) {
  const scope = `${origin}:${viewer}`;
  const failures: unknown[] = [];
  const attempt = async (work: () => void | Promise<void>) => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(() => clearViewScope(scope));
  await attempt(() => forgetChannelSetups(scope));
  await attempt(() => forgetQuickReactions(scope));
  await attempt(async () => {
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
  await attempt(() => purgeReadStateStorage(scope));
  await attempt(() => purgeOutboxStorage(scope));
  return failures;
}
