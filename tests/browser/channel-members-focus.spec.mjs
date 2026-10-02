import { expect, test } from "@playwright/test";
import { preview } from "vite";
import { build } from "vite";
import react from "../../scripts/react-plugin.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

// Immutable build/server per worker; each test owns its page and fixture state.
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-focus-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/channel-members-focus.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/channel-members-focus.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.copiedNpubs = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => window.copiedNpubs.push(value),
      },
    });
  });
});

// A real mounted member dialog and shared session, but no relay or external write.
test("identity menus preserve modal focus and addition returns focus only to its owner", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  for (const moved of [false, true]) {
    await page.goto(url);
    await page.getByRole("button", { name: "Channel members" }).click();
    const dialog = page.getByRole("dialog", { name: "Channel members" });
    const search = dialog.getByRole("searchbox");
    await search.fill("Morgan");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    await expect(add).toBeEnabled();
    const identity = dialog.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    if (!moved) {
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((a) => a.finished),
        );
      });
      await expect(add).not.toBeFocused();
      const before = await add.boundingBox();
      await identity.hover({ position: { x: 20, y: 20 } });
      const row = add.locator("../..");
      const key = row.locator('[aria-hidden="true"].text-mono');
      await expect(key).toHaveText(/^npub1.{6}….{6}$/);
      const actions = dialog.getByRole("button", {
        name: "Actions for Morgan",
        exact: true,
      });
      await expect(actions).toHaveCount(0);
      expect(await add.boundingBox()).toEqual(before);
      await identity.click({ button: "right" });
      const menu = page.getByRole("menu", {
        name: "Actions for Morgan",
        exact: true,
      });
      await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
      await opened(menu);
      await page.keyboard.press("Escape");
      await expect(identity).toBeFocused();
      await expect(dialog).toBeVisible();
      await expect(add).toBeEnabled();
      await page.mouse.move(0, 0);
      await search.focus();
      await page.keyboard.press("Tab");
      await expect(
        dialog.getByRole("button", { name: "Clear search people and agents" }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(identity).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(add).toBeFocused();
      await page.keyboard.press("Shift+F10");
      await opened(menu);
      await expect(menu).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        menu.getByRole("menuitem", { name: "View profile", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();
      await expect(
        page.getByRole("dialog", { name: "Morgan identity", exact: true }),
      ).toHaveCount(0);
    }
    await add.focus();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.focusFixture.published);
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    if (moved)
      await dialog
        .getByRole("button", { name: "Close channel members" })
        .focus();
    await page.evaluate(() => window.focusFixture.confirm());
    await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
    await expect(
      moved
        ? dialog.getByRole("button", { name: "Close channel members" })
        : search,
    ).toBeFocused();
  }
  await page.goto(url);
  await page.getByRole("button", { name: "Edit team", exact: true }).click();
  const team = page.getByRole("dialog", { name: "Team", exact: true });
  const checkbox = team.getByRole("checkbox", { name: /Morgan/ });
  const card = page.getByRole("dialog", {
    name: "Morgan identity",
    exact: true,
  });
  // No prior checkbox focus: the wrapper itself cannot receive focus.
  await expect(checkbox).not.toBeFocused();
  await checkbox.hover();
  await expect(card).toBeVisible();
  const copy = card.getByRole("button", { name: "Copy npub", exact: true });
  await copy.click();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();
  await expect(team).toBeVisible();
  await expect(checkbox).toBeFocused();
  await expect(checkbox).not.toBeChecked();
  await page.mouse.move(0, 0);
  await team.getByRole("textbox").focus();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.className = mode;
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await checkbox.hover();
      await expect(card).toBeVisible();
      await expect(card).toContainText("Owner unavailable");
      await card.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((a) => a.finished));
      });
      const bounds = await card.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`identity-${mode}-${width}.png`),
      });
      await page.mouse.move(0, 0);
      await team.getByRole("textbox").focus();
      await expect(card).not.toBeVisible();
    }
  }
  await team.getByRole("textbox").focus();
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
  try {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Copy npub" })).toBeFocused();
  } finally {
    await page.clock.resume();
  }
  await expect(checkbox).toHaveAccessibleDescription(/Tab to reach Copy npub/);
  await expect(checkbox).toHaveAttribute(
    "aria-details",
    await card.getAttribute("id"),
  );
  await expect(checkbox).not.toHaveAttribute("aria-haspopup");
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  expect(errors).toEqual([]);
});

// Real hit testing cannot be checked in jsdom. Hover the identity, then
// move straight to the visible Add label without locator retries.
test("longer inline keys leave multiword candidate Add actions clickable", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  for (const width of [390, 800, 1280]) {
    for (const index of [1, 3]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}?multiple`);
      await page
        .getByRole("button", { name: "Channel members", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Channel members",
        exact: true,
      });
      await dialog.getByRole("searchbox").fill("Morgan");
      await expect(
        dialog.getByRole("button", { name: /Add Morgan Field Tester/ }),
      ).toHaveCount(3);
      const name = `Morgan Field Tester ${index}`;
      const add = dialog.getByRole("button", {
        name: new RegExp(`Add ${name} `),
      });
      await expect(add).toBeEnabled();
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((a) => a.finished),
        );
      });
      const identity = dialog.getByRole("button", {
        name: new RegExp(`Open profile for ${name} `),
      });
      await identity.hover({ position: { x: 20, y: 20 } });
      const key = add
        .locator("../..")
        .locator('[aria-hidden="true"].text-mono');
      await expect(key).toBeVisible();
      await expect(key).toHaveText(/^npub1.{6}….{6}$/);
      const keyBounds = await key.boundingBox();
      const addBounds = await add.boundingBox();
      expect(keyBounds.x + keyBounds.width).toBeLessThanOrEqual(addBounds.x);
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      const bounds = await add.getByText("Add", { exact: true }).boundingBox();
      const point = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
      await page.mouse.move(point.x, point.y, { steps: 8 });
      expect(
        await add.evaluate(
          (element, { x, y }) =>
            element.contains(document.elementFromPoint(x, y)),
          point,
        ),
      ).toBe(true);
      await page.mouse.click(point.x, point.y);
      await expect
        .poll(() => page.evaluate(() => window.focusFixture.additions.length))
        .toBe(1);
      await page.evaluate(() => window.focusFixture.confirm());
      await expect(
        dialog.getByText(`${name} is in the channel.`, { exact: true }),
      ).toBeVisible();
    }
  }
  expect(errors).toEqual([]);
});

// Browser-only: scrolling moves real rows under a still pointer, and the wheel
// is hit tested through the top layer.
test("scrolling dismisses a hovered identity preview and keeps the wheel", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  const { card, name, offset } = await scrollableTeam(page);
  const pitch =
    (await name(2).boundingBox()).y - (await name(1).boundingBox()).y;

  await name(3).hover();
  await opened(card(3));
  // The document capture listener must ignore scrolling outside the trigger's
  // ancestry. Wait for the real scroll event and its rendering update first.
  await page.evaluate(async () => {
    const unrelated = document.createElement("div");
    unrelated.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;overflow:auto;scrollbar-width:none;pointer-events:none";
    const content = document.createElement("div");
    content.style.height = "2px";
    unrelated.append(content);
    document.body.append(unrelated);
    try {
      await new Promise((resolve) => {
        unrelated.addEventListener(
          "scroll",
          () => requestAnimationFrame(resolve),
          {
            once: true,
          },
        );
        unrelated.scrollTop = 1;
      });
    } finally {
      unrelated.remove();
    }
  });
  await expect(card(3)).toHaveAttribute("data-open", "");
  // The pointer stays on the same row, so only the scroll can dismiss. While
  // it exits, the preview still follows its row and must not be hit tested.
  const nudge = 4;
  const dismissed = await card(3).evaluateHandle((popup) => ({
    pointerEvents: new Promise((resolve) =>
      new MutationObserver(
        () =>
          popup.hasAttribute("data-open") ||
          resolve(getComputedStyle(popup).pointerEvents),
      ).observe(popup, { attributes: true }),
    ),
  }));
  await page.mouse.wheel(0, nudge);
  expect(await dismissed.evaluate(({ pointerEvents }) => pointerEvents)).toBe(
    "none",
  );
  await page.mouse.wheel(0, pitch - nudge);
  await expect.poll(offset).toBe(pitch);
  await expect(card(3)).toHaveCount(0);
  // Rows now travel toward where each preview sat above its row. A preview
  // that stayed would slide under the pointer and take the wheel.
  await page.mouse.wheel(0, pitch);
  await expect.poll(offset).toBe(2 * pitch);
  for (const step of [1, 0]) {
    await page.mouse.wheel(0, -pitch);
    await expect.poll(offset).toBe(step * pitch);
  }
  await page.mouse.move(0, 0);
  await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Browser-only: focusing a clipped row really scrolls it into view.
test("a keyboard-focused identity preview survives the scroll that reveals its row", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  const { team, card, list, offset } = await scrollableTeam(page);
  const row = (index) =>
    team.getByRole("checkbox", { name: new RegExp(`^Agent ${index} `) });
  await team.getByRole("textbox").focus();
  let revealed = 0;
  for (let index = 1; index <= 7; index++) {
    const before = await offset();
    const scrolled = await list.evaluateHandle((element) => ({
      event: new Promise((resolve) =>
        element.addEventListener("scroll", () => resolve(), { once: true }),
      ),
    }));
    await page.keyboard.press("Tab");
    await expect(row(index)).toBeFocused();
    if ((await offset()) !== before) {
      // The preview has seen this scroll before Tab asks it for its action.
      await scrolled.evaluate(({ event }) => event);
      revealed++;
    }
    await page.keyboard.press("Tab");
    await expect(
      card(index).getByRole("button", { name: "Copy npub", exact: true }),
    ).toBeFocused();
  }
  expect(revealed).toBeGreaterThan(0);

  // Scrolled away from its focused row, the preview stays open but hidden,
  // and Tab continues down the list instead of entering it.
  await page.keyboard.press("Shift+Tab");
  await expect(row(7)).toBeFocused();
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  const preview = page.locator('[data-open][aria-label="Agent 7 identity"]');
  await expect(preview).toBeHidden();
  await expect(preview).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(row(8)).toBeFocused();
  expect(errors).toEqual([]);
});

async function scrollableTeam(page) {
  await page.goto(`${url}?team`);
  await page.getByRole("button", { name: "Edit team", exact: true }).click();
  const team = page.getByRole("dialog", { name: "Team", exact: true });
  await expect(team.getByRole("checkbox")).toHaveCount(12);
  await team.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((a) => a.finished),
    );
  });
  const name = (index) => team.getByText(`Agent ${index}`, { exact: true });
  const list = await name(1).evaluateHandle((element) => {
    let scroller = element.parentElement;
    while (getComputedStyle(scroller).overflowY !== "auto")
      scroller = scroller.parentElement;
    return scroller;
  });
  return {
    team,
    name,
    list,
    card: (index) =>
      page.getByRole("dialog", {
        name: `Agent ${index} identity`,
        exact: true,
      }),
    offset: () => list.evaluate((element) => element.scrollTop),
  };
}

async function opened(popup) {
  await expect(popup).toHaveAttribute("data-open", "");
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await expect
    .poll(() => popup.evaluate((element) => element.getAnimations().length))
    .toBe(0);
}

// Pause at the actual exit boundary, not a runner-speed-dependent sleep.
async function holdPreviewExit(page) {
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const { target } of records)
        if (
          target instanceof HTMLElement &&
          target.matches(".buzz-preview-card[data-ending-style]")
        )
          for (const animation of target.getAnimations()) animation.pause();
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ending-style"],
      subtree: true,
    });
  });
  return {
    held: (popup) =>
      expect
        .poll(() =>
          popup.evaluate((element) =>
            element.getAnimations().some((a) => a.playState === "paused"),
          ),
        )
        .toBe(true),
    release: () =>
      page.evaluate(() => {
        for (const animation of document.getAnimations())
          if (animation.playState === "paused") animation.finish();
      }),
  };
}

test("Escape returns focus only while the closing identity preview still owns it", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  for (const move of ["none", "search", "tab"]) {
    await page.goto(url);
    await page.getByRole("button", { name: "Edit team", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Team", exact: true });
    const search = dialog.getByRole("textbox");
    const identity = dialog.getByRole("checkbox", { name: /Morgan/ });
    await identity.hover();
    const card = page.getByRole("dialog", {
      name: "Morgan identity",
      exact: true,
    });
    await opened(card);
    const copy = card.getByRole("button", { name: "Copy npub", exact: true });
    await copy.click();
    await expect(copy).toBeFocused();
    const exit = await holdPreviewExit(page);
    const next = dialog.getByRole("button", { name: "Close", exact: true });
    try {
      await page.keyboard.press("Escape");
      await exit.held(card);
      if (move === "search") {
        // The still-visible preview may overlap the left of the search field.
        // Click its exposed right edge, as a user can during the exit.
        const bounds = await search.boundingBox();
        await search.click({
          position: { x: bounds.width - 24, y: bounds.height / 2 },
        });
        await expect(search).toBeFocused();
      } else if (move === "tab") {
        await identity.focus();
        await page.keyboard.press("Tab");
        await expect(next).toBeFocused();
      }
      await expect(card).toHaveCount(1);
    } finally {
      await exit.release();
    }
    await expect(card).toHaveCount(0);
    await expect(
      move === "search" ? search : move === "tab" ? next : identity,
    ).toBeFocused();
    await expect(dialog).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("inline member identity geometry and separate addition focus", async ({
  page,
}) => {
  for (const moved of [false, true]) {
    await page.emulateMedia({
      reducedMotion: moved ? "reduce" : "no-preference",
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Channel members" }).click();
    const dialog = page.getByRole("dialog", { name: "Channel members" });
    const search = dialog.getByRole("searchbox");
    const memberRow = dialog.getByRole("listitem").first();
    await expect(memberRow).toHaveCSS("min-height", "48px");
    expect((await memberRow.boundingBox()).height).toBe(48);
    // All identities center at rest and reveal the key beneath the name.
    // Browser layout/focus—not jsdom—owns these geometry assertions.
    const memberKey = memberRow.locator('[aria-hidden="true"].text-mono');
    const memberName = memberRow.getByText("Carl (you)", { exact: true });
    const memberAvatar = memberRow.locator("[data-avatar-shape]");
    const memberMetadata = memberKey.locator("../..");
    await search.hover();
    await expect(memberKey).toBeHidden();
    await expect(memberMetadata).toHaveCSS("height", "0px");
    const nameBoundsBeforeReveal = await memberName.boundingBox();
    const rowBoundsBeforeReveal = await memberRow.boundingBox();
    const avatarBoundsBeforeReveal = await memberAvatar.boundingBox();
    expect(
      nameBoundsBeforeReveal.y + nameBoundsBeforeReveal.height / 2,
    ).toBeCloseTo(
      avatarBoundsBeforeReveal.y + avatarBoundsBeforeReveal.height / 2,
      0,
    );
    await memberRow.hover();
    await expect(memberKey).toBeVisible();
    await expect(memberMetadata).toHaveAttribute("style", /height: auto/);
    await expect(memberMetadata).toHaveCSS("margin-top", "2px");
    expect((await memberName.boundingBox()).y).toBeLessThan(
      nameBoundsBeforeReveal.y,
    );
    expect(await memberRow.boundingBox()).toEqual(rowBoundsBeforeReveal);
    expect(await memberAvatar.boundingBox()).toEqual(avatarBoundsBeforeReveal);
    await search.hover();
    await expect(memberMetadata).toHaveCSS("height", "0px");
    await memberRow
      .getByRole("button", { name: /Open profile for Carl/ })
      .focus();
    await expect(memberKey).toBeVisible();
    expect(await memberRow.boundingBox()).toEqual(rowBoundsBeforeReveal);
    await search.fill("Morgan");
    const add = dialog.getByRole("button", { name: /Add Morgan/ });
    await expect(add).toBeEnabled();
    const header = await dialog.locator(".buzz-dialog-header").boundingBox();
    const field = await search.locator("..").boundingBox();
    expect(field.y - header.y - header.height).toBeCloseTo(16, 0);
    await expect(add).toHaveCSS("font-size", "12px");
    expect((await add.boundingBox()).height).toBe(24);
    const members = dialog.getByRole("region", {
      name: "Members",
      exact: true,
    });
    const others = dialog.getByRole("region", {
      name: "Not in this channel",
      exact: true,
    });
    const list = dialog.getByRole("region", {
      name: "Member list",
      exact: true,
    });
    await expect(members.getByRole("heading")).toHaveCSS("position", "sticky");
    await expect(others.getByRole("heading")).toHaveCSS("position", "sticky");
    // Browser-only: empty/short roster search results follow the group with
    // just the shared gap, not after all remaining dialog height.
    const gap = await list.evaluate((node) =>
      parseFloat(getComputedStyle(node).rowGap),
    );
    const roster = await members.boundingBox();
    expect(
      (await others.boundingBox()).y - roster.y - roster.height,
    ).toBeCloseTo(gap, 0);
    // Browser-only: an unbadged identity centers at rest and moves up to
    // reveal its key, without shifting the avatar, row or Add action.
    const row = add.locator("../..");
    const name = row.getByText("Morgan", { exact: true });
    const key = row.locator('[aria-hidden="true"].text-mono');
    await search.hover();
    await expect(key).toBeHidden();
    const rowBounds = await row.boundingBox();
    await expect(row).toHaveCSS("min-height", "48px");
    expect(rowBounds.height).toBe(48);
    const avatar = row.locator("[data-avatar-shape]");
    const avatarBounds = await avatar.boundingBox();
    expect(avatarBounds.width).toBe(32);
    expect(avatarBounds.height).toBe(32);
    const nameBounds = await name.boundingBox();
    const identityGap = await name.evaluate((node) =>
      parseFloat(
        getComputedStyle(node.closest("[data-profile-link]")).columnGap,
      ),
    );
    expect(nameBounds.x - avatarBounds.x - avatarBounds.width).toBeCloseTo(
      identityGap,
      0,
    );
    const center = (bounds) => bounds.y + bounds.height / 2;
    expect(center(nameBounds)).toBeCloseTo(center(avatarBounds), 0);
    const metadata = key.locator("../..");
    await expect(metadata).toHaveCSS("height", "0px");
    const addBounds = await add.boundingBox();
    await add.hover();
    await expect(key).toBeVisible();
    await expect(name).toBeVisible();
    // Motion restores auto only after settling; compare the real token-based
    // line box instead of rounding its fractional browser height to 20px.
    await expect(metadata).toHaveAttribute("style", /height: auto/);
    const raisedName = await name.boundingBox();
    const revealedHeight = await metadata.evaluate(
      (node) =>
        node.getBoundingClientRect().height +
        parseFloat(getComputedStyle(node).marginTop),
    );
    // Flex layout quantizes the centered line to a 1/64 CSS-pixel grid.
    const expectedY = Math.round((nameBounds.y - revealedHeight / 2) * 64) / 64;
    expect(raisedName.y).toBe(expectedY);
    expect(raisedName.x).toBe(nameBounds.x);
    expect(await add.boundingBox()).toEqual(addBounds);
    expect(await row.boundingBox()).toEqual(rowBounds);
    expect(await avatar.boundingBox()).toEqual(avatarBounds);
    await search.hover();
    await expect(key).toBeHidden();
    await expect(metadata).toHaveCSS("height", "0px");
    expect(await name.boundingBox()).toEqual(nameBounds);
    await add.focus();
    await expect(key).toBeVisible();
    await expect(add.getByText("Add", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.focusFixture.published);
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    if (moved)
      await dialog
        .getByRole("button", { name: "Close channel members" })
        .focus();
    await page.evaluate(() => window.focusFixture.confirm());
    await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
    await expect(
      moved
        ? dialog.getByRole("button", { name: "Close channel members" })
        : search,
    ).toBeFocused();
  }
});

test.describe("touch identity actions", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("opens profiles from the member menu without hover", async ({
    page,
  }) => {
    await page.goto(url);
    await page
      .getByRole("button", { name: "Channel members", exact: true })
      .tap();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    const actions = dialog.getByRole("button", {
      name: "Actions for Carl",
      exact: true,
    });
    await expect(actions).toBeVisible();
    await actions.tap();
    const menu = page.getByRole("menu", { name: "Actions for Carl" });
    await expect(menu.getByRole("menuitem")).toHaveText(["View profile"]);
    await menu
      .getByRole("menuitem", { name: "View profile", exact: true })
      .tap();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.focusFixture.additions)).toEqual(
      [],
    );
  });
});

// Browser-only proof: fixed scrollport/search geometry and motion preference
// across the loading-to-content swap; completion-order matrices live in Vitest.
for (const [width, reducedMotion] of [
  [1280, "no-preference"],
  [390, "reduce"],
]) {
  test(`initial member spinner preserves list geometry at ${width}px`, async ({
    page,
  }) => {
    const { errors } = watchPageErrors(page);
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion });
    await page.goto(`${url}?loading`);
    await page.getByRole("button", { name: "Channel members" }).click();
    const dialog = page.getByRole("dialog", { name: "Channel members" });
    const list = dialog.getByRole("region", { name: "Member list" });
    const status = list.getByRole("status", { name: "Loading members" });
    const search = dialog.getByRole("searchbox");
    try {
      await expect
        .poll(() => page.evaluate(() => window.focusFixture.namesRequested()))
        .toBe(true);
      await expect(status).toBeVisible();
      await expect(
        list.getByRole("button", { name: /^Open profile for/ }),
      ).toHaveCount(0);
      // Only wait for finite dialog entrance animations, never the loading spin.
      await dialog.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished),
        );
      });
      const before = {
        list: await list.boundingBox(),
        search: await search.boundingBox(),
      };
      const spinner = status.locator("svg");
      const circle = await spinner.boundingBox();
      expect(
        Math.abs(
          circle.x + circle.width / 2 - before.list.x - before.list.width / 2,
        ),
      ).toBeLessThan(2);
      await expect(spinner).toHaveCSS(
        "animation-name",
        reducedMotion === "reduce" ? "none" : "spin",
      );
      await expect(
        dialog
          .getByRole("button", { name: "Refresh member data" })
          .locator("svg"),
      ).toHaveCSS("animation-name", "none");
      await page.evaluate(() => window.focusFixture.releaseNames());
      await expect(status).toHaveCount(0);
      await expect(list.getByText("Carl (you)")).toBeVisible();
      expect(await list.boundingBox()).toEqual(before.list);
      expect(await search.boundingBox()).toEqual(before.search);
      await expect(search).toBeFocused();
      expect(errors).toEqual([]);
    } finally {
      await page.evaluate(() => window.focusFixture.releaseNames());
    }
  });
}

// Real pointer sequencing is essential: outside pointerdown used to close the
// manually-opened menu before the ellipsis click immediately reopened it.
test("member menus toggle and dismiss through shared owners", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  const trigger = page.getByRole("button", { name: "Channel members" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Channel members" });
  const actions = dialog.getByRole("button", { name: "Actions for Carl" });
  const menu = page.getByRole("menu", { name: "Actions for Carl" });
  await expect(actions).toBeAttached();
  await dialog.getByRole("button", { name: /Open profile for Carl/ }).hover();
  await actions.click();
  await expect(menu).toBeVisible();
  await actions.click();
  await expect(menu).toHaveCount(0);
  await expect(actions).toBeFocused();
  await actions.click();
  await expect(menu).toBeVisible();
  await dialog.getByRole("searchbox").click();
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("searchbox").click();
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  await dialog
    .getByRole("button", { name: /Open profile for Carl/ })
    .click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  const profile = dialog.getByRole("button", { name: /Open profile for Carl/ });
  await expect(profile).toBeFocused();
  for (const key of ["Shift+F10", "ContextMenu"]) {
    await page.keyboard.press(key);
    await expect(menu).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(profile).toBeFocused();
  }
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(actions).toBeFocused();
  await page.mouse.click(8, 8);
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.focusFixture.additions)).toEqual([]);
  expect(errors).toEqual([]);
});

// Native scroll events, portaled focus and final-focus scroll restoration require
// a browser; jsdom cannot establish the row geometry or preserved scroll offset.
test("scrolling members dismisses button and context menus without jumping back", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(`${url}?scroll`);
  await page
    .getByRole("button", { name: "Channel members", includeHidden: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Channel members",
    includeHidden: true,
  });
  const list = dialog.getByRole("region", {
    name: "Member list",
    includeHidden: true,
  });
  const actions = dialog.getByRole("button", { name: "Actions for Carl" });
  const profile = dialog.getByRole("button", { name: /Open profile for Carl/ });
  const menu = page.getByRole("menu", { name: "Actions for Carl" });
  await expect(list.getByRole("listitem", { includeHidden: true })).toHaveCount(
    17,
  );
  for (const mode of ["button", "context", "keyboard"]) {
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBe(0);
    await profile.hover();
    if (mode === "button") await actions.click();
    else if (mode === "context") await profile.click({ button: "right" });
    else {
      await profile.focus();
      await page.keyboard.press("Shift+F10");
    }
    await opened(menu);
    // A scroll inside the portaled menu is not a scroll of the member list.
    await menu.dispatchEvent("scroll");
    await expect(menu).toHaveAttribute("data-open", "");
    await list.evaluate(
      (element) =>
        new Promise((resolve) => {
          element.addEventListener("scroll", resolve, { once: true });
          element.scrollTop = 160;
        }),
    );
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await list.evaluate((element) => element.scrollTop)).toBe(160);
  }
  expect(await page.evaluate(() => window.focusFixture.additions)).toEqual([]);
  expect(errors).toEqual([]);
});

test("portaled menu focus does not leave an empty second identity line", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  await page
    .getByRole("button", { name: "Channel members", includeHidden: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Channel members",
    includeHidden: true,
  });
  const row = dialog.getByRole("listitem", { includeHidden: true }).first();
  const profile = row.getByRole("button", { name: /Open profile for Carl/ });
  const actions = row.getByRole("button", { name: "Actions for Carl" });
  const key = row.locator('[aria-hidden="true"].text-mono');
  const metadata = key.locator("../..");
  const search = dialog.getByRole("searchbox", { includeHidden: true });
  const menu = page.getByRole("menu", { name: "Actions for Carl" });
  await expect(profile).toBeVisible();
  for (const mode of ["button", "context", "keyboard"]) {
    await profile.hover();
    await expect(key).toBeVisible();
    if (mode === "button") await actions.click();
    else if (mode === "context") await profile.click({ button: "right" });
    else {
      await profile.focus();
      await page.keyboard.press("Shift+F10");
    }
    await opened(menu);
    await menu.getByRole("menuitem").first().focus();
    await search.hover();
    await expect(key).toBeHidden();
    await expect(metadata).toHaveCSS("height", "0px");
    await expect(metadata).toHaveCSS("margin-top", "0px");
    const nameBounds = await row
      .getByText("Carl (you)", { exact: true })
      .boundingBox();
    const avatarBounds = await row.locator("[data-avatar-shape]").boundingBox();
    expect(nameBounds.y + nameBounds.height / 2).toBeCloseTo(
      avatarBounds.y + avatarBounds.height / 2,
      0,
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await search.focus();
    await expect(metadata).toHaveCSS("height", "0px");
    await profile.focus();
    await expect(key).toBeVisible();
    await expect(metadata).toHaveAttribute("style", /height: auto/);
    await search.focus();
    await expect(key).toBeHidden();
    await expect(metadata).toHaveCSS("height", "0px");
  }
  expect(errors).toEqual([]);
});

// Explicit 60-agent workload: owner verification is real CPU work that does not
// appear in small, unsigned profile fixtures. Count observation and row work too.
// This does not measure live relay latency.
test("member search reuses unchanged rows and owner observations", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  await page.goto(`${url}?search-scale`);
  await page.evaluate(() => {
    window.ownerChecks = 0;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (algorithm, data) => {
      if (new TextDecoder().decode(data).startsWith("nostr:agent-auth:"))
        window.ownerChecks++;
      return digest(algorithm, data);
    };
  });
  await page.getByRole("button", { name: "Channel members" }).click();
  const dialog = page.getByRole("dialog", { name: "Channel members" });
  const search = dialog.getByRole("searchbox");
  const refresh = dialog.getByRole("button", { name: "Refresh member data" });
  await expect(
    dialog.getByRole("button", { name: /^Open owner profile:/ }),
  ).toHaveCount(60);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  const before = await page.evaluate(() => window.ownerChecks);
  const workBefore = await page.evaluate(() => ({
    ...window.focusFixture.searchWork,
  }));
  // Same roster and labels: a query-only update must not rerender avatar/menu trees.
  await search.fill("Agent");
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(
    dialog.getByRole("button", { name: /^Open owner profile:/ }),
  ).toHaveCount(60);
  expect(await page.evaluate(() => window.focusFixture.searchWork.images)).toBe(
    workBefore.images,
  );
  await search.fill("");
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(
    dialog.getByRole("button", { name: /^Open owner profile:/ }),
  ).toHaveCount(60);
  await page.evaluate(() => {
    window.searchFrames = [];
    window.searchSample = true;
    let previous = performance.now();
    const frame = (now) => {
      window.searchFrames.push(now - previous);
      previous = now;
      if (window.searchSample) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  for (const query of ["Agent", "Agent 1", "Agent", "Agent 2", ""]) {
    await search.fill(query);
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(
      dialog.getByRole("button", { name: /^Open owner profile:/ }),
    ).toHaveCount(query === "Agent 1" || query === "Agent 2" ? 11 : 60);
  }
  const sample = await page.evaluate(() => {
    window.searchSample = false;
    return {
      searchWork: window.focusFixture.searchWork,
      ownerChecks: window.ownerChecks,
      maxFrame: Math.max(...window.searchFrames),
      longFrames: window.searchFrames.filter((ms) => ms > 50).length,
    };
  });
  await testInfo.attach("search-work.json", {
    body: JSON.stringify({ before, ...sample }),
    contentType: "application/json",
  });
  console.log("MEMBER_SEARCH_WORK", testInfo.project.name, {
    before,
    ...sample,
  });
  expect(sample.ownerChecks).toBe(before);
  expect(sample.searchWork.observations).toBe(workBefore.observations);
  expect(errors).toEqual([]);
});

// The live React profile mounted 240 invitation rows on the first letter. This
// workload must keep render/effect work bounded, not only repeated verification.
test("large known-agent searches mount only the first invitation page", async ({
  page,
}, testInfo) => {
  const { errors } = watchPageErrors(page);
  await page.goto(`${url}?invitation-scale`);
  await page.getByRole("button", { name: "Channel members" }).click();
  const dialog = page.getByRole("dialog", { name: "Channel members" });
  const search = dialog.getByRole("searchbox");
  const refresh = dialog.getByRole("button", { name: "Refresh member data" });
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => {
    window.searchFrames = [];
    window.searchSample = true;
    let previous = performance.now();
    const frame = (now) => {
      window.searchFrames.push(now - previous);
      previous = now;
      if (window.searchSample) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const counts = [];
  for (const query of ["h", "he", "hel", "hell", "hello", ""]) {
    await search.fill(query);
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    counts.push(await dialog.getByRole("button", { name: /^Add / }).count());
  }
  const sample = await page.evaluate(() => {
    window.searchSample = false;
    return {
      maxFrame: Math.max(...window.searchFrames),
      longFrames: window.searchFrames.filter((ms) => ms > 50).length,
    };
  });
  console.log("MEMBER_INVITATION_WORK", testInfo.project.name, {
    counts,
    ...sample,
  });
  await testInfo.attach("invitation-work.json", {
    body: JSON.stringify({ counts, ...sample }),
    contentType: "application/json",
  });
  expect(counts.slice(0, 3)).toEqual([30, 30, 30]);
  // A random npub may contain "hell"; it cannot contain "hello" (no o in bech32).
  expect(counts[3]).toBeLessThanOrEqual(30);
  expect(counts.slice(4)).toEqual([0, 0]);
  await search.fill("helper");
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  const more = dialog.getByRole("button", { name: "Show more results" });
  for (const count of [60, 90, 120, 150, 180, 210, 240]) {
    await more.click();
    await expect(
      dialog.getByRole("button", { name: /^Add Helper/ }),
    ).toHaveCount(count);
  }
  await expect(more).toHaveCount(0);
  expect(await page.evaluate(() => window.focusFixture.additions)).toEqual([]);
  expect(errors).toEqual([]);
});

// Browser-only: shared Select/modal focus, animated search geometry and native
// full-height row action hit testing cannot be established by jsdom.
test("member role dropdown fits beside search and preserves modal focus", async ({
  page,
}) => {
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 832 });
    await page.goto(`${url}?search-scale`);
    await page.getByRole("button", { name: "Channel members" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    const search = dialog.getByRole("searchbox");
    const filter = dialog.getByRole("combobox", {
      name: "Filter members by role",
    });
    await expect(filter).toBeVisible();
    const searchBounds = await search.boundingBox();
    const filterBounds = await filter.boundingBox();
    expect(filterBounds.x).toBeGreaterThan(searchBounds.x + searchBounds.width);
    expect(filterBounds.x + filterBounds.width).toBeLessThan(width);
    await filter.focus();
    await page.keyboard.press("ArrowDown");
    const all = page.getByRole("option", { name: "All · 61" });
    const agents = page.getByRole("option", { name: "Agents · 60" });
    await expect(all).toBeVisible();
    const popup = page.locator(".buzz-select-popup");
    await popup.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((a) => a.finished));
    });
    const popupBounds = await popup.boundingBox();
    const minimumWidth = await page.evaluate(
      () =>
        11.25 *
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect(popupBounds.width).toBeGreaterThanOrEqual(minimumWidth);
    expect(popupBounds.x + popupBounds.width).toBeCloseTo(
      filterBounds.x + filterBounds.width,
      0,
    );
    // Reopening after every choice must retain both width and right edge,
    // including Members, whose label plus selection mark is the widest.
    for (const name of ["Members · 1", "All · 61", "Agents · 60"]) {
      await page.getByRole("option", { name, exact: true }).click();
      await expect(popup).toBeHidden();
      await filter.click();
      await expect(popup).toBeVisible();
      await popup.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((a) => a.finished));
      });
      const bounds = await popup.boundingBox();
      expect(bounds.width).toBe(popupBounds.width);
      expect(bounds.x + bounds.width).toBeCloseTo(
        filterBounds.x + filterBounds.width,
        0,
      );
    }
    await agents.click();
    await expect(filter).toBeFocused();
    await expect(filter).toHaveText("Agents");
    await expect(
      dialog.getByRole("region", { name: "Members", exact: true }),
    ).toHaveCount(0);
    await search.fill("Agent 12");
    await expect(dialog.getByRole("listitem")).toHaveCount(1);
    await expect(filter).toHaveCount(0);
    const picker = dialog.locator('[inert][aria-hidden="true"]');
    await expect(picker).toHaveCSS("width", "0px");
    expect((await search.boundingBox()).width).toBeGreaterThan(
      searchBounds.width,
    );
    await expect(search).toBeFocused();
    await search.fill("");
    await expect(filter).toBeVisible();
    await expect(filter).toHaveText("All");
    await expect(dialog.getByRole("listitem")).toHaveCount(61);
    await filter.click();
    await expect(all).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(filter).toBeFocused();

    // Hit the top edge, outside the former centered circular target.
    const row = dialog.getByRole("listitem").filter({ hasText: "Agent 12" });
    const action = row.getByRole("button", { name: "Actions for Agent 12" });
    await row.hover();
    const rowBounds = await row.boundingBox();
    const actionBounds = await action.boundingBox();
    expect(actionBounds.height).toBe(rowBounds.height);
    expect(actionBounds.y).toBe(rowBounds.y);
    expect(actionBounds.x + actionBounds.width).toBe(
      rowBounds.x + rowBounds.width,
    );
    const geometry = await action.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.width,
        expectedWidth: getComputedStyle(document.documentElement)
          .getPropertyValue("--size-control-sm")
          .trim(),
        radius: style.borderTopRightRadius,
        rowRadius: getComputedStyle(element.closest("li")).borderTopRightRadius,
        leftRadius: style.borderTopLeftRadius,
      };
    });
    expect(actionBounds.width).toBe(32);
    expect(geometry.radius).toBe(geometry.rowRadius);
    expect(geometry.leftRadius).toBe("0px");
    // The attached action and profile are two parts of the same row, not
    // a floating button with a brighter hover step. Check the painted states.
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.className = mode;
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      const profile = row.getByRole("button", {
        name: /^Open profile for Agent 12/,
      });
      await row.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      await profile.hover({ position: { x: 20, y: 20 } });
      const profileFill = await profile.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((a) => a.finished));
        return getComputedStyle(element).backgroundColor;
      });
      await action.hover();
      await expect(action).toHaveCSS("background-color", profileFill);
    }
    const corners = await action.evaluate((element) => {
      const button = getComputedStyle(element);
      return ["::before", "::after"].map((pseudo) => {
        const style = getComputedStyle(element, pseudo);
        return {
          width: style.width,
          height: style.height,
          right: style.right,
          mask: style.maskImage,
          radius: button.borderTopRightRadius,
          buttonWidth: button.width,
          sameFill: style.backgroundColor === button.backgroundColor,
          pointerEvents: style.pointerEvents,
        };
      });
    });
    for (const corner of corners) {
      expect(corner.width).toBe(corner.radius);
      expect(corner.height).toBe(corner.radius);
      expect(corner.right).toBe(corner.buttonWidth);
      expect(corner.mask).toContain("radial-gradient");
      expect(corner.sameFill).toBe(true);
      expect(corner.pointerEvents).toBe("none");
    }
    await action.click({ position: { x: actionBounds.width / 2, y: 2 } });
    await expect(
      page.getByRole("menu", { name: "Actions for Agent 12" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(action).toBeFocused();
  }
});
