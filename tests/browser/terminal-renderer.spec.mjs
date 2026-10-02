import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "../../scripts/react-plugin.ts";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

test("real xterm retains output across detach, handles input and resize, and does not reserve absent shortcuts", async ({
  page,
}) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal.html`,
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    const input = page.getByLabel("Input", { exact: true });
    const splash = page.locator("[data-terminal-splash]");
    await expect(splash).toHaveCount(0); // Wait for actual shell output.
    await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
    await button("Paint terminal").click();
    await page.clock.runFor(50); // Let xterm parse/paint, then hold the welcome open.
    await expect(splash).toBeVisible();
    await expect(splash.locator('[data-layer="head"]')).not.toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    const rightEdge = await splash.evaluate((element) => {
      const xs = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode;
        for (let i = 0; i < text.length; i++) {
          if (!"▜▐▟".includes(text.textContent[i])) continue;
          const range = document.createRange();
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          xs.push(range.getBoundingClientRect().x);
        }
      }
      return xs;
    });
    expect(rightEdge.length).toBeGreaterThan(5);
    expect(Math.max(...rightEdge) - Math.min(...rightEdge)).toBeLessThan(1);

    const colors = await splash
      .locator('[data-layer="head"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).color),
      );
    expect(new Set(colors).size).toBeGreaterThan(8);
    await expect(splash).toHaveCSS("--splash-lightness", "72%");
    await expect(splash).toHaveCSS("--splash-chroma", "0.12");
    await page.screenshot({
      path: test.info().outputPath("buzzterm-light.png"),
    });
    const xterm = page.locator(".xterm-viewport");
    const assertAnsiContrast = async () => {
      for (const text of [
        "ANSI_WHITE_ON_BLACK",
        "ANSI_WHITE_ON_GRAY",
        "ANSI_WHITE_ON_DEFAULT",
        "ANSI_BLACK_ON_DEFAULT",
      ]) {
        const ratio = await page
          .getByText(text, { exact: true })
          .evaluate((el) => {
            const css = getComputedStyle(el);
            const luminance = (color) => {
              const rgb = color
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number)
                .map((v) => {
                  const s = v / 255;
                  return s <= 0.04045
                    ? s / 12.92
                    : ((s + 0.055) / 1.055) ** 2.4;
                });
              return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            };
            const fg = luminance(css.color);
            const background =
              css.backgroundColor === "rgba(0, 0, 0, 0)"
                ? getComputedStyle(document.querySelector(".xterm-viewport"))
                    .backgroundColor
                : css.backgroundColor;
            const bg = luminance(background);
            return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
          });
        expect(ratio, `${text} foreground/background contrast`).toBeGreaterThan(
          4.5,
        );
      }
    };
    await assertAnsiContrast();
    const assertSystemAppearance = async () => {
      const actual = await xterm.evaluate((viewport) => {
        const element = viewport.closest("[data-buzz-ui]");
        const css = getComputedStyle(element);
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--bg-panel)";
        element.append(probe);
        const background = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          background: getComputedStyle(viewport).backgroundColor,
          expectedBackground: background,
          font: css.fontFamily,
          size: css.fontSize,
          renderedSize: getComputedStyle(document.querySelector(".xterm-rows"))
            .fontSize,
        };
      });
      expect(actual.background).toBe(actual.expectedBackground);
      expect(actual.font).toContain("JetBrains Mono");
      expect(actual.renderedSize).toBe(actual.size);
      return Number.parseFloat(actual.size);
    };
    expect(await assertSystemAppearance()).toBe(12);
    const lightBackground = await xterm.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await button("Toggle theme").click();
    await page.clock.runFor(50); // Flush xterm's theme repaint under the held clock.
    await expect
      .poll(() => xterm.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(lightBackground);
    await expect(splash).toHaveCSS("--splash-lightness", "80%");
    await expect(splash).toHaveCSS("--splash-chroma", "0.16");
    await assertAnsiContrast();
    expect(await assertSystemAppearance()).toBe(12);
    await page.screenshot({
      path: test.info().outputPath("buzzterm-dark.png"),
    });
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);

    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("hello");
    await expect(splash).toHaveCount(0);
    await page.clock.resume();

    await page.keyboard.press("Control+c");
    await expect(input).toHaveText('"hello\\u0003"');
    await button("Alternate screen").click();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    const fontSize = await page
      .locator(".xterm-rows")
      .evaluate((el) => getComputedStyle(el).fontSize);
    await button("Enlarge text").click();
    await expect
      .poll(() =>
        page
          .locator(".xterm-rows")
          .evaluate((el) => getComputedStyle(el).fontSize),
      )
      .not.toBe(fontSize);
    expect(await assertSystemAppearance()).toBe(18);
    const dimensions = await page.getByLabel("Dimensions").textContent();
    await page.setViewportSize({ width: 800, height: 600 });
    await expect(page.getByLabel("Dimensions")).not.toHaveText(dimensions);
    await button("Toggle mount").click();
    await expect(page.locator(".xterm")).toHaveCount(0);
    await button("Paint terminal").click(); // Parse output while detached.
    await button("Toggle theme").click(); // Reopen must pick up hidden appearance changes.
    await button("Toggle mount").click();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    await expect(splash).toHaveCount(0);
    await expect
      .poll(() => xterm.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(lightBackground);
    await page.locator(".xterm-helper-textarea").focus();
    // With no dispatcher/registration, even the old toggle chord belongs to
    // the terminal. The plugin/dispatcher handoff is covered below.
    await page.keyboard.press("Control+j");
    await expect(input).toHaveText('"hello\\u0003\\n"');
    // Fresh dark startup, bounded static splash (including reduced motion).
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.clock.pauseAt(new Date("2026-01-01T02:00:00Z"));
    await button("Toggle theme").click();
    await button("Paint terminal").click();
    await page.clock.runFor(50);
    await expect(splash).toBeVisible();
    await expect(splash).toHaveCSS("animation-name", "none");
    await page.clock.runFor(2000);
    await expect(splash).toBeVisible();
    await page.clock.runFor(1000);
    await expect(splash).toHaveCount(0); // 3s, not the old 4.5s.
    await page.clock.resume();
    await expect(page.locator(".xterm-rows")).toContainText(
      "BUZZ_RENDERER_READY",
    );
    // Small terminals retain readable branding instead of clipped block art.
    await page.setViewportSize({ width: 400, height: 600 });
    await page.reload();
    await page.clock.pauseAt(new Date("2026-01-01T03:00:00Z"));
    await button("Paint terminal").click();
    await page.clock.runFor(50);
    await expect(splash).toHaveText("buzz term");
    await button("Toggle mount").click();
    await button("Toggle theme").click();
    await button("Toggle mount").click();
    await expect(splash).toHaveCount(0);
    await page.clock.resume();
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("terminal shared controls keep focus, recovery and layout in both modes", async ({
  page,
}) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const server = await createServer({
    root,
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html`,
    );
    const button = (name) => page.getByRole("button", { name, exact: true });
    const launcher = button("Toggle channel terminal");
    await expect(launcher).toHaveAttribute("data-buzz-ui", "");
    await expect(launcher).toHaveCSS("padding-left", "0px");
    await expect(launcher).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await launcher.hover();
    await expect(launcher).toHaveCSS("background-color", "rgb(241, 241, 242)");
    await launcher.click();
    const drawer = page.getByRole("region", { name: "Terminal drawer" });
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await expect(launcher).toHaveAttribute("aria-pressed", "true");
    await expect(launcher).toHaveAttribute("data-icon-variant", "tint");
    await page.mouse.move(0, 0);
    const expectToken = async (node, property, token) => {
      const value = await node.evaluate(
        (el, { property, token }) => {
          const probe = document.createElement("span");
          probe.style.setProperty(property, `var(${token})`);
          el.append(probe);
          const value = getComputedStyle(probe).getPropertyValue(property);
          probe.remove();
          return value;
        },
        { property, token },
      );
      await expect(node).toHaveCSS(property, value);
    };
    await expectToken(launcher, "color", "--purple-12");
    await expectToken(launcher, "background-color", "--purple-3");
    const restart = button("Restart");
    await expect(restart).toHaveClass("buzz-button");
    await expect(restart).toHaveCSS("border-top-width", "0px");
    const hide = button("Hide terminal");
    // Pointer focus is quiet; keyboard navigation paints the actual control.
    await button("Enlarge text").click();
    // The shared small-button label role is 14px, scaled to 150%.
    await expect(restart).toHaveCSS("font-size", "21px");
    // Keep the operation pending while its disabled color finishes animating.
    // A short fixture delay can expire between Playwright's assertion samples.
    await page.evaluate(() => window.terminalPanel.holdClose());
    try {
      await restart.click();
      await expect
        .poll(() => page.evaluate(() => window.terminalPanel.closePending()))
        .toBe(true);
      await expect(restart).toBeDisabled();
      await expectToken(restart, "color", "--text-disabled");
      await expect(restart).toHaveCSS("outline-style", "none");
    } finally {
      await page.evaluate(() => window.terminalPanel.releaseClose());
    }
    await expect(restart).toBeEnabled();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await button("End session").focus();
    await page.keyboard.press("Tab");
    await expect(hide).toBeFocused();
    await expect(hide).toHaveCSS("outline-style", "solid");
    await expect(hide).toHaveCSS("outline-width", "2px");
    for (const mode of ["light", "dark"]) {
      if (mode === "dark") await button("Toggle theme").click();
      for (const width of [1280, 800, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(hide).toBeInViewport();
        await expectToken(
          drawer.locator("[data-terminal-version]"),
          "background-color",
          "--bg-panel",
        );
        if (width === 1280) {
          const splash = drawer.locator("[data-terminal-splash]");
          await page.evaluate(() => window.terminalPanel.holdClose());
          try {
            await restart.click();
            await expect
              .poll(() =>
                page.evaluate(() => window.terminalPanel.closePending()),
              )
              .toBe(true);
            await page.clock.pauseAt(
              new Date(`2026-01-01T0${mode === "light" ? 1 : 2}:00:00Z`),
            );
          } finally {
            await page.evaluate(() => window.terminalPanel.releaseClose());
          }
          await page.clock.runFor(50);
          await expect(splash.locator('[data-layer="head"]')).toHaveCount(151);
          const bounds = await splash.evaluate((el) => {
            const frame = el.getBoundingClientRect();
            const art = el.querySelector("pre").getBoundingClientRect();
            return (
              art.top >= frame.top - 1 &&
              art.bottom <= frame.bottom + 1 &&
              art.left >= frame.left - 1 &&
              art.right <= frame.right + 1
            );
          });
          expect(bounds).toBe(true);
          await page.clock.resume();
        }
        await expect(restart).toBeInViewport();
        expect(
          await drawer.evaluate((el) => el.scrollWidth),
        ).toBeLessThanOrEqual(width);
        const header = drawer.locator(".panel-header");
        expect(
          await header.evaluate((el) => el.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: test.info().outputPath(`terminal-panel-${mode}-${width}.png`),
        });
      }
    }
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await hide.click();
    await expect(drawer).toHaveCount(0);
    await expect(launcher).toHaveAttribute("aria-pressed", "false");
    await launcher.click();
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);
    await button("Toggle close failure").click();
    await button("End session").click();
    await expect(page.getByRole("alert")).toContainText("Fixture close failed");
    await button("Toggle close failure").click();
    await button("End session").focus();
    await page.keyboard.press("Enter");
    await expect(button("Start session")).toBeVisible();
    await expect(hide).toBeFocused();
    await button("Start session").click();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.evaluate(() => window.terminalPanel.holdClose());
    await button("End session").focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.closePending()))
      .toBe(true);
    await button("Toggle theme").focus(); // The user leaves while close is pending.
    await page.evaluate(() => window.terminalPanel.releaseClose());
    await expect(button("Start session")).toBeVisible();
    await expect(button("Toggle theme")).toBeFocused();
    await button("Start session").click();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html?short`,
    );
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "2"),
    );
    await launcher.click();
    await expect(drawer.locator(".xterm-rows")).toContainText("FIXTURE");
    await expect(hide).toBeInViewport();
    await expect(restart).toBeInViewport();
    await expect(button("End session")).toBeInViewport();
    expect(
      await drawer.locator(".xterm-viewport").evaluate((el) => el.clientHeight),
    ).toBeGreaterThanOrEqual(78); // two 26px mono lines at 1.5 leading
    expect(
      await drawer.locator(".panel-header").evaluate((el) => el.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: test.info().outputPath("terminal-short-200.png"),
    });
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("real xterm replies survive scope switches while stale input and retired writes are fenced", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-session.html`;
    const open = async () => {
      await page.goto(url);
      await expect
        .poll(() => page.evaluate(() => window.terminalSession?.ready()))
        .toBe(true);
      await page.evaluate(() => window.terminalSession.mount());
    };
    const generated = () =>
      page.evaluate(() => window.terminalSession.generated);
    const writes = () => page.evaluate(() => window.terminalSession.writes);
    const reply = (data) => ({ owner: "retained-owner", id: "pty-1", data });
    const output = async (data) => {
      await expect
        .poll(() => page.evaluate(() => window.terminalSession.reading()))
        .toBe(true);
      await page.evaluate((data) => window.terminalSession.output(data), data);
    };
    await open();
    await page.evaluate(() => window.terminalSession.holdWrites());
    await page.keyboard.type("a");
    await expect.poll(writes).toEqual([reply("a")]);
    await page.keyboard.type("b"); // Queued user input must be rechecked at dispatch.
    await output("\x1b[6n");
    await expect
      .poll(generated)
      .toContainEqual({ data: "\x1b[1;1R", source: "reply" });
    await page.evaluate(() => {
      window.terminalSession.switchScope();
      window.terminalSession.releaseWrites();
    });
    await expect.poll(writes).toEqual([reply("a"), reply("\x1b[1;1R")]);
    // The old view can still receive events before React unmounts it.
    await page.keyboard.type("x");
    await page.evaluate(() => window.terminalSession.staleInput());
    await expect
      .poll(generated)
      .toContainEqual({ data: "STALE_PASTE", source: "user" });
    await page.evaluate(() => window.terminalSession.detach());
    await output("\x1b[5n\x1b[6n");
    await expect
      .poll(writes)
      .toEqual([
        reply("a"),
        reply("\x1b[1;1R"),
        reply("\x1b[0n"),
        reply("\x1b[1;1R"),
      ]);
    const before = await generated();
    await page.evaluate(() => window.terminalSession.staleInput());
    expect(await generated()).toEqual(before); // Detached keyboard/paste never enters the session.
    await page.evaluate(() => window.terminalSession.dispose());

    // Receipt and dispatch are distinct fences: returning to A must not revive
    // input received in B. A real parser reply behind it proves the queue drained.
    await open();
    await page.evaluate(() => window.terminalSession.holdWrites());
    await page.keyboard.type("a");
    await expect.poll(writes).toEqual([reply("a")]);
    await page.evaluate(() => window.terminalSession.switchScope());
    await page.keyboard.type("x");
    await page.evaluate(() => window.terminalSession.staleInput());
    await expect
      .poll(generated)
      .toContainEqual({ data: "STALE_PASTE", source: "user" });
    await page.evaluate(() => window.terminalSession.restoreScope());
    await output("\x1b[5n");
    await expect
      .poll(generated)
      .toContainEqual({ data: "\x1b[0n", source: "reply" });
    await page.evaluate(() => window.terminalSession.releaseWrites());
    await expect.poll(writes).toEqual([reply("a"), reply("\x1b[0n")]);
    await page.evaluate(() => window.terminalSession.dispose());

    for (const operation of ["end", "dispose"]) {
      await open();
      await page.evaluate(() => window.terminalSession.holdWrites());
      await page.keyboard.type("a");
      await expect.poll(writes).toEqual([reply("a")]);
      await output("\x1b[6n");
      await expect
        .poll(generated)
        .toContainEqual({ data: "\x1b[1;1R", source: "reply" });
      await page.evaluate(async (operation) => {
        const ending = window.terminalSession[operation]();
        window.terminalSession.releaseWrites();
        await ending;
      }, operation);
      expect(await writes()).toEqual([reply("a")]);
      if (operation === "end")
        await page.evaluate(() => window.terminalSession.dispose());
    }
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only: real xterm's capture-phase handler can write PTY bytes and stop
// propagation. Exercise the actual bundled registration, store and dispatcher.
test("focused terminal follows rebind, restore and reset without swallowing the chord or writing it to the shell", async ({
  page,
}) => {
  // Force the non-Apple mapping even on macOS: Ctrl+U is xterm's line kill.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    }),
  );
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/terminal-panel.html`,
    );
    const launcher = page.getByRole("button", {
      name: "Toggle channel terminal",
      exact: true,
    });
    const drawer = page.getByRole("region", { name: "Terminal drawer" });
    const textarea = drawer.locator(".xterm-helper-textarea");
    const settings = page.getByRole("button", {
      name: "Shortcut settings",
      exact: true,
    });
    const row = page.getByRole("article", {
      name: "Toggle channel terminal",
      exact: true,
    });
    await settings.click();
    await row
      .getByRole("button", {
        name: "Change shortcut for Toggle channel terminal",
        exact: true,
      })
      .click();
    await page.keyboard.press("Control+u");
    await expect(row.getByText("Modified")).toBeVisible();
    await launcher.click();
    await expect(drawer.locator(".xterm-rows")).toContainText(
      "FIXTURE_SHELL_READY",
    );
    await page.evaluate(() => {
      window.retainedTerminal = document.querySelector(".xterm");
    });
    await expect(textarea).toBeFocused();
    await page.keyboard.type("hello");
    await page.keyboard.press("Control+c");
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.written()))
      .toBe("hello\u0003");
    const toggles = await page.evaluate(() => window.terminalPanel.toggles());
    await page.keyboard.press("Control+u");
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => window.terminalPanel.toggles())).toBe(
      toggles + 1,
    );
    expect(await page.evaluate(() => window.terminalPanel.written())).toBe(
      "hello\u0003",
    );
    await launcher.click();
    await expect(textarea).toBeFocused();
    expect(
      await page.evaluate(
        () => window.retainedTerminal === document.querySelector(".xterm"),
      ),
    ).toBe(true);
    await page.keyboard.press("Control+j"); // Old binding now reaches the shell.
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.written()))
      .toBe("hello\u0003\n");
    await row
      .getByRole("button", {
        name: "Reset shortcut for Toggle channel terminal",
        exact: true,
      })
      .click();
    await textarea.focus();
    await page.keyboard.press("Control+u"); // Reset releases Ctrl+U again.
    await expect
      .poll(() => page.evaluate(() => window.terminalPanel.written()))
      .toBe("hello\u0003\n\u0015");
    await page.keyboard.press("Control+j");
    await expect(drawer).toHaveCount(0);
    // Restore from device storage; modified Enter would otherwise write CR.
    await row
      .getByRole("button", {
        name: "Change shortcut for Toggle channel terminal",
        exact: true,
      })
      .click();
    await page.keyboard.press("Control+Enter");
    await expect(row.getByRole("alert")).toContainText("Saved");
    await page.reload();
    await launcher.click();
    await expect(textarea).toBeFocused();
    await page.keyboard.press("Control+Enter");
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => window.terminalPanel.toggles())).toBe(2);
    expect(await page.evaluate(() => window.terminalPanel.written())).toBe("");
    await page.evaluate(() => window.terminalPanel.dispose());
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
