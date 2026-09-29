import { expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PagesService } from "./service";

it("validates the primary flag and exposes it on registered pages", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const pages = new PagesService(root);
  const scope = root.extend({
    pluginOwner: { id: "example", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    const base = { id: "main", title: "Main", component: () => null };
    for (const primary of [null, "yes", 1, {}])
      expect(() => ctx.pages.register({ ...base, primary } as never)).toThrow();
    ctx.pages.register({ ...base, id: "listed", primary: true });
    // Omitting the flag keeps a page registered without a navigation row.
    ctx.pages.register({ ...base, id: "vended" });
  });
  await fiber.await();
  expect(pages.snapshot().map((page) => [page.id, page.primary])).toEqual([
    ["listed", true],
    ["vended", undefined],
  ]);
  await fiber.dispose();
  expect(pages.snapshot()).toEqual([]);
  await root.fiber.dispose();
});
