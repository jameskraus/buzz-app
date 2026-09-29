// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { recordReaction } from "../messages/quick-reactions";
import { readView, writeView } from "../../shared/view-state";
import { purgeCommunityDeviceState } from "./device-state";

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const origin = "https://left.example";
const kept = "https://kept.example";
const receipt = (scope: string) => `buzz-channel-setup.v2:${scope}:general`;
const reactions = (scope: string) => `buzz.quick-reactions.v1:${scope}`;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("forgets every store partitioned to the left community and viewer, and nothing else", async () => {
  const scope = `${origin}:${viewer}`;
  writeView(scope, "draft:general", "unsent");
  writeView(scope, "channel", "general");
  writeView(`${kept}:${viewer}`, "draft:general", "another community");
  writeView(`${origin}:${other}`, "draft:general", "another viewer");
  // A scope that merely extends the left one is a different partition.
  writeView(`${scope}0`, "draft:general", "longer viewer");
  recordReaction(scope, "🎉");
  recordReaction(`${kept}:${viewer}`, "🎉");
  localStorage.setItem(receipt(scope), "1");
  localStorage.setItem(receipt(`${kept}:${viewer}`), "1");
  expect(await purgeCommunityDeviceState(origin, viewer)).toEqual([]);
  expect(readView(scope, "draft:general", "")).toBe("");
  expect(readView(scope, "channel", "")).toBe("");
  expect(readView(`${kept}:${viewer}`, "draft:general", "")).toBe(
    "another community",
  );
  expect(readView(`${origin}:${other}`, "draft:general", "")).toBe(
    "another viewer",
  );
  expect(readView(`${scope}0`, "draft:general", "")).toBe("longer viewer");
  expect(localStorage.getItem(reactions(scope))).toBeNull();
  expect(localStorage.getItem(reactions(`${kept}:${viewer}`))).not.toBeNull();
  expect(localStorage.getItem(receipt(scope))).toBeNull();
  expect(localStorage.getItem(receipt(`${kept}:${viewer}`))).toBe("1");
});

it("clears the remaining stores when one is unavailable and reports each failure", async () => {
  const scope = `${origin}:${viewer}`;
  writeView(scope, "draft:general", "unsent");
  recordReaction(scope, "🎉");
  // Key enumeration fails, which the view and channel-setup sweeps rely on.
  vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
    throw new Error("denied");
  });
  const failures = await purgeCommunityDeviceState(origin, viewer);
  expect(failures).toHaveLength(2);
  expect(localStorage.getItem(reactions(scope))).toBeNull();
});
