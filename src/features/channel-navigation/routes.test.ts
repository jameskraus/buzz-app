import { expect, it } from "vitest";
import { isChannelRoute, newSessionParent } from "./routes";

it("accepts empty destinations, new-message and explicit parent-only new-session routes", () => {
  expect(isChannelRoute("empty")).toBe(true);
  expect(newSessionParent("empty")).toBeUndefined();
  expect(isChannelRoute("new-message")).toBe(true);
  const params = { kind: "new-session", parentId: "parent" };
  expect(isChannelRoute(params)).toBe(true);
  expect(newSessionParent(params)).toBe("parent");
});
it("rejects missing parents, foreign route kinds and draft payloads", () => {
  for (const params of [
    null,
    [],
    "new-session",
    // Inbox and Bestie are pages of their own, not Channels placeholders.
    "Inbox",
    "Bestie",
    {},
    { kind: "new-session" },
    { kind: "new-session", parentId: " " },
    { kind: "new-session", parentId: 1 },
    { kind: "other", parentId: "parent" },
    { kind: "new-session", parentId: "parent", text: "private draft" },
  ]) {
    expect(isChannelRoute(params)).toBe(false);
    expect(newSessionParent(params)).toBeUndefined();
  }
});
