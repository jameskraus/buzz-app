import { getLogger } from "../developer/logging.ts";
import { logSocketFrame, relayLabel } from "../developer/traffic.ts";

import {
  createSocketPublications,
  SocketRequestError,
} from "./socket-requests.ts";
import {
  OBSERVER_KIND,
  observerGeneration,
  type ObserverFrame,
} from "../agents/observer.ts";
import type { EventTemplate, VerifiedEvent } from "nostr-tools";
import { eventDto } from "./events.ts";
import { EMOJI_SET } from "./emoji.ts";
import { CHANNEL_LIVE_KINDS, pluginRowKinds } from "./kinds.ts";

export const LIVE_CHANNEL_CAPACITY = 1022; // Reserve two of the relay's 1024 slots.
export const LIVE_REPLAY_LIMIT = 500;
/** Channel REQs awaiting EOSE at once. `dev/live-setup-probe.mjs` compares others. */
export const SETUP_CONCURRENCY = 4;
const MAX_QUOTA_RETRIES = 3;
/** Host-owned server cooldown survives socket/POST replacement.
 * Healthy traffic has no inter-request delay; outstanding work is bounded below. */
export function createLiveAdmission() {
  let cooldown = 0;
  let presenceBusy = false,
    presenceNext = 0;
  const pending = new Set<object>();
  return {
    delay: () => Math.max(0, cooldown - performance.now()),
    setup(owner: object, busy: boolean) {
      if (busy) pending.add(owner);
      else pending.delete(owner);
    },
    presenceReady: () => performance.now() >= Math.max(cooldown, presenceNext),
    tryPresence() {
      if (presenceBusy || !this.presenceReady()) return;
      presenceBusy = true;
      return () => {
        presenceBusy = false;
      };
    },
    presenceSent() {
      presenceNext = performance.now() + 5000;
    },
    presenceIdle: () =>
      !presenceBusy && performance.now() >= presenceNext && !pending.size,
    pause(seconds: number) {
      // Redis reports whole seconds; include a second rather than retry before expiry.
      cooldown = Math.max(cooldown, performance.now() + (seconds + 1) * 1000);
    },
  };
}
export type LiveAdmission = ReturnType<typeof createLiveAdmission>;
export type LiveRoute = Readonly<{
  id: string;
  channelId?: string;
  status: "pending" | "live" | "error" | "limited";
  /** EOSE establishes a stream, never proves historical completeness. */
  replay: "unknown" | "limited";
  error?: string;
}>;
export type LiveSnapshot = Readonly<{
  status: "unavailable" | "connecting" | "connected" | "retrying" | "error";
  routes: readonly LiveRoute[];
  error?: string;
}>;
/** Transport provenance, not a history-completeness claim or permission to alert. */
export type LiveProvenance = Readonly<{
  phase: "replay" | "live";
  channelId?: string;
}>;
export function liveProvenance(value: unknown): LiveProvenance {
  if (!value || typeof value !== "object")
    throw new Error("Invalid live provenance");
  const input = value as Record<string, unknown>;
  if (input.phase !== "replay" && input.phase !== "live")
    throw new Error("Invalid live provenance");
  if (
    input.channelId !== undefined &&
    (typeof input.channelId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.channelId))
  )
    throw new Error("Invalid live provenance channel");
  return Object.freeze({
    phase: input.phase,
    ...(typeof input.channelId === "string"
      ? { channelId: input.channelId }
      : {}),
  });
}
export type LiveCallbacks = {
  /** Legacy/missing provenance reconciles quietly; it is never implicitly fresh. */
  receive(events: readonly VerifiedEvent[], provenance?: LiveProvenance): void;
  /** Host-only encrypted telemetry route; never ordinary history reconciliation. */
  telemetry?(event: VerifiedEvent, generation: number): void;
  /** Decoded host DTO on the browser transport. */
  observer?(frame: ObserverFrame, generation: number): void;
  state(snapshot: LiveSnapshot): void;
  established(channelId?: string): void;
  denied(channelId: string, reason: string): void;
};
export type LiveSubscription = {
  /** Local broker handle; not a relay subscription ID. */
  identity?(): string | undefined;
  publish?(event: VerifiedEvent, signal: AbortSignal): Promise<string>;
  update(channels: readonly string[]): void;
  /** Host demand only: reorder existing pending routes, never grant new interests. */
  prioritize?(channels: readonly string[]): void;
  observe?(generation: number | null): void;
  /** One ephemeral status: true = accepted, null = locally unsent, false = unconfirmed/refused. */
  publishPresence?(
    status: "online" | "away" | "offline",
    signal: AbortSignal,
  ): Promise<boolean | null>;
  retry(): void;
  dispose(): void;
};
/** IDs, not names/previews, define interest identity. Never silently truncate. */
export function liveChannels(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 1024 ||
    input.some(
      (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id),
    )
  )
    throw new Error(
      "Invalid live channel interests (maximum 1024 bounded IDs)",
    );
  return [...new Set(input as string[])].sort();
}

type Route = {
  id: string;
  channelId?: string;
  status: LiveRoute["status"];
  replay: LiveRoute["replay"];
  error?: string;
  wire?: string;
  count: number;
  since: number;
  quotaRetries: number;
  deadline?: ReturnType<typeof setTimeout>;
};
const channelKinds = () => [...CHANNEL_LIVE_KINDS, ...pluginRowKinds()];
/** One authenticated socket, independently established channel routes and two explicit globals.
 * Recent replay is opportunistic: finite reads own catch-up and history bounds. */
export function subscribeRelayTraffic(
  url: string,
  sign: (event: EventTemplate) => Promise<VerifiedEvent>,
  viewer: string,
  callbacks: LiveCallbacks,
  socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
  admission: LiveAdmission = createLiveAdmission(),
  setupConcurrency = SETUP_CONCURRENCY,
): LiveSubscription {
  const log = getLogger("relay-ws");
  const peer = relayLabel(url);
  let closed = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0,
    generation = 0,
    serial = 0;
  let authenticated = false;
  let connection: LiveSnapshot["status"] = "connecting";
  let connectionError: string | undefined;
  let interests: string[] = [];
  let priority: string[] = [];
  let observer: number | null = null;
  let presenceReceipt:
    | { id: string; finish(accepted: boolean): void }
    | undefined;
  const routes = new Map<string, Route>();
  const wires = new Map<string, Route>();
  const notify = () => {
    admission.setup(
      routes,
      !closed &&
        connection !== "error" &&
        [...routes.values()].some((route) => route.status === "pending"),
    );
    if (closed) return;
    callbacks.state(
      Object.freeze({
        status: connection,
        routes: Object.freeze(
          [...routes.values()].map(({ id, channelId, status, replay, error }) =>
            Object.freeze({
              id,
              ...(channelId ? { channelId } : {}),
              status,
              replay,
              ...(error ? { error } : {}),
            }),
          ),
        ),
        ...(connectionError ? { error: connectionError } : {}),
      }),
    );
  };
  const send = (value: unknown) => {
    if (!closed && socket?.readyState === 1) {
      const raw = JSON.stringify(value);
      socket.send(raw);
      logSocketFrame(peer, "→", raw, value);
    }
  };
  const requests = createSocketPublications(() => queueMicrotask(pump));
  function remove(route: Route) {
    clearTimeout(route.deadline);
    if (route.wire) {
      wires.delete(route.wire); // Fence before CLOSE, including reentrant callbacks.
      send(["CLOSE", route.wire]);
    }
    routes.delete(route.id);
  }
  function sync() {
    const wanted = new Set([
      "profiles",
      "membership",
      ...(observer !== null ? ["observer"] : []),
      ...interests.map((id) => `channel:${id}`),
    ]);
    for (const route of routes.values())
      if (!wanted.has(route.id)) remove(route);
    for (const id of wanted)
      if (!routes.has(id)) {
        const channelId = id.startsWith("channel:") ? id.slice(8) : undefined;
        routes.set(id, {
          id,
          ...(channelId ? { channelId } : {}),
          status: "pending",
          replay: "unknown",
          count: 0,
          quotaRetries: 0,
          since: Math.floor(Date.now() / 1000) - 300,
        });
      }
    const ranked = [
      ...new Set([
        ...priority.filter((id) => interests.includes(id)),
        ...interests,
      ]),
    ];
    const admitted = new Set(
      ranked.slice(0, LIVE_CHANNEL_CAPACITY - (observer !== null ? 1 : 0)),
    );
    for (const route of routes.values())
      if (route.channelId) {
        if (!admitted.has(route.channelId)) {
          if (route.wire) {
            remove(route);
            routes.set(route.id, route);
            delete route.wire;
          }
          route.status = "limited";
          route.error =
            "Live channel capacity reached; finite reads remain available";
        } else if (route.status === "limited") {
          route.status = "pending";
          delete route.error;
        }
      }
    pump();
    notify();
  }
  function fail(route: Route, reason: string) {
    clearTimeout(route.deadline);
    if (route.wire) {
      wires.delete(route.wire);
      send(["CLOSE", route.wire]);
    }
    delete route.wire;
    route.status = "error";
    route.error = reason;
    if (reason.startsWith("rate-limited:")) {
      const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
        reason,
      );
      const seconds = hint ? Number(hint[1]) : 5;
      if (!Number.isSafeInteger(seconds) || seconds > 60) {
        for (const queued of routes.values())
          if (queued.status === "pending" && !queued.wire) {
            queued.status = "error";
            queued.error = "Unsupported live cooldown; automatic setup stopped";
          }
        // Conservative shared pause survives replacement; never overflow a timer.
        admission.pause(
          Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
        );
      } else {
        admission.pause(seconds);
        if (++route.quotaRetries <= MAX_QUOTA_RETRIES) route.status = "pending";
        else {
          // Stop the unsent queue too: rejection must never drain it into an exhausted budget.
          for (const queued of routes.values())
            if (queued.status === "pending" && !queued.wire) {
              queued.status = "error";
              queued.error =
                "Live request cooldown retries exhausted; retry available";
            }
        }
      }
    }
    notify();
    if (route.channelId && reason === "restricted: not a channel member")
      callbacks.denied(route.channelId, reason);
    pump();
  }
  function pump() {
    clearTimeout(dispatchTimer);
    if (closed || !authenticated || socket?.readyState !== 1) return;
    for (let request = requests.next(); request; request = requests.next()) {
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        return;
      }
      requests.dispatch(request, send);
    }
    let active = [...routes.values()].filter(
      (route) => route.wire && route.status === "pending",
    ).length;
    const rank = (route: Route) =>
      !route.channelId
        ? -2
        : priority.includes(route.channelId)
          ? priority.indexOf(route.channelId)
          : priority.length;
    for (const route of [...routes.values()].sort(
      (a, b) => rank(a) - rank(b),
    )) {
      if (active >= setupConcurrency) break;
      if (route.status !== "pending" || route.wire) continue;
      const delay = admission.delay();
      if (delay > 0) {
        dispatchTimer = setTimeout(pump, delay);
        break;
      }
      // A retry being sent is not recovery. Retain its last failure until EOSE.
      const wire = `live-${++serial}`;
      route.wire = wire;
      wires.set(wire, route);
      route.deadline = setTimeout(() => {
        if (wires.get(wire) === route)
          fail(route, "Live subscription setup timed out; retry available");
      }, 10000);
      active++;
      if (route.id === "observer") route.since = Math.floor(Date.now() / 1000);
      const scope = route.channelId
        ? { kinds: channelKinds(), "#h": [route.channelId] }
        : route.id === "profiles"
          ? { kinds: [0, 10100, 30177] }
          : route.id === "observer"
            ? { kinds: [OBSERVER_KIND], "#p": [viewer] }
            : { kinds: [44100, 44101], "#p": [viewer] };
      send([
        "REQ",
        wire,
        {
          ...scope,
          // Live-only on every actual dispatch, including cooldown retries.
          since: route.since,
          ...(route.id === "observer" ? {} : { limit: LIVE_REPLAY_LIMIT }),
        },
        ...(route.id === "membership"
          ? [
              {
                kinds: [30078],
                authors: [viewer],
                "#t": ["read-state"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
        ...(route.id === "profiles"
          ? [
              {
                kinds: [30315],
                "#d": ["general"],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
              {
                kinds: [30030],
                "#d": [EMOJI_SET],
                since: route.since,
                limit: LIVE_REPLAY_LIMIT,
              },
            ]
          : []),
      ]);
    }
  }
  function clearSocket() {
    generation++;
    authenticated = false;
    presenceReceipt?.finish(false);
    admission.setup(routes, false);
    clearTimeout(dispatchTimer);
    clearTimeout(deadline);
    for (const route of routes.values()) clearTimeout(route.deadline);
    wires.clear();
    requests.clear();
    if (socket) log.info(`${peer} disconnect`);
    socket?.close();
    socket = undefined;
  }
  function connect() {
    if (closed) return;
    clearSocket();
    routes.clear();
    connection = "connecting";
    connectionError = undefined;
    sync();
    const current = generation;
    const valid = () => !closed && current === generation;
    const reconnect = (reason: string) => {
      if (!valid()) return;
      log.warn(`${peer} ${reason}`);
      clearSocket();
      connection = "retrying";
      connectionError = reason;
      for (const route of routes.values())
        if (route.status !== "limited") route.status = "pending";
      notify();
      if (attempts >= 5) {
        connection = "error";
        connectionError = "Live reconnect attempts exhausted; retry available";
        notify();
        return;
      }
      retryTimer = setTimeout(connect, 500 * 2 ** attempts++);
    };
    const terminal = (reason: string) => {
      if (!valid()) return;
      log.error(`${peer} ${reason}`);
      clearSocket();
      connection = "error";
      connectionError = reason;
      notify();
    };
    let ws: WebSocket;
    try {
      log.info(`${peer} connecting`);
      ws = socketFactory(url);
      socket = ws;
    } catch {
      reconnect("Live connection unavailable");
      return;
    }
    let authId: string | undefined;
    let authenticating = false;
    deadline = setTimeout(
      () => reconnect("Live authentication timed out"),
      10000,
    );
    ws.onopen = () => {
      if (valid()) log.info(`${peer} connected`);
    };
    ws.onmessage = async (event) => {
      if (!valid()) return;
      if (typeof event.data !== "string" || event.data.length > 1024 * 1024) {
        logSocketFrame(peer, "←", event.data);
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        logSocketFrame(peer, "←", event.data);
        return;
      }
      logSocketFrame(peer, "←", event.data, data);
      if (!Array.isArray(data)) return;
      if (
        data[0] === "AUTH" &&
        typeof data[1] === "string" &&
        !authenticating
      ) {
        authenticating = true;
        try {
          const auth = await sign({
            kind: 22242,
            content: "",
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", url],
              ["challenge", data[1]],
            ],
          });
          if (!valid()) return;
          if (auth.pubkey !== viewer) {
            terminal("Live signer does not match viewer");
            return;
          }
          authId = auth.id;
          send(["AUTH", auth]);
        } catch {
          terminal("Live authentication signing failed");
        }
        return;
      }
      if (data[0] === "OK" && authId && data[1] === authId && !authenticated) {
        if (data[2] !== true) {
          terminal("Relay rejected live authentication");
          return;
        }
        clearTimeout(deadline);
        authenticated = true;
        connection = "connected";
        pump();
        notify();
        return;
      }
      if (data[0] === "OK" && presenceReceipt?.id === data[1]) {
        if (
          data[2] === false &&
          typeof data[3] === "string" &&
          data[3].startsWith("rate-limited:")
        ) {
          const hint = /^rate-limited: quota exceeded; retry in (\d+)s$/.exec(
            data[3],
          );
          const seconds = hint ? Number(hint[1]) : 86400;
          admission.pause(
            Number.isSafeInteger(seconds) && seconds <= 86400 ? seconds : 86400,
          );
        }
        presenceReceipt?.finish(data[2] === true);
        return;
      }
      if (authenticated && requests.receive(data)) {
        if (data[2] === false) {
          const reason = data[3];
          if (
            typeof reason === "string" &&
            reason.startsWith("rate-limited:")
          ) {
            const hint = /retry in (\d+)s$/.exec(reason);
            admission.pause(hint ? Math.min(Number(hint[1]), 86400) : 5);
          }
        }
        return;
      }
      const route =
        typeof data[1] === "string" ? wires.get(data[1]) : undefined;
      if (!authenticated || !route) return;
      if (data[0] === "EVENT") {
        let incoming: VerifiedEvent;
        try {
          incoming = eventDto(data[2]);
        } catch {
          fail(route, "Relay supplied invalid live traffic");
          return;
        }
        // Preserve route consistency before receive() discards the subscription ID.
        // The typing owner separately checks scope shape and channel access.
        if (
          incoming.kind === 20002 &&
          (!route.channelId ||
            !incoming.tags.some(
              ([name, value]) => name === "h" && value === route.channelId,
            ))
        )
          return;
        if (route.status === "pending") route.count++;
        if (route.id === "observer") {
          if (
            observer !== null &&
            incoming.kind === OBSERVER_KIND &&
            incoming.created_at >= route.since
          )
            callbacks.telemetry?.(incoming, observer);
        } else if (incoming.kind !== OBSERVER_KIND)
          callbacks.receive(
            [incoming],
            Object.freeze({
              phase: route.status === "live" ? "live" : "replay",
              ...(route.channelId ? { channelId: route.channelId } : {}),
            }),
          );
      } else if (data[0] === "EOSE" && route.status === "pending") {
        clearTimeout(route.deadline);
        route.status = "live";
        delete route.error;
        route.replay = route.count >= LIVE_REPLAY_LIMIT ? "limited" : "unknown";
        notify();
        if (!valid() || wires.get(route.wire ?? "") !== route) return;
        if (route.id !== "observer") callbacks.established(route.channelId);
        if (valid()) pump();
      } else if (data[0] === "CLOSED") {
        fail(
          route,
          typeof data[2] === "string"
            ? data[2].slice(0, 512)
            : "Relay closed live subscription",
        );
      }
    };
    ws.onerror = () => reconnect("Live connection interrupted");
    ws.onclose = () => reconnect("Live connection closed");
  }
  connect();
  return {
    async publishPresence(status, signal) {
      if (
        (status !== "online" && status !== "away" && status !== "offline") ||
        signal.aborted ||
        closed ||
        !authenticated
      )
        return null;
      const release = admission.tryPresence();
      if (!release) return null;
      const current = generation;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      try {
        const event = eventDto(
          await sign({
            kind: 20001,
            content: status,
            tags: [],
            created_at: Math.floor(Date.now() / 1000),
          }),
        );
        if (
          bounded.aborted ||
          closed ||
          current !== generation ||
          !authenticated ||
          socket?.readyState !== 1 ||
          !admission.presenceReady()
        )
          return null;
        if (
          event.pubkey !== viewer ||
          event.kind !== 20001 ||
          event.content !== status ||
          event.tags.length
        )
          throw new Error("Presence signer changed intent");
        return await new Promise<boolean>((resolve, reject) => {
          const finish = (accepted: boolean) => {
            clearTimeout(receiptTimeout);
            presenceReceipt = undefined;
            resolve(accepted);
          };
          // Once sent, retain the correlated receipt even if the caller leaves:
          // a late quota refusal still belongs to the shared host cooldown.
          const receiptTimeout = setTimeout(() => finish(false), 10000);
          presenceReceipt = { id: event.id, finish };
          try {
            admission.presenceSent();
            send(["EVENT", event]);
          } catch (error) {
            finish(false);
            reject(error);
          }
        });
      } finally {
        release();
      }
    },
    publish(event, signal) {
      if (closed)
        return Promise.reject(
          new SocketRequestError("Relay session disposed", false),
        );
      if (event.pubkey !== viewer)
        return Promise.reject(
          new SocketRequestError(
            "Publication signer does not match viewer",
            false,
          ),
        );
      return requests.publish(event, signal);
    },
    observe(value) {
      const next = observerGeneration(value);
      if (closed || observer === next) return;
      observer = next;
      const route = routes.get("observer");
      if (route) remove(route); // Fence the old wire before enabling a new generation.
      sync();
    },
    prioritize(input) {
      liveChannels(input); // Same bounded ID validation, but preserve demand order.
      priority = [...new Set(input)].slice(0, 64);
      if (!closed) sync();
    },
    update(input) {
      const next = liveChannels(input);
      if (closed || JSON.stringify(next) === JSON.stringify(interests)) return;
      interests = next;
      sync();
    },
    retry() {
      if (closed) return;
      clearTimeout(retryTimer);
      attempts = 0;
      if (authenticated) {
        for (const route of routes.values()) {
          if (route.status !== "error") continue;
          route.status = "pending";
          route.count = 0;
          route.quotaRetries = 0;
        }
        pump();
        notify();
      } else connect();
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearSocket();
      routes.clear();
    },
  };
}
