// Development probe: how long live coverage of a channel roster takes to set up
// under different subscription strategies, against a real relay. Each run uses a
// fresh authenticated socket. `client:K` drives the app's own subscriber with K
// setups outstanding (the app uses SETUP_CONCURRENCY); the other strategies send
// raw REQs the app does not send today. A canary REQ sent right after the burst
// measures how long other socket work waits behind setup.
import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { setLogLevel } from "../src/features/developer/logging.ts";
import { percentile } from "../src/features/developer/client-metrics.ts";
import {
  LIVE_REPLAY_LIMIT,
  SETUP_CONCURRENCY,
  subscribeRelayTraffic,
} from "../src/features/relay/live.ts";
import { CHANNEL_LIVE_KINDS } from "../src/features/relay/kinds.ts";

const CANARY = "probe-canary";
const ROSTER_LIMIT = 500;
// Runs that never reached a milestone report `undefined` for it.
const median = (values) =>
  percentile(
    values.filter((value) => value !== undefined),
    50,
  );

/** `client:4`, `client:all`, `filters:10`, `multi-h:all`, `idle`. */
export function parseStrategy(value) {
  const [kind, size = "1"] = value.split(":");
  const count = size === "all" ? Number.POSITIVE_INFINITY : Number(size);
  if (
    !["client", "filters", "multi-h", "idle"].includes(kind) ||
    !(count >= 1) ||
    (count !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(count))
  )
    throw new Error(`Unknown strategy ${value}`);
  return { name: value, kind, size: count };
}
const channelFilter = (channels, since) => ({
  kinds: CHANNEL_LIVE_KINDS,
  "#h": channels,
  since,
  limit: LIVE_REPLAY_LIMIT,
});
function chunk(items, size) {
  const width = Math.max(1, Math.min(size, items.length));
  return Array.from({ length: Math.ceil(items.length / width) }, (_, i) =>
    items.slice(i * width, (i + 1) * width),
  );
}

/** Observe every frame on a socket without changing what its owner sees. */
function tapSocket(socket, tap) {
  const wrapper = {
    get readyState() {
      return socket.readyState;
    },
    send(text) {
      tap.sent(text);
      socket.send(text);
    },
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = (event) => wrapper.onopen?.(event);
  socket.onmessage = (event) => {
    if (!tap.received(event.data)) wrapper.onmessage?.(event);
  };
  socket.onclose = (event) => wrapper.onclose?.(event);
  socket.onerror = (event) => wrapper.onerror?.(event);
  return wrapper;
}

/** One strategy on one fresh socket. Resolves with its timings. */
export function runStrategy({
  url,
  key,
  channels,
  strategy,
  socketFactory = (target) => new WebSocket(target),
  now = () => performance.now(),
  timeoutMs = 30000,
}) {
  const viewer = getPublicKey(key);
  const sign = async (template) => finalizeEvent(template, key);
  const started = now();
  const since = Math.floor(Date.now() / 1000) - 300;
  const result = {
    strategy: strategy.name,
    channels: channels.length,
    reqs: 0,
    events: 0,
    bytes: 0,
    reqMs: [],
    failures: {},
  };
  const requests = new Map(); // wire id → { sent, channels }
  const coverage = new Map(
    strategy.kind === "idle" ? [] : channels.map((id) => [id, "pending"]),
  );
  // Profile and membership REQs share the socket but not channel coverage.
  let lastChannelEose;
  let authId;
  let authAt;
  let canarySent;
  let canaryDone = false;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const complete = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    result.authMs = authAt === undefined ? undefined : authAt - started;
    result.failed = [...coverage.values()].filter(
      (state) => state !== "live",
    ).length;
    if (reason) result.error = reason;
    owner?.dispose();
    socket?.close();
    finish(result);
  };
  const deadline = setTimeout(() => {
    for (const [id, state] of coverage)
      if (state === "pending") coverage.set(id, "timeout");
    complete("timed out");
  }, timeoutMs);
  const covered = () => {
    if (
      authAt !== undefined &&
      canaryDone &&
      [...coverage.values()].every((state) => state !== "pending")
    ) {
      // Coverage means every channel is live; refusals are counted in `failed`.
      if (
        channels.length &&
        [...coverage.values()].every((state) => state === "live")
      )
        result.coverageMs = lastChannelEose - authAt;
      complete();
    }
  };
  let socket;
  let owner;
  const send = (frame) => socket.send(JSON.stringify(frame));
  const sendCanary = () => {
    canarySent = now();
    send(["REQ", CANARY, { kinds: [0], authors: [viewer], limit: 1 }]);
  };
  const burst = () => {
    if (strategy.kind === "filters")
      for (const group of chunk(channels, strategy.size))
        send([
          "REQ",
          `probe-${result.reqs}`,
          ...group.map((id) => channelFilter([id], since)),
        ]);
    if (strategy.kind === "multi-h")
      for (const group of chunk(channels, strategy.size))
        send(["REQ", `probe-${result.reqs}`, channelFilter(group, since)]);
    sendCanary();
  };
  const tap = {
    sent(text) {
      const frame = JSON.parse(text);
      if (frame[0] === "AUTH") authId = frame[1].id;
      // A retired wire's late frames must not change its route's outcome.
      if (frame[0] === "CLOSE") requests.delete(frame[1]);
      if (frame[0] !== "REQ" || frame[1] === CANARY) return;
      result.reqs++;
      const ids = frame
        .slice(2)
        .flatMap((filter) => filter["#h"] ?? [])
        .filter((id) => coverage.has(id));
      for (const id of ids) coverage.set(id, "pending");
      requests.set(frame[1], { sent: now(), channels: ids });
    },
    received(data) {
      result.bytes += data.length;
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        return false;
      }
      if (frame[0] === "OK" && frame[1] === authId && authAt === undefined) {
        if (frame[2] !== true) {
          complete(`auth rejected: ${frame[3]}`);
          return true;
        }
        authAt = now();
        // The client sends its first setups while handling this frame.
        if (strategy.kind === "client") setTimeout(sendCanary, 0);
        return false;
      }
      if (frame[1] === CANARY) {
        if (frame[0] === "EOSE") result.canaryMs = now() - canarySent;
        if (frame[0] === "CLOSED") {
          const reason = `canary: ${String(frame[2] ?? "closed").slice(0, 120)}`;
          result.canaryRefused = reason;
          result.failures[reason] = (result.failures[reason] ?? 0) + 1;
        }
        if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
          canaryDone = true;
          covered();
        }
        return true;
      }
      if (frame[0] === "EVENT") result.events++;
      if (frame[0] === "NOTICE") {
        const reason = `notice: ${String(frame[1]).slice(0, 120)}`;
        result.failures[reason] = (result.failures[reason] ?? 0) + 1;
        return false;
      }
      const request = requests.get(frame[1]);
      if (!request) return false;
      if (frame[0] === "EOSE") {
        requests.delete(frame[1]);
        const at = now();
        result.reqMs.push(at - request.sent);
        if (request.channels.length) lastChannelEose = at;
        for (const id of request.channels) coverage.set(id, "live");
      } else if (frame[0] === "CLOSED") {
        requests.delete(frame[1]);
        const reason = String(frame[2] ?? "closed").slice(0, 120);
        result.failures[reason] = (result.failures[reason] ?? 0) + 1;
        // The app's subscriber retries quota refusals itself; wait for that.
        const retried =
          strategy.kind === "client" && reason.startsWith("rate-limited:");
        if (!retried)
          for (const id of request.channels) coverage.set(id, "failed");
      } else return false;
      queueMicrotask(covered);
      return false;
    },
  };
  const connect = (target) => {
    socket = tapSocket(socketFactory(target), tap);
    return socket;
  };
  if (strategy.kind === "client") {
    owner = subscribeRelayTraffic(
      url,
      sign,
      viewer,
      {
        receive() {},
        // The subscriber gives up on some routes without a frame on the wire
        // (retries exhausted, over capacity).
        state({ routes }) {
          let changed = false;
          for (const route of routes)
            if (
              (route.status === "error" || route.status === "limited") &&
              coverage.get(route.channelId) === "pending"
            ) {
              coverage.set(route.channelId, "failed");
              changed = true;
            }
          if (changed) queueMicrotask(covered);
        },
        established() {},
        denied() {},
      },
      connect,
      undefined,
      strategy.size === Number.POSITIVE_INFINITY ? 1024 : strategy.size,
    );
    owner.update(channels);
  } else {
    connect(url);
    socket.onmessage = async ({ data }) => {
      const frame = JSON.parse(data);
      if (frame[0] === "AUTH") {
        const auth = await sign({
          kind: 22242,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", url],
            ["challenge", frame[1]],
          ],
        });
        send(["AUTH", auth]);
      } else if (frame[0] === "OK" && frame[1] === authId && frame[2] === true)
        burst();
    };
    socket.onclose = () => complete("socket closed");
  }
  return done;
}

/** Channel IDs the key is a member of, from relay-signed roster events. */
export async function discoverRoster({
  url,
  key,
  socketFactory = (target) => new WebSocket(target),
}) {
  const viewer = getPublicKey(key);
  const socket = socketFactory(url);
  const channels = new Set();
  return await new Promise((resolve, reject) => {
    const fail = (message) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Roster read timed out"), 15000);
    socket.onmessage = async ({ data }) => {
      const frame = JSON.parse(data);
      if (frame[0] === "AUTH") {
        socket.send(
          JSON.stringify([
            "AUTH",
            finalizeEvent(
              {
                kind: 22242,
                content: "",
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                  ["relay", url],
                  ["challenge", frame[1]],
                ],
              },
              key,
            ),
          ]),
        );
      } else if (frame[0] === "OK" && frame[2] !== true)
        fail(`Roster auth rejected: ${frame[3]}`);
      else if (frame[0] === "OK")
        socket.send(
          JSON.stringify([
            "REQ",
            "roster",
            { kinds: [39002], "#p": [viewer], limit: ROSTER_LIMIT },
          ]),
        );
      else if (frame[0] === "EVENT" && frame[1] === "roster") {
        const id = frame[2].tags.find(([name]) => name === "d")?.[1];
        if (id) channels.add(id);
      } else if (frame[0] === "CLOSED" && frame[1] === "roster")
        // A refused read may already have sent part of the roster.
        fail(`Roster read refused: ${frame[2]}`);
      else if (frame[0] === "EOSE" && frame[1] === "roster") {
        // Measuring a truncated roster would time the wrong channels.
        if (channels.size >= ROSTER_LIMIT)
          return fail(
            `Roster read returned ${channels.size} channels and may be truncated; pass --channels for a complete list.`,
          );
        clearTimeout(timer);
        socket.close();
        resolve([...channels].sort());
      }
    };
    socket.onerror = () => fail("Roster socket failed");
  });
}

function sumCounts(counts) {
  const total = {};
  for (const entry of counts)
    for (const [key, value] of Object.entries(entry))
      total[key] = (total[key] ?? 0) + value;
  return total;
}

/** Median per strategy over `runs`, rotating the order so no strategy always goes first. */
export async function probe({
  strategies,
  runs = 3,
  // The relay's REQ quota refills over seconds; a short pause lets one run's
  // refusals leak into the next.
  pauseMs = 10000,
  ...options
}) {
  const results = [];
  for (let run = 0; run < runs; run++) {
    const order = strategies.map(
      (_, i) => strategies[(i + run) % strategies.length],
    );
    for (const strategy of order) {
      results.push({ run, ...(await runStrategy({ ...options, strategy })) });
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
  const summary = strategies.map(({ name }) => {
    const mine = results.filter((result) => result.strategy === name);
    // A median over only the runs that finished would favour the slowest
    // strategy, whose slow runs are the ones that time out or are refused.
    const incomplete = mine.filter(
      (result) => result.error || result.failed,
    ).length;
    const canaryRefused = mine.filter((result) => result.canaryRefused).length;
    return {
      strategy: name,
      runs: mine.length,
      incomplete,
      channels: mine[0]?.channels,
      reqs: median(mine.map((result) => result.reqs)),
      authMs: median(mine.map((result) => result.authMs)),
      coverageMs: incomplete
        ? undefined
        : median(mine.map((result) => result.coverageMs)),
      reqP50Ms: median(mine.map((result) => percentile(result.reqMs, 50))),
      reqP90Ms: median(mine.map((result) => percentile(result.reqMs, 90))),
      canaryMs: canaryRefused
        ? undefined
        : median(mine.map((result) => result.canaryMs)),
      canaryRefused,
      events: median(mine.map((result) => result.events)),
      kb: median(mine.map((result) => result.bytes / 1024)),
      failed: Math.max(...mine.map((result) => result.failed)),
      failures: sumCounts(mine.map((result) => result.failures)),
    };
  });
  return { summary, results };
}

function parseKey(value) {
  if (!value)
    throw new Error(
      "Set BUZZ_PRIVATE_KEY (nsec or hex) for the probe identity.",
    );
  if (value.startsWith("nsec1")) return nip19.decode(value).data;
  if (/^[0-9a-f]{64}$/i.test(value))
    return Uint8Array.from(Buffer.from(value, "hex"));
  throw new Error("BUZZ_PRIVATE_KEY must be an nsec or 64-character hex key.");
}
function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
async function main(args) {
  if (args.includes("--help")) {
    console.log(`Usage: pnpm probe:live [--relay wss://…] [--channels id,…|@file] [--limit N]
       [--strategies idle,client:1,client:${SETUP_CONCURRENCY},client:16,client:all,filters:10,multi-h:all]
       [--runs 3] [--pause 10000] [--timeout 30000] [--json out.json]
Identity: BUZZ_PRIVATE_KEY (nsec or hex). Relay: --relay or BUZZ_RELAY_URL.
Without --channels, probes every channel the identity is a member of.`);
    return;
  }
  const key = parseKey(process.env.BUZZ_PRIVATE_KEY);
  const url = (option(args, "relay", process.env.BUZZ_RELAY_URL) ?? "").replace(
    /^http/,
    "ws",
  );
  if (!/^wss?:\/\//.test(url))
    throw new Error("Set --relay or BUZZ_RELAY_URL.");
  const strategies = option(
    args,
    "strategies",
    `idle,client:1,client:${SETUP_CONCURRENCY},client:16,client:all,filters:10,multi-h:all`,
  )
    .split(",")
    .map(parseStrategy);
  setLogLevel("warn"); // The subscriber's lifecycle logs would interleave with results.
  const listed = option(args, "channels");
  let channels = listed
    ? (listed.startsWith("@")
        ? await readFile(listed.slice(1), "utf8")
        : listed
      )
        .split(/[\s,]+/)
        .filter(Boolean)
    : await discoverRoster({ url, key });
  const limit = option(args, "limit");
  if (limit) channels = channels.slice(0, Number(limit));
  console.error(`Probing ${channels.length} channels on ${new URL(url).host}…`);
  const report = await probe({
    url,
    key,
    channels,
    strategies,
    runs: Number(option(args, "runs", "3")),
    pauseMs: Number(option(args, "pause", "10000")),
    timeoutMs: Number(option(args, "timeout", "30000")),
  });
  const round = (value) => (value === undefined ? "–" : Math.round(value));
  console.table(
    report.summary.map((row) => ({
      strategy: row.strategy,
      reqs: row.reqs,
      "auth ms": round(row.authMs),
      "coverage ms": round(row.coverageMs),
      incomplete: row.incomplete,
      "req p50": round(row.reqP50Ms),
      "req p90": round(row.reqP90Ms),
      "canary ms": round(row.canaryMs),
      "canary refused": row.canaryRefused,
      events: row.events,
      KB: round(row.kb),
      failed: row.failed,
    })),
  );
  for (const row of report.summary)
    if (Object.keys(row.failures).length)
      console.error(`${row.strategy} failures:`, row.failures);
  const output = option(args, "json");
  if (output) {
    await writeFile(
      output,
      JSON.stringify(
        { relay: new URL(url).host, at: new Date().toISOString(), ...report },
        null,
        2,
      ),
    );
  }
}
if (import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
