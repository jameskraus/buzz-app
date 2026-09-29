import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openChannelPlaceholder } from "./navigation.mjs";

test.use({ savedSidebar: true });

test("sidebar scrollbar starts below the top inset without changing content geometry", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1440, height: 360 });
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (viewport) => viewport.scrollHeight > viewport.clientHeight,
      ),
    )
    .toBe(true);
  const geometry = await sidebar.evaluate((viewport) => {
    const frame = viewport.parentElement;
    if (!(frame instanceof HTMLElement))
      throw new Error("Missing sidebar frame");
    const mask = getComputedStyle(frame, "::after");
    const panel = viewport.closest("[data-buzz-surface]");
    if (!(panel instanceof HTMLElement))
      throw new Error("Missing sidebar panel");
    return {
      maskTop: Number.parseFloat(mask.top),
      maskHeight: Number.parseFloat(mask.height),
      maskRight: Number.parseFloat(mask.right),
      maskWidth: Number.parseFloat(mask.width),
      maskColor: mask.backgroundColor,
      panelColor: getComputedStyle(panel).backgroundColor,
      paddingTop: Number.parseFloat(getComputedStyle(viewport).paddingTop),
      scrollTop: viewport.scrollTop,
    };
  });
  expect(geometry).toEqual({
    maskTop: 0,
    maskHeight: 24,
    maskRight: 0,
    maskWidth: 5,
    maskColor: geometry.panelColor,
    panelColor: geometry.panelColor,
    paddingTop: 8,
    scrollTop: 0,
  });
});

// Real layout, pointer hover and portaled-menu geometry cannot be proven in jsdom.
// Keep this fixture small; the existing sidebar-unread journeys own overflow scale.
test("compact sidenav keeps its geometry across persistent page navigation", async ({
  page,
  app,
}, info) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.getByRole("button", { name: "Alpha", exact: true });
  const panel = page.getByRole("complementary", {
    name: "Channel sidebar",
    exact: true,
  });
  const pages = panel.getByRole("navigation", { name: "Pages" });
  const destinations = [
    "Messages",
    "Projects",
    "Agents",
    "Sessions",
    "Workflows",
  ].map((name) => pages.getByRole("button", { name, exact: true }));
  const assertDestinationFillParity = async () => {
    const geometry = await Promise.all(
      destinations.map((destination) =>
        destination.evaluate((element) => {
          const panel = element.closest('aside[aria-label="Channel sidebar"]');
          if (!(panel instanceof HTMLElement))
            throw new Error("Missing channel sidebar panel");
          const panelRect = panel.getBoundingClientRect();
          const rowRect = element.getBoundingClientRect();
          return {
            left: rowRect.left - panelRect.left,
            right: panelRect.right - rowRect.right,
            gutter: (() => {
              const scroll = element.closest(
                '[aria-label="Subscribed channels"]',
              );
              return scroll.offsetWidth - scroll.clientWidth;
            })(),
          };
        }),
      ),
    );
    for (const row of geometry) {
      expect(row.left).toBe(13);
      expect(row.right).toBe(row.left + row.gutter);
    }
  };
  await assertDestinationFillParity();
  const before = await alpha.boundingBox();
  expect(before.height).toBe(28);
  const viewportBox = await sidebar.boundingBox();
  const alphaBox = await alpha.boundingBox();
  const overflow = await sidebar.evaluate((viewport) => ({
    clientWidth: viewport.clientWidth,
    scrollWidth: viewport.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  expect(alphaBox.x).toBeGreaterThanOrEqual(viewportBox.x);
  expect(alphaBox.x + alphaBox.width).toBeLessThanOrEqual(
    viewportBox.x + viewportBox.width,
  );
  const assertRowFillRounded = async () => {
    const visual = await alpha.evaluate((button) => {
      const row = button.closest("[data-channel-sidebar-row]");
      const viewport = button.closest("nav");
      if (!(row instanceof HTMLElement) || !(viewport instanceof HTMLElement))
        throw new Error("Missing sidebar row geometry");
      const fillStyle = getComputedStyle(row, "::before");
      const rowStyle = getComputedStyle(row);
      const rowRect = row.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
      const contentRight = viewportRect.right - scrollbarWidth;
      return {
        fillInset:
          contentRight - (rowRect.right - Number.parseFloat(fillStyle.right)),
        leftContentInset: rowRect.left - viewportRect.left,
        rightContentInset: contentRight - rowRect.right,
        radius: fillStyle.borderTopRightRadius,
        overflow: rowStyle.overflow,
        clientWidth: viewport.clientWidth,
        offsetWidth: viewport.offsetWidth,
        scrollbarWidth,
      };
    });
    expect(visual.scrollbarWidth).toBe(visual.offsetWidth - visual.clientWidth);
    expect(visual.leftContentInset).toBe(0);
    expect(visual.rightContentInset).toBe(0);
    expect(visual.fillInset).toBe(10);
    expect(Number.parseFloat(visual.radius)).toBeGreaterThan(0);
    expect(visual.overflow).toBe("visible");
  };
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "220px";
  });
  await expect
    .poll(() =>
      sidebar.evaluate(
        (viewport) => viewport.scrollWidth - viewport.clientWidth,
      ),
    )
    .toBe(0);
  const narrowViewport = await sidebar.boundingBox();
  const narrowAlpha = await alpha.boundingBox();
  await assertDestinationFillParity();
  expect(narrowAlpha.x + narrowAlpha.width).toBeLessThanOrEqual(
    narrowViewport.x + narrowViewport.width,
  );
  await assertRowFillRounded();
  await page.evaluate(() => {
    const sidebar = document.querySelector(".shell-sidebar");
    if (!(sidebar instanceof HTMLElement))
      throw new Error("Missing channel sidebar");
    sidebar.style.width = "260px";
  });
  await expect
    .poll(() => alpha.evaluate((row) => row.getBoundingClientRect().width))
    .toBe(before.width);
  await alpha.hover();
  await expect(
    sidebar.getByRole("button", { name: "More options for Alpha" }),
  ).toHaveCount(0);
  const afterHover = await alpha.boundingBox();
  expect(afterHover.height).toBe(before.height);
  expect(afterHover.width).toBe(before.width);
  await alpha.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
    page.viewportSize().width,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(alpha).toBeFocused();
  const node = await sidebar.elementHandle();
  await page
    .getByRole("button", { name: "Agents", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  await expect(alpha).toBeVisible();
  await alpha.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    await sidebar.screenshot({ path: info.outputPath(`sidenav-${mode}.png`) });
  }
  await page
    .getByRole("button", { name: "Personal space", exact: true })
    .click();
  // Plugin pages do not need a community, so personal space keeps them enabled.
  for (const destination of destinations)
    await expect(destination).toBeEnabled();
});

// Browser layout and native disclosure behavior are not represented in jsdom.
test("section disclosure toggles content and honors reduced motion", async ({
  page,
  app,
}) => {
  await open(page, app);
  const summary = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator("summary")
    .filter({ hasText: /^Channels$/ });
  const section = summary.locator("xpath=ancestor::*[@data-sidebar-section]");
  const contentId = await summary.getAttribute("aria-controls");
  expect(contentId).toBeTruthy();
  const content = section.locator(`[id="${contentId}"]`);
  const details = section.locator(":scope > div:first-child > details");
  const expanded = await section.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  for (const opening of [false, true]) {
    await summary.click();
    if (opening) await expect(details).toHaveAttribute("open", "");
    else await expect(details).not.toHaveAttribute("open");
    if (opening) await expect(content).not.toHaveAttribute("inert");
    else await expect(content).toHaveAttribute("inert", "");
    await expect
      .poll(() => section.evaluate((el) => el.getBoundingClientRect().height))
      .toBe(opening ? expanded : 28);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await summary.click();
  await expect(details).not.toHaveAttribute("open");
  const durations = await section.evaluate((el) => {
    const content = el.querySelector(":scope > div:last-child");
    const chevron = el.querySelector("summary > span:last-child");
    return [content, chevron].map(
      (element) => getComputedStyle(element).transitionDuration,
    );
  });
  expect(durations).toEqual(["0s", "0s"]);
  expect(
    await section.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(28);
});

// A real grid/overlay measurement is needed: DOM presence misses implicit columns.
test("placeholder destinations retain companion layout across navigation and resize", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const launcher = page.locator('.shell-header button[aria-label="Bestie"]');
  const companion = page.getByRole("complementary", {
    name: "Bestie",
    exact: true,
  });
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const checkGeometry = async (overlay) => {
    await expect(companion).toBeVisible();
    await expect
      .poll(async () => {
        const card = await companion.boundingBox();
        const body = await conversation.boundingBox();
        if (!card || !body) return false;
        return overlay
          ? Math.abs(card.x + card.width - body.x - body.width) < 2 &&
              card.x < body.x + body.width
          : card.x >= body.x + body.width;
      })
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(page.viewportSize().width);
  };
  const selectChannel = async (name) => {
    const show = page.getByRole("button", {
      name: "Show navigation",
      exact: true,
    });
    if (await show.isVisible()) await show.click();
    await sidebar.getByRole("button", { name, exact: true }).click();
  };
  const openPlaceholder = async (name) => {
    await openChannelPlaceholder(page, name);
    await expect(
      conversation.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  };
  for (const width of [1440, 900, 600]) {
    await page.setViewportSize({ width, height: 950 });
    await openPlaceholder("Inbox");
    await launcher.click();
    await checkGeometry(width <= 1000);
    await openPlaceholder("Bestie");
    await checkGeometry(width <= 1000);
    await launcher.click();
    await expect(companion).not.toBeVisible();
    await selectChannel("Alpha");
    await launcher.click();
    await openPlaceholder("Inbox");
    await checkGeometry(width <= 1000);
    await launcher.click();
  }
});

// Real text layout: a rename changes scrollWidth without resizing the label box.
test("channel name fades follow renames without resizing the sidebar", async ({
  page,
  app,
}) => {
  await open(page, app);
  const sidebar = page.getByRole("navigation", { name: "Subscribed channels" });
  const alpha = sidebar.locator('button[data-channel-id="alpha"]');
  const label = alpha.getByText("Alpha", { exact: true });
  const labelNode = await label.elementHandle();
  const originalWidth = await label.evaluate((element) => element.clientWidth);
  const sidebarWidth = (await sidebar.boundingBox()).width;
  await expect(label).not.toHaveAttribute("data-overflowing");
  await page
    .getByRole("button", { name: "Channel settings", exact: true })
    .click();
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await settings.getByText("Diagnostics", { exact: true }).click();
  for (const [name, overflow] of [
    [
      "A very long renamed channel that cannot possibly fit in this fixed width sidebar",
      true,
    ],
    ["Alpha", false],
  ]) {
    app.renameChannel("alpha", name);
    await settings
      .getByRole("button", { name: "Refresh channels", exact: true })
      .click();
    const renamed = alpha.getByText(name, { exact: true });
    await expect(renamed).toBeVisible();
    expect(await labelNode.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(await renamed.evaluate((element) => element.clientWidth)).toBe(
      originalWidth,
    );
    expect((await sidebar.boundingBox()).width).toBe(sidebarWidth);
    expect(
      await renamed.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(overflow);
    if (overflow)
      await expect(renamed).toHaveAttribute("data-overflowing", "true");
    else await expect(renamed).not.toHaveAttribute("data-overflowing");
  }
});

const fillSidebar = test.extend({
  dmLabels: true,
  sessionChannels: ["alpha"],
  sessionParents: { alpha: "11111111-1111-4111-8111-111111111111" },
});

// Fill lives on the channel wrapper pseudo-element but directly on ordinary and
// nested navigation rows. Real browser geometry verifies those paints align.
fillSidebar(
  "all sidenav row fills share visible inline bounds",
  async ({ page, app }) => {
    await page.goto(app.origin);
    const sidebar = page.getByRole("complementary", {
      name: "Channel sidebar",
    });
    const list = page.getByRole("navigation", { name: "Subscribed channels" });
    const rows = {
      destination: sidebar.getByRole("button", {
        name: "Messages",
        exact: true,
      }),
      channel: sidebar.getByRole("button", { name: "Beta", exact: true }),
      dm: sidebar.getByRole("button", { name: "Alice Fixture", exact: true }),
      session: sidebar.getByRole("button", { name: /Alpha, session in/ }),
    };
    const fillBounds = (row) =>
      row.evaluate((button) => {
        const wrapper = button.closest("[data-channel-sidebar-row]");
        const target = wrapper ?? button;
        const rect = target.getBoundingClientRect();
        const style = getComputedStyle(
          target,
          wrapper ? "::before" : undefined,
        );
        const inset = (value) => {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : 0;
        };
        return {
          left: rect.left + inset(style.left),
          right: rect.right - inset(style.right),
          containerLeft: rect.left,
          containerRight: rect.right,
        };
      });
    for (const width of [1440, 720]) {
      await page.setViewportSize({ width, height: 900 });
      // Resizing is asynchronous in WebKit; assert the complete applied layout.
      await expect(async () => {
        const bounds = Object.fromEntries(
          await Promise.all(
            Object.entries(rows).map(async ([key, row]) => {
              await expect(row).toBeVisible();
              return [key, await fillBounds(row)];
            }),
          ),
        );
        expect(
          bounds.destination.left - bounds.destination.containerLeft,
        ).toBeCloseTo(0, 0);
        expect(
          bounds.destination.containerRight - bounds.destination.right,
        ).toBeCloseTo(0, 0);
        const listBounds = await list.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        });
        expect(bounds.destination.left - listBounds.left).toBeCloseTo(4, 0);
        expect(
          listBounds.right - bounds.destination.right,
        ).toBeGreaterThanOrEqual(4);
        for (const bound of Object.values(bounds)) {
          expect(bound.left).toBeCloseTo(bounds.destination.left, 0);
          expect(bound.right).toBeCloseTo(bounds.destination.right, 0);
        }
      }).toPass({ timeout: 10_000 });
    }

    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("complementary", {
      name: "Settings sidebar",
    });
    const back = settings.getByRole("button", { name: "Back", exact: true });
    const profile = settings.getByRole("button", {
      name: "Profile",
      exact: true,
    });
    await expect(profile).toHaveAttribute("aria-current", "page");
    expect(await fillBounds(profile)).toEqual(await fillBounds(back));
  },
);
