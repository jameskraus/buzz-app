import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "../../scripts/react-plugin.ts";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

test("channel completion preserves native editing, focus, popup geometry and signed send/reply content", async ({
  page,
}) => {
  // Browser boundary: real editor transactions/undo, portal layout and plugin-to-send wiring.
  // Channel eligibility, ranking and stale-list permutations live in colocated Vitest tests.
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    optimizeDeps: { entries: ["tests/fixtures/mentions.html"] },
    plugins: [react()],
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      open: false,
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?channels&stream&test-controls`,
    );
    const input = page.getByRole("textbox");
    await expect(input).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.mentionFixture.list().status))
      .toBe("ready");
    await expect
      .poll(() => page.evaluate(() => window.mentionFixture.reads().pending))
      .toBe(0);
    const reads = await page.evaluate(
      () => window.mentionFixture.reads().kinds.length,
    );
    const list = page.getByRole("listbox", { name: "Channel suggestions" });
    await input.pressSequentially("#");
    await expect(list.getByRole("option")).toHaveCount(2);
    await expect(input).toBeFocused();
    await expect
      .poll(() =>
        list.evaluate((element) => {
          const popup = element.parentElement;
          return (
            document.querySelector("form").getBoundingClientRect().top -
            popup.getBoundingClientRect().bottom
          );
        }),
      )
      .toBe(4);
    expect(
      await list.evaluate((element) => element.closest("form") === null),
    ).toBe(true);
    await expect(list.locator("..")).toHaveCSS("width", "480px");
    await input.press("ArrowDown");
    await expect(
      list.getByRole("option", { name: "Other Private channel" }),
    ).toHaveAttribute("aria-selected", "true");
    await input.press("Tab");
    await expect(list).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveJSProperty(
      "value",
      "[\\#Other](buzz://channel/other) ",
    );
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveJSProperty("value", "#");
    // Undo restores the replaced query selection. Collapse it before extending.
    await input.press("ArrowRight");
    await input.pressSequentially("Gen");
    await expect(list.getByRole("option")).toHaveCount(1);
    await input.press("Enter");
    await expect(input).toHaveJSProperty(
      "value",
      "[\\#General](buzz://channel/c) ",
    );
    await expect(input.locator("[data-link-renderer]")).toHaveText("#General");
    await expect(input).toBeFocused();
    expect(
      await page.evaluate(() => window.mentionFixture.publications),
    ).toEqual([]);
    expect(
      await page.evaluate(() => window.mentionFixture.reads().kinds.length),
    ).toBe(reads);
    // Stable IDs and source survive draft persistence, not just the mounted input.
    await page.reload();
    await expect(input).toHaveJSProperty(
      "value",
      "[\\#General](buzz://channel/c) ",
    );
    await input.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(1);
    const sent = await page.evaluate(
      () => window.mentionFixture.publications[0],
    );
    expect(sent.content).toBe("[\\#General](buzz://channel/c)");
    expect(sent.tags).toContainEqual(["h", "c"]);
    expect(sent.tags.filter(([name]) => name === "p")).toEqual([]);
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await input.pressSequentially("#Ot");
    await list.getByRole("option", { name: "Other Private channel" }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveJSProperty(
      "value",
      "[\\#Other](buzz://channel/other) ",
    );
    await input.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(2);
    const reply = await page.evaluate(
      () => window.mentionFixture.publications[1],
    );
    expect(reply.content).toBe("[\\#Other](buzz://channel/other)");
    expect(reply.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
    expect(reply.tags.filter(([name]) => name === "p")).toEqual([]);
    // Rich marks and autocomplete share one native transaction owner.
    for (const shortcut of ["ControlOrMeta+b", "ControlOrMeta+i"]) {
      await input.press(shortcut);
      await input.pressSequentially("#Gen");
      await expect(list.getByRole("option")).toHaveCount(1);
      await input.press("Enter");
      await expect(input).toHaveJSProperty(
        "value",
        "[\\#General](buzz://channel/c) ",
      );
      await expect(input.locator("[data-link-renderer]")).toHaveText(
        "#General",
      );
      await input.press(shortcut);
      await input.press("ControlOrMeta+a");
      await input.press("Backspace");
    }
    await input.pressSequentially("PR #1234");
    await expect(input).toHaveJSProperty("value", "PR #1234");
    await expect(list).toHaveCount(0);
    await input.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(3);
    expect(
      await page.evaluate(() => window.mentionFixture.publications[2].content),
    ).toBe("PR #1234");
    await page.setViewportSize({ width: 360, height: 740 });
    await input.pressSequentially("#");
    await expect(list).toBeVisible();
    const bounds = await list.locator("..").boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(740);
    await input.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(input).toHaveJSProperty("value", "#");
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
