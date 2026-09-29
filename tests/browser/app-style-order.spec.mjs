import { test, expect } from "./source-fixture.mjs";

// Exercise shared shell controls through the real app entry, not a specimen.
// Composer layer-order coverage belongs with the rich-editor integration.
test("app startup preserves shared shell control styling", async ({ page }) => {
  await page.goto("/");
  const destinations = page.getByRole("complementary", {
    name: "Channel sidebar",
  });
  const messages = destinations.getByRole("button", {
    name: "Messages",
    exact: true,
  });
  const agents = destinations.getByRole("button", {
    name: "Agents",
    exact: true,
  });
  await expect(agents).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate((dark) => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.dataset.colorMode = dark ? "dark" : "light";
    }, dark);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      if (width <= 650)
        await page
          .getByRole("button", { name: "Show navigation", exact: true })
          .click();
      await expect(messages).toHaveCSS("border-top-width", "0px");
      await expect(agents).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      const controls = [
        page.getByRole("button", { name: "Go back", exact: true }),
        page.getByRole("button", { name: "Go forward", exact: true }),
        page.getByRole("button", { name: "Search Buzz", exact: true }),
      ];
      for (const control of controls) {
        await expect(control).toBeVisible();
        await expect(control).toHaveCSS("padding-left", "0px");
        // Shared controls draw outlines with an inset shadow, not a border.
        await expect(control).toHaveCSS("border-top-width", "0px");
      }
      const search = controls[2];
      const glassHover = await search.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--bg-glass-primary-hover)";
        element.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      await search.hover();
      await expect(search).toHaveCSS("background-color", glassHover);
      await page.mouse.move(0, 0);
      if (width <= 650)
        await page
          .getByRole("button", { name: "Hide navigation", exact: true })
          .click();
    }
  }
});
