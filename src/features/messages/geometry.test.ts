import { expect, it } from "vitest";
import { geometryFor, geometrySignature } from "./geometry";
import { createRelaySession } from "../relay/session";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";

it("invalidates geometry for changed content, profiles, width, session, and cache eviction", () => {
  const first = createRelaySession(null),
    second = createRelaySession(null);
  const a = geometryFor(first.session.channels),
    b = geometryFor(second.session.channels);
  const cache = [[100, 200], 150] as unknown as Parameters<typeof a.set>[3];
  a.set("a", "v1", 900, cache);
  expect(a.get("a", "v1", 900)).toBe(cache);
  expect(a.get("a", "v2", 900)).toBeUndefined();
  expect(a.get("a", "v1", 901)).toBeUndefined();
  expect(b.get("a", "v1", 900)).toBeUndefined();
  for (const id of ["b", "c", "d", "e", "f", "g", "h"])
    a.set(id, "v1", 900, cache);
  expect(a.get("a", "v1", 900)).toBe(cache);
  // Revisiting refreshes the saved measurements; the ninth view drops the oldest.
  a.set("a", "v1", 900, cache);
  a.set("i", "v1", 900, cache);
  expect(a.get("b", "v1", 900)).toBeUndefined();
  expect(a.get("c", "v1", 900)).toBe(cache);
  expect(a.get("a", "v1", 900)).toBe(cache);
  const oversized = "x".repeat(256 * 1024 + 1);
  a.set("a", oversized, 900, cache);
  expect(a.get("a", oversized, 900)).toBeUndefined();
  expect(a.get("a", "v1", 900)).toBeUndefined();
  const author = keypair();
  const rows = foldMessages("a", "relay", [message(author, "a", "hello", 20)]);
  expect(geometrySignature(rows, new Map())).not.toBe(
    geometrySignature(rows, new Map([[author.pubkey, { name: "Author" }]])),
  );
  const edited = rows.map((row) => ({ ...row, content: "edited" }));
  expect(geometrySignature(rows, new Map())).not.toBe(
    geometrySignature(edited, new Map()),
  );
  first.dispose();
  second.dispose();
});

it("invalidates row geometry when resolved author or mention labels change", () => {
  const author = keypair();
  const rows = foldMessages("a", "relay", [
    message(author, "a", "hello", 20),
  ]).map((row) => ({ ...row, mentions: ["mentioned"] }));
  const names = new Map([
    [author.pubkey, "Author"],
    ["mentioned", "Mention"],
  ]);
  const resolve = (id: string, fallback: string) => names.get(id) ?? fallback;
  const original = geometrySignature(rows, new Map(), resolve);
  names.set("mentioned", "Longer mention");
  const renamedMention = geometrySignature(rows, new Map(), resolve);
  expect(renamedMention).not.toBe(original);
  names.set(author.pubkey, "Longer author");
  expect(geometrySignature(rows, new Map(), resolve)).not.toBe(renamedMention);
});
