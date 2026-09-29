// FOUNDATION: Client identity and membership selection outlive community query sessions.
import type { AgentControl } from "../agents/control";
import type { IdentityNames } from "../identity-names/service";
import { createPresenceActivity } from "../presence/activity";
import { Context } from "@deepseek-ai/cordis";
import { provideRelay, type RelayData } from "../relay/service";
import { connectBrokerTransport, type ReadTransport } from "../relay/transport";
import { communityDestination, isCommunityAlias } from "./destination";
import {
  purgeCommunityDeviceState,
  purgeFailure,
  type PurgeFailure,
} from "./device-state";

export const PROFILE_ABOUT_MAX_LENGTH = 500;
export type PersonalProfile = { name: string; picture: string; about?: string };
export type Membership = { id: string; name: string; icon?: string };
type Saved = {
  profile: PersonalProfile;
  memberships: Membership[];
  selected: string | null;
};
export type ClientSnapshot = Saved & {
  status: "loading" | "ready" | "unavailable";
  // A restored identity does not imply that this build has relay transport.
  relayAvailable: boolean;
  viewer?: string;
  error?: string;
};
const empty = (): Saved => ({
  profile: { name: "", picture: "", about: "" },
  memberships: [],
  selected: null,
});
export function createCommunities(
  ctx: Context,
  live: boolean,
  identityNames?: IdentityNames,
  openRelay = "",
  agentChoices?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh">,
  identityReady?: Promise<string>,
  nativeConnect?: (id: string, signal: AbortSignal) => Promise<ReadTransport>,
) {
  const connect = live
    ? (id: string, signal: AbortSignal) =>
        connectBrokerTransport("", signal, id)
    : identityReady
      ? nativeConnect
      : undefined;
  let state: ClientSnapshot = {
    ...empty(),
    status: live || identityReady ? "loading" : "unavailable",
    relayAvailable: !!connect,
  };
  // Retain temporarily unresolvable deployment aliases in storage, not active UI/sessions.
  const unresolvedMemberships: Membership[] = [];
  let unresolvedSelection: string | null = null;
  let disposed = false;
  const controller = new AbortController();
  const presenceActivity = createPresenceActivity();
  const listeners = new Set<() => void>();
  const relayListeners = new Set<() => void>();
  const sessions = new Map<string, RelayData>();
  // Each session owns a scope so leaving can dispose exactly that one.
  const sessionScopes = new Map<string, Context>();
  const scopes: Context[] = [];
  const disconnected = provideRelay(
    newScope(),
    undefined,
    presenceActivity,
    identityNames,
  );
  function newScope() {
    const scope = new Context();
    scopes.push(scope);
    return scope;
  }
  const current = () =>
    state.selected
      ? (sessions.get(state.selected) ?? disconnected)
      : disconnected;
  const emitRelay = () => {
    for (const fn of relayListeners) fn();
  };
  const update = (
    patch: Partial<ClientSnapshot>,
    persist = true,
    required = false,
  ) => {
    const next = { ...state, ...patch };
    // Commit a deliberate selection only after required persistence succeeds.
    const selection =
      persist && Object.hasOwn(patch, "selected") ? null : unresolvedSelection;
    try {
      if (persist && next.viewer)
        localStorage.setItem(
          `buzz-client.v1:${next.viewer}`,
          JSON.stringify({
            profile: next.profile,
            memberships: [...next.memberships, ...unresolvedMemberships],
            selected: next.selected ?? selection,
          }),
        );
    } catch {
      if (required)
        throw new Error(
          "Could not save this community on this device. Try again.",
        );
      // Preferences are best effort; storage failure must not strand a remote join.
    }
    unresolvedSelection = selection;
    state = next;
    for (const fn of listeners) fn();
    emitRelay();
  };
  const acquire = (id: string, viewer = state.viewer) => {
    if (!connect) return disconnected;
    let session = sessions.get(id);
    if (!session) {
      const scope = newScope();
      session = provideRelay(
        scope,
        (signal) => connect(id, signal),
        presenceActivity,
        identityNames,
        agentChoices,
        viewer ? { viewer, scope: communityDestination(id).url } : undefined,
      );
      sessions.set(id, session);
      sessionScopes.set(id, scope);
      session.subscribe(() => {
        if (state.selected === id) emitRelay();
      });
    }
    return session;
  };
  // Compatibility reader for bundled plugins; captured commands remain bound to their concrete session.
  const relay: RelayData = {
    snapshot: () => current().snapshot(),
    subscribe(fn) {
      relayListeners.add(fn);
      return () => {
        relayListeners.delete(fn);
      };
    },
    retry: () => current().retry(),
    disconnect: () => current().disconnect(),
    clearCache: () => current().clearCache(),
  };
  ctx.provide("relay", relay);
  const identity =
    identityReady ??
    (live
      ? fetch("/api/relay/identity", { signal: controller.signal }).then(
          async (response) => {
            if (!response.ok) throw new Error("Local identity unavailable");
            const { viewer } = await response.json();
            return viewer as string;
          },
        )
      : undefined);
  if (identity)
    void identity
      .then((viewer) => {
        if (typeof viewer !== "string" || !/^[a-f0-9]{64}$/.test(viewer))
          throw new Error("Invalid local identity");
        if (disposed) return;
        let saved = empty();
        let seeded = false;
        try {
          const stored = localStorage.getItem(`buzz-client.v1:${viewer}`);
          const raw = JSON.parse(stored ?? "null");
          if (raw)
            saved = {
              profile: {
                name:
                  typeof raw.profile?.name === "string" ? raw.profile.name : "",
                picture:
                  typeof raw.profile?.picture === "string"
                    ? raw.profile.picture
                    : "",
                about:
                  typeof raw.profile?.about === "string"
                    ? raw.profile.about
                    : "",
              },
              memberships: Array.isArray(raw.memberships)
                ? raw.memberships
                    .flatMap((m: unknown): Membership[] => {
                      if (
                        !m ||
                        typeof m !== "object" ||
                        !("id" in m) ||
                        typeof m.id !== "string" ||
                        !("name" in m) ||
                        typeof m.name !== "string"
                      )
                        return [];
                      const membership = {
                        id: m.id,
                        name: m.name,
                        ...("icon" in m &&
                        typeof m.icon === "string" &&
                        m.icon.startsWith("https://")
                          ? { icon: m.icon }
                          : {}),
                      };
                      try {
                        return [
                          { ...membership, id: communityDestination(m.id).id },
                        ];
                      } catch {
                        if (
                          isCommunityAlias(m.id) &&
                          !unresolvedMemberships.some(
                            (entry) => entry.id === m.id,
                          )
                        )
                          unresolvedMemberships.push(membership);
                        return [];
                      }
                    })
                    .filter(
                      (m: Membership, index: number, all: Membership[]) =>
                        all.findIndex((entry) => entry.id === m.id) === index,
                    )
                : [],
              selected: null,
            };
          else if (openRelay && stored === null) {
            // Development opt-in for a viewer with no saved record on this origin.
            // Any stored record, including Personal space or one this reader
            // cannot understand, wins over the seed.
            const { id, name } = communityDestination(openRelay);
            saved = { ...saved, memberships: [{ id, name }], selected: id };
            seeded = true;
          }
          if (typeof raw?.selected === "string") {
            try {
              saved.selected = communityDestination(raw.selected).id;
            } catch {
              if (unresolvedMemberships.some((m) => m.id === raw.selected))
                unresolvedSelection = raw.selected;
            }
          }
        } catch {
          /* Invalid local preferences do not prevent opening the client. */
        }
        if (!saved.memberships.some((m) => m.id === saved.selected))
          saved.selected = null;
        presenceActivity.setViewer(viewer);
        if (saved.selected) acquire(saved.selected, viewer);
        // A seeded record is saved once so later configuration changes cannot revoke it.
        update({ ...saved, viewer, status: "ready" }, seeded);
      })
      .catch((error) => {
        if (!disposed)
          update({ status: "unavailable", error: String(error) }, false);
      });
  ctx.effect(() => () => {
    disposed = true;
    controller.abort();
    presenceActivity.dispose();
    listeners.clear();
    relayListeners.clear();
    return Promise.all(scopes.map((scope) => scope.fiber.dispose()));
  });
  return {
    presence: presenceActivity,
    relay,
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    select(id: string | null) {
      if (id) id = communityDestination(id).id;
      if (id && !state.memberships.some((m) => m.id === id))
        throw new Error("Join this community first");
      if (id) acquire(id);
      update({ selected: id });
    },
    saveProfile(profile: PersonalProfile) {
      update({ profile });
    },
    joined(membership: Membership, profile: PersonalProfile) {
      membership = {
        ...membership,
        id: communityDestination(membership.id).id,
      };
      update(
        {
          memberships: [
            ...state.memberships.filter((m) => m.id !== membership.id),
            membership,
          ],
          profile: state.profile.name ? state.profile : profile,
          selected: membership.id,
        },
        true,
        !!nativeConnect && !live,
      );
      if (sessions.has(membership.id)) sessions.get(membership.id)?.retry();
      else acquire(membership.id);
      emitRelay();
    },
    /** Forgets a saved community on this device once its relay has released
     * the membership (or never held one). Drops the membership, falls back to
     * Personal space when it was selected, disposes its retained session, then
     * purges the device state keyed by that origin and viewer. Persistence
     * follows `joined`: required where the device record is the only copy, and
     * that save is the only step that throws, before anything has changed.
     * Everything after it is best effort: a session that would not dispose or
     * a store that would not clear is logged and returned, never thrown, since
     * the membership is already gone and only a report can reach the viewer. */
    async leave(id: string): Promise<PurgeFailure[]> {
      id = communityDestination(id).id;
      if (!state.memberships.some((m) => m.id === id)) return [];
      const { viewer } = state;
      const origin = communityDestination(id).url;
      update(
        {
          memberships: state.memberships.filter((m) => m.id !== id),
          ...(state.selected === id ? { selected: null } : {}),
        },
        true,
        !!nativeConnect && !live,
      );
      const failures: PurgeFailure[] = [];
      const scope = sessionScopes.get(id);
      sessions.delete(id);
      sessionScopes.delete(id);
      if (scope) {
        // Every session scope comes from `newScope()`, so this always finds
        // it; guarding keeps a miss from splicing another community's scope.
        const index = scopes.indexOf(scope);
        if (index !== -1) scopes.splice(index, 1);
        try {
          await scope.fiber.dispose();
        } catch (error) {
          failures.push(purgeFailure(origin, "session", error));
        }
      }
      // The session is gone (or at least detached), so nothing below can
      // refill the purged stores.
      if (viewer)
        failures.push(...(await purgeCommunityDeviceState(origin, viewer)));
      return failures;
    },
  };
}
export type Communities = ReturnType<typeof createCommunities>;
