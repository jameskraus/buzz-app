import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "./relay-broker.mjs";
import { connectBrokerTransport } from "../src/features/relay/transport.ts";
import {
  deleteAuthorityFilter,
  deleteAuthorityTarget,
  parseDeleteAuthority,
} from "../src/features/relay/channel-delete-authority.ts";
import { fixtureRelayUrl, fixtureAliases } from "../tests/relay-config.ts";

const community = "01234567-89ab-cdef-0123-456789abcdef";
const channel = "11111111-1111-4111-8111-111111111111";
const disposals = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
async function harness(discovered = true) {
  const key = generateSecretKey(),
    viewer = getPublicKey(key);
  let handler, response;
  const calls = [];
  const server = createServer((req, res) => {
    req.headers.origin ??= `http://${req.headers.host}`;
    handler(req, res);
  });
  const envelope = () => ({
    channel_delete_authority: 1,
    community_id: community,
    channel_id: channel,
    pubkey: viewer,
    can_delete: true,
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => key,
    upstreamFetch: async (url, init) => {
      if (!init?.body)
        return Response.json({
          self: viewer,
          ...(discovered
            ? {
                channel_delete_authority: {
                  version: 1,
                  community_id: community,
                },
              }
            : {}),
        });
      const auth = JSON.parse(
        Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
      );
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.pubkey).toBe(viewer);
      expect(auth.tags).toContainEqual(["u", String(url)]);
      expect(auth.tags).toContainEqual(["method", "POST"]);
      expect(auth.tags).toContainEqual([
        "payload",
        createHash("sha256").update(init.body).digest("hex"),
      ]);
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return response instanceof Response
        ? response
        : Response.json(response ?? envelope());
    },
  });
  await plugin.configureServer({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb) {
        handler = cb;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  disposals.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    transport: await connectBrokerTransport(base),
    viewer,
    calls,
    envelope,
    reply(value) {
      response = value;
    },
    async raw(filters) {
      return fetch(`${base}/api/relay/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify(filters),
      });
    },
  };
}
it("carries the authenticated viewer/channel-bound decision through the production broker and transport", async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  expect(await h.transport.readChannelDeleteAuthority(channel, signal)).toBe(
    true,
  );
  h.reply({ ...h.envelope(), can_delete: false });
  expect(await h.transport.readChannelDeleteAuthority(channel, signal)).toBe(
    false,
  );
  expect(h.calls).toHaveLength(2);
  for (const call of h.calls) {
    expect(call.url).toBe(`${fixtureRelayUrl}/query`);
    expect(call.body).toEqual(deleteAuthorityFilter(channel, h.viewer));
  }
});
it("does not invent authority on an unsupported relay", async () => {
  const h = await harness(false);
  expect(h.transport.readChannelDeleteAuthority).toBeUndefined();
  expect((await h.raw(deleteAuthorityFilter(channel, h.viewer))).status).toBe(
    400,
  );
  expect(h.calls).toHaveLength(0);
});
it.each([
  "community_id",
  "pubkey",
  "channel_id",
  "channel_delete_authority",
  "can_delete",
])("rejects a mismatched %s at both decoding boundaries", async (field) => {
  const h = await harness();
  const value = { ...h.envelope(), [field]: "wrong" };
  expect(() =>
    parseDeleteAuthority(value, community, h.viewer, channel),
  ).toThrow("unavailable or mismatched");
  h.reply(value);
  await expect(
    h.transport.readChannelDeleteAuthority(
      channel,
      new AbortController().signal,
    ),
  ).rejects.toThrow("unavailable");
});
it("rejects ordinary arrays, oversized replies and service failures rather than granting or denying", async () => {
  const h = await harness();
  for (const value of [
    [],
    new Response("x".repeat(4097)),
    Response.json({ error: "down" }, { status: 503 }),
  ]) {
    h.reply(value);
    await expect(
      h.transport.readChannelDeleteAuthority(
        channel,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
});
it("rejects malformed or another viewer's query before upstream dispatch", async () => {
  const h = await harness();
  const [filter] = deleteAuthorityFilter(channel, h.viewer);
  for (const value of [
    [{ ...filter, "#p": ["b".repeat(64)] }],
    [{ ...filter, limit: 1 }],
    [{ ...filter, channel_delete_authority: 2 }],
    [filter, filter],
    [{ ...filter, "#h": [channel, channel] }],
  ]) {
    expect(deleteAuthorityTarget(value, h.viewer)).toBeUndefined();
    expect((await h.raw(value)).status).toBe(400);
  }
  expect(h.calls).toHaveLength(0);
});
