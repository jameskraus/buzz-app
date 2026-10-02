import { createServer } from "vite";
import react from "../../../scripts/react-plugin.ts";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  identities,
  viewer,
  relayAuthor,
  sign,
  profiles,
  records,
  library,
  publicData,
  oldSessionMessage,
} from "./data.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const streams = new Map();
const send = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const emit = (kind, data) => {
  for (const s of streams.values()) {
    const channelId = data.tags?.find((t) => t[0] === "h")?.[1];
    const live = kind === "message" && channelId;
    s.res.write(
      `event: ${live ? "traffic" : kind}\ndata: ${JSON.stringify(live ? { event: data, provenance: { phase: "live", channelId }, interestRevision: s.revision } : data)}\n\n`,
    );
  }
};
const query = (f) => {
  let all = [...records, ...profiles()];
  if (!f.ids && !f["#e"] && !f.until)
    all = all.filter((e) => e.id !== oldSessionMessage.id);
  if (f.kinds?.includes(20001))
    return (f.authors ?? []).map((p) => sign(20001, [["p", p]], "online"));
  if (f.depth_limit)
    all = all.filter((e) =>
      e.tags.some((t) => t[0] === "e" && t[1] === f["#e"]?.[0]),
    );
  let result = all.filter(
    (e) =>
      (!f.kinds || f.kinds.includes(e.kind)) &&
      (!f.ids || f.ids.includes(e.id)) &&
      (!f.authors || f.authors.includes(e.pubkey)) &&
      Object.entries(f)
        .filter(([k]) => k.startsWith("#"))
        .every(([k, v]) =>
          e.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1])),
        ) &&
      (!f.search || e.content.toLowerCase().includes(f.search.toLowerCase())) &&
      (f.until === undefined ||
        e.created_at < f.until ||
        (e.created_at === f.until && e.id > f.before_id)) &&
      (!f.top_level ||
        !e.tags.some((t) => t[0] === "e" && ["reply", "root"].includes(t[3]))),
  );
  if (f.depth_limit)
    result = result
      .filter(
        (e) =>
          f.thread_cursor === undefined ||
          e.created_at > f.thread_cursor ||
          (e.created_at === f.thread_cursor && e.id > f.thread_cursor_id),
      )
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  else
    result.sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
    );
  const more = result.length > (f.limit ?? 1000);
  result = result.slice(0, f.limit ?? 1000);
  if (f.include_aux) {
    const ids = new Set(result.map((e) => e.id));
    result.push(
      ...records.filter(
        (e) =>
          e.kind === 39005 && e.tags.some((t) => t[0] === "e" && ids.has(t[1])),
      ),
    );
    const last = result.at(-1);
    result.push(
      sign(
        39006,
        [
          ["h", f["#h"]?.[0] ?? ""],
          ["d", `${f["#h"]?.[0]}:${f.until ?? "head"}`],
        ],
        JSON.stringify({
          has_more: more,
          next_cursor: more
            ? { created_at: last.created_at, id: last.id }
            : null,
        }),
      ),
    );
  }
  return result;
};
const control = () => ({
  runtimeAvailable: false,
  importAvailable: false,
  runtimeMessage:
    "Isolated demo: native host data modeled; execution disabled.",
  agents: ["mine", "mine2", "theirs", "theirs2", "tail1", "tail2"].map((id) => {
    const i = identities[id];
    return {
      id,
      pubkey: i.pubkey,
      name: i.name,
      relayUrl: "https://names.demo.invalid",
      systemPrompt: "Synthetic naming demo. No execution.",
      workspace: "/demo/no-execution",
      harness: { command: "demo-disabled", args: [], environmentKeys: [] },
      revision: 1,
      runningRevision: null,
      enabled: false,
      status: "stopped",
      error: null,
      diagnostics: [],
    };
  }),
});
const server = await createServer({
  root,
  configFile: false,
  envFile: false,
  cacheDir: `${root}node_modules/.vite-names-demo`,
  logLevel: "warn",
  plugins: [
    react(),
    {
      name: "isolated-naming-demo",
      transform(code, id) {
        if (id === `${root}src/features/agents/control-native.ts`)
          return `export { createNativeAgentControl } from ${JSON.stringify(`${root}tests/demos/identity-names/native-host.ts`)};`;
        if (id === `${root}src/main.tsx`)
          return code.replace(
            "const services = createServices();",
            "const services = createServices(); Object.assign(window, { namingDemoServices: services });",
          );
      },
      transformIndexHtml(html) {
        return html.replace(
          "<head>",
          `<head><script>localStorage.setItem('buzz-client.v1:${viewer}',JSON.stringify({profile:{name:'Alex (synthetic demo)',picture:''},memberships:[{id:'https://names.demo.invalid',name:'Naming conflict demo'}],selected:'https://names.demo.invalid'}));localStorage.setItem('buzz-remember-mentioned-agents.v1','off');</script>`,
        );
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (
            !req.url.startsWith("/api/relay/") &&
            !req.url.startsWith("/demo/")
          )
            return next();
          try {
            let raw = "";
            for await (const part of req) raw += part;
            const body = raw ? JSON.parse(raw) : {};
            const route = req.url.split("?")[0].split("/").at(-1);
            if (req.url === "/demo/data") return send(res, publicData());
            if (req.url === "/demo/control") return send(res, control());
            if (req.url === "/demo/typing") {
              const e = sign(
                20002,
                [["h", body.channel ?? "surfaces"]],
                "",
                identities[body.identity ?? "theirs"].key,
              );
              emit("message", e);
              return send(res, { id: e.id });
            }
            if (req.url === "/demo/activity") {
              for (const s of streams.values()) {
                if (s.observer == null) continue;
                for (const id of ["mine", "theirs"])
                  s.res.write(
                    `event: observer\ndata: ${JSON.stringify({ generation: s.observer, frame: { id: randomBytes(32).toString("hex"), agent: identities[id].pubkey, createdAt: Math.floor(Date.now() / 1000), plaintext: JSON.stringify({ kind: "turn_liveness", seq: 1, timestamp: new Date().toISOString(), channelId: "surfaces", sessionId: "demo", turnId: id }) } })}\n\n`,
                  );
              }
              return send(res, {});
            }
            if (req.url === "/demo/message") {
              const e = sign(
                9,
                [
                  ["h", body.channel ?? "surfaces"],
                  ...(body.mention ? [["p", viewer]] : []),
                  ...(body.thread
                    ? [
                        ["e", body.thread, "", "root"],
                        ["e", body.thread, "", "reply"],
                      ]
                    : []),
                ],
                body.text ?? "Conflict demo live message",
                identities[body.identity ?? "theirs"].key,
              );
              records.push(e);
              emit("message", e);
              return send(res, e);
            }
            if (route === "media") {
              res.writeHead(200, { "Content-Type": "image/svg+xml" });
              res.end(
                '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="360"><rect width="800" height="360" fill="#d5f1ef"/><text x="55" y="170" font-size="36" fill="#123">Naming conflict demo</text><text x="55" y="225" font-size="24" fill="#123">Real message + synthetic attachment</text></svg>',
              );
              return;
            }
            if (route === "identity") return send(res, { viewer });
            if (route === "register") return send(res, {});
            if (route === "info") return send(res, { policy: null });
            if (route === "gif-info") return send(res, {});
            if (route === "session")
              return send(res, {
                viewer,
                relayAuthor,
                relayUrl: "https://names.demo.invalid",
                writeKinds: [9],
                live: true,
                agentLibrary: true,
                agentActivity: true,
              });
            if (route === "agent-library") return send(res, library);
            if (route === "sign")
              return send(
                res,
                sign(
                  body.kind,
                  body.tags,
                  body.content,
                  identities.viewer.key,
                  body.created_at,
                ),
              );
            if (route === "publish") {
              records.push(body);
              emit("message", body);
              return send(res, { accepted: true, event_id: body.id });
            }
            if (route === "query")
              return send(res, [
                ...new Map(body.flatMap(query).map((e) => [e.id, e])).values(),
              ]);
            if (route === "stream") {
              const id = randomBytes(16).toString("hex");
              res.useChunkedEncodingByDefault = false;
              res.writeHead(200, {
                "X-Buzz-Live-ID": id,
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                Connection: "close",
              });
              res.flushHeaders();
              const s = {
                res,
                channels: body.channels ?? [],
                revision: body.interestRevision,
                observer: body.observer,
                state() {
                  res.write(
                    `event: state\ndata: ${JSON.stringify({ status: "connected", interestRevision: s.revision, routes: s.channels.map((channelId) => ({ id: `channel:${channelId}`, channelId, status: "live", replay: "unknown" })) })}\n\n`,
                  );
                },
              };
              streams.set(id, s);
              s.state();
              const timer = setInterval(
                () => res.write(": keepalive\n\n"),
                15000,
              );
              res.on("close", () => {
                clearInterval(timer);
                streams.delete(id);
              });
              return;
            }
            if (route.startsWith("stream-")) {
              const s = streams.get(body.streamId);
              if (!s) return send(res, { error: "unknown stream" }, 404);
              if (route === "stream-interests") {
                s.channels = body.channels;
                s.revision = body.interestRevision;
                s.state();
              }
              if (route === "stream-observer") s.observer = body.observer;
              return send(res, {});
            }
            throw new Error(`Unexpected demo request ${req.method} ${req.url}`);
          } catch (e) {
            console.error(e);
            send(res, { error: String(e) }, 500);
          }
        });
      },
    },
  ],
  define: {
    "import.meta.env.VITE_BUZZ_LIVE": '"1"',
    "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES": '"{}"',
  },
  server: { host: "127.0.0.1", port: 1435, strictPort: true },
});
await server.listen();
console.log("Isolated full-app naming demo: http://127.0.0.1:1435");
