import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "../../scripts/react-plugin.ts";
import { fileURLToPath } from "node:url";

test("editable composer renders links and mentions while preserving source and notification intent", async ({
  page,
  browserName,
}) => {
  // Keep the empty-after-send contract under test; agent-prefill behavior has
  // separate coverage in mention-edit.spec.mjs.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-messages.html`,
    );
    const input = page.getByRole("textbox", {
      name: "Message #design",
      exact: true,
    });
    const preview = input;
    await expect(
      page.getByRole("region", { name: "Draft preview" }),
    ).toHaveCount(0);
    await expect(preview.locator('[data-link-kind="github"]')).toHaveCount(2);
    await expect(
      preview.locator('.inline-chip[data-kind="person"]'),
    ).toHaveText("@Alex Chen");
    await expect(preview.locator('.inline-chip[data-kind="agent"]')).toHaveText(
      "@Build Bot",
    );
    const delivered = page.locator('[data-message-id="link-row"]');
    const deliveredLink = delivered
      .locator('a:has([data-link-kind="github"])')
      .first();
    const deliveredMentions = delivered.locator("[data-mention-kind]");
    // Match the app's bundled typeface before comparing native font boxes.
    // document.fonts.ready alone cannot detect a missing @font-face import.
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        Array.from(document.fonts).some(
          (font) =>
            font.family.includes("Inter Variable") && font.status === "loaded",
        ),
      ),
    ).toBe(true);
    const inlineStyles = await Promise.all(
      [deliveredLink, deliveredMentions.nth(0), deliveredMentions.nth(1)].map(
        (locator) =>
          locator.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              color: style.color,
              paddingBlock: [style.paddingTop, style.paddingBottom],
              height: element.getBoundingClientRect().height,
            };
          }),
      ),
    );
    for (const mentionStyle of inlineStyles.slice(1)) {
      expect(mentionStyle.color).toBe(inlineStyles[0].color);
      expect(mentionStyle.paddingBlock).toEqual(inlineStyles[0].paddingBlock);
      expect(
        Math.abs(mentionStyle.height - inlineStyles[0].height),
      ).toBeLessThan(1);
    }
    await expect(preview.getByRole("link")).toHaveCount(0);
    await expect(preview.getByRole("button")).toHaveCount(0);

    // Select-all includes the full painted token, not only its text label.
    const initialSource = await input.evaluate((el) => el.value);
    const tokenCount = await input.locator("[data-source]").count();
    await input.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(
      tokenCount,
    );
    const selectedSource = await input.evaluate((el) => {
      const clipboardData = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return clipboardData.getData("text/plain");
    });
    expect(selectedSource).toBe(initialSource);
    await page.keyboard.press("ArrowRight");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+a");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(
      tokenCount,
    );
    await page.keyboard.type("Replaced selection");
    await expect(input).toHaveJSProperty("value", "Replaced selection");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(0);

    const mouseSource = "Before https://github.com/block/buzz-app/pulls after";
    await input.fill(mouseSource);
    for (const target of [input, input.locator("[data-source]")]) {
      await page.keyboard.press("ArrowRight");
      await target.click({ clickCount: 3, position: { x: 4, y: 8 } });
      await expect(input.locator("[data-editor-selected]")).toHaveCount(1);
      expect(
        await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
      ).toEqual([0, mouseSource.length]);
      await expect(input).toHaveJSProperty("value", mouseSource);
    }
    await page.keyboard.press("ArrowRight");
    const drag = await input.evaluate((el) => {
      const range = document.createRange();
      // The editor now contains block paragraphs. Selecting the outer editor
      // measures their full width, not the painted text; WebKit will not start
      // a text drag at that outside edge. Use the actual paragraph contents.
      range.selectNodeContents(el.querySelector("p"));
      const end = range.getBoundingClientRect();
      return {
        start: el.getBoundingClientRect().left,
        end: end.right,
        y: end.top + end.height / 2,
      };
    });
    await page.mouse.move(drag.end, drag.y);
    await page.mouse.down();
    await page.mouse.move(drag.start, drag.y, { steps: 12 });
    await page.mouse.up();
    await expect(input.locator("[data-editor-selected]")).toHaveCount(1);
    expect(
      await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([0, mouseSource.length]);

    const text =
      "Review [**GitHub**](https://github.com/block/buzz-app) in #design with ";
    await input.fill(text);
    await input.press("End");
    await page
      .getByRole("button", { name: "Mention Alex Chen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Mention Build Bot", exact: true })
      .click();
    const expected = `${text}@Alex Chen @Build Bot `;
    await expect(input).toHaveJSProperty("value", expected);
    await expect(input).toBeFocused();
    expect(await input.evaluate((el) => el.selectionStart)).toBe(
      expected.length,
    );
    await expect(preview.locator("strong")).toHaveText("GitHub");
    await expect(preview.locator('.inline-chip[data-kind="agent"]')).toHaveText(
      "@Build Bot",
    );
    await input.press("Enter");
    expect(await page.evaluate(() => window.linkComposerFixture.sent)).toEqual([
      { text: expected, mentions: ["a".repeat(64), "b".repeat(64)] },
    ]);
    await expect(input).toHaveJSProperty("value", "");
    await expect(preview.locator("[data-source]")).toHaveCount(0);

    // Empty editors still need a real text caret after send, refocus and delete.
    for (const state of ["sent", "refocused", "deleted"]) {
      if (state === "refocused") {
        await input.evaluate((el) => el.blur());
        await input.focus();
      } else if (state === "deleted") {
        await input.pressSequentially("x");
        await input.press("Backspace");
      } else await input.focus();
      await expect(input).toHaveJSProperty("value", "");
      const emptyCaret = await input.evaluate((el) => {
        const selection = getSelection().getRangeAt(0);
        // ProseMirror uses an empty paragraph + BR, not a zero-width source
        // character. A collapsed element Range has no rect in Chromium; its
        // BR supplies the same native caret line box.
        const caretRange = selection.cloneRange();
        if (
          !caretRange.getBoundingClientRect().height &&
          selection.startContainer instanceof Element &&
          selection.startContainer.childNodes[selection.startOffset]
            ?.nodeName === "BR"
        )
          caretRange.selectNode(
            selection.startContainer.childNodes[selection.startOffset],
          );
        const caret = caretRange.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return {
          height: caret.height,
          left: caret.left - box.left,
          top: caret.top - box.top,
          bottom: box.bottom - caret.bottom,
          selection: [el.selectionStart, el.selectionEnd],
        };
      });
      expect(emptyCaret.height, state).toBeGreaterThan(10);
      expect(Math.abs(emptyCaret.left), state).toBeLessThan(2);
      expect(emptyCaret.top, state).toBeGreaterThanOrEqual(0);
      expect(emptyCaret.bottom, state).toBeGreaterThanOrEqual(0);
      expect(emptyCaret.selection, state).toEqual([0, 0]);
    }

    const pasted = "@Alex Chen [Drive](https://drive.google.com/file/example)";
    await input.fill(pasted);
    await expect(preview.locator(".inline-chip")).toHaveCount(0);
    await expect(preview.locator('[data-link-kind="drive"]')).toHaveText(
      "Drive",
    );
    await page.reload();
    await expect(input).toHaveJSProperty("value", pasted);
    await expect(preview.locator(".inline-chip")).toHaveCount(0);
    // A rendered item at the end must have a real caret box after its label.
    const linkSource = "See https://github.com/block/buzz-app";
    await input.fill(linkSource);
    const caretBox = await input.evaluate((el) => {
      const range = getSelection().getRangeAt(0).cloneRange();
      if (
        !range.getBoundingClientRect().height &&
        range.startContainer instanceof Element
      ) {
        const child = range.startContainer.childNodes[range.startOffset];
        const boundary = child?.nodeName === "IMG" ? child.nextSibling : child;
        if (boundary?.nodeName === "BR") range.selectNode(boundary);
      }
      const caret = range.getBoundingClientRect();
      const link = el.querySelector("[data-source]").getBoundingClientRect();
      return {
        x: caret.x,
        y: caret.y,
        height: caret.height,
        right: link.right,
        top: link.top,
      };
    });
    expect(caretBox.height).toBeGreaterThan(10);
    expect(Math.abs(caretBox.x - caretBox.right)).toBeLessThan(2);
    expect(Math.abs(caretBox.y - caretBox.top)).toBeLessThan(2);
    await input.press("Backspace");
    await expect(input).toHaveJSProperty("value", linkSource.slice(0, -1));
    await expect(input.locator("[data-source]")).toHaveCount(0);
    await input.pressSequentially("p after");
    await expect(input).toHaveJSProperty("value", `${linkSource} after`);
    await expect(input.locator("[data-source]")).toHaveCount(0);

    const secondLink = "https://drive.google.com/file/example";
    await input.fill("");
    await input.fill(`${linkSource} ${secondLink}`);
    await input.evaluate(
      (el, end) => el.setSelectionRange(end, end),
      linkSource.length,
    );
    await page.keyboard.press("Backspace");
    await expect(input.locator("[data-source]")).toHaveCount(1);
    await expect(input.locator('[data-link-kind="drive"]')).toHaveCount(1);
    await input.evaluate((el) => el.setSelectionRange(0, 0));
    await page.keyboard.type("Note: ");
    await expect(input.locator("[data-source]")).toHaveCount(1);
    await input.evaluate((el) => el.blur());
    await input.focus();
    await expect(input.locator("[data-source]")).toHaveCount(1);

    await input.fill("");
    await input.fill(`${linkSource} after`);
    await input.locator("[data-source]").click();
    await input.pressSequentially("!");
    await expect(input).toHaveJSProperty("value", `${linkSource}! after`);
    await input.fill(linkSource);
    await input.press("ArrowLeft");
    expect(await input.evaluate((el) => el.selectionStart)).toBe(
      linkSource.length - 1,
    );
    await input.press("Delete");
    await expect(input).toHaveJSProperty("value", linkSource.slice(0, -1));
    await input.pressSequentially("p");
    const copied = await input.evaluate((el) => {
      el.setSelectionRange(0, el.value.length);
      const clipboardData = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return clipboardData.getData("text/plain");
    });
    expect(copied).toBe(linkSource);

    // Paste, Space and continued typing must not require refocusing the field.
    const pastedUrl = "https://github.com/block/buzz-app/pulls";
    // Delete at a rendered boundary is a text edit, including native commands
    // without keydown. It must not consume only the invisible caret marker.
    for (const nativeCommand of browserName === "webkit"
      ? [false, true]
      : [false]) {
      await input.fill(pastedUrl);
      for (let count = 1; count <= 3; count++) {
        if (nativeCommand)
          await input.evaluate(() => document.execCommand("delete"));
        else await page.keyboard.press("Backspace");
        await expect(input).toHaveJSProperty(
          "value",
          pastedUrl.slice(0, -count),
        );
        expect(await input.evaluate((el) => el.selectionStart)).toBe(
          pastedUrl.length - count,
        );
      }
      await page.keyboard.press("ControlOrMeta+z");
      await expect(input).toHaveJSProperty("value", pastedUrl.slice(0, -2));
    }
    await input.fill(pastedUrl);
    await input.evaluate((el) => el.setSelectionRange(0, 0));
    await page.keyboard.press("Delete");
    await expect(input).toHaveJSProperty("value", pastedUrl.slice(1));

    for (const source of [pastedUrl, `[${pastedUrl}](${pastedUrl})`]) {
      for (const restoredInsideLabel of [false, true]) {
        await input.fill("");
        await expect(input).toHaveJSProperty("value", "");
        await input.evaluate((el, source) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", source);
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
        }, source);
        await expect(input.locator("[data-source]")).toHaveCount(1);
        await expect(input).toHaveJSProperty("value", `${source} `);
        if (restoredInsideLabel) {
          // Some native WebKit selection restorations land inside the uneditable
          // label even though its logical offset is the end of the pasted URL.
          await input.evaluate((el) => {
            const token = el.querySelector("[data-source]");
            getSelection().setBaseAndExtent(
              token,
              token.childNodes.length,
              token,
              token.childNodes.length,
            );
            // Exercise the key path before a queued selectionchange can repair it.
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: " ",
                bubbles: true,
                cancelable: true,
              }),
            );
          });
          await page.keyboard.press("Space");
        }
        await expect(input).toBeFocused();
        // Use the keyboard directly: locator.press would refocus and hide this bug.
        await page.keyboard.type("next thought");
        await expect(input).toHaveJSProperty(
          "value",
          `${source} next thought${restoredInsideLabel ? " " : ""}`,
        );
        await expect(input).toBeFocused();
        expect(await input.evaluate((el) => el.selectionStart)).toBe(
          `${source} next thought`.length,
        );
      }
    }

    for (const { source, initial, expected, caret = 0 } of [
      {
        source: pastedUrl,
        initial: "[First](https://example.com)  after",
        caret: "[First](https://example.com) ".length,
        expected: `[First](https://example.com) ${pastedUrl} next after`,
      },
      {
        source: pastedUrl,
        initial: " after",
        expected: `${pastedUrl} next after`,
      },
      { source: `${pastedUrl} `, initial: "", expected: `${pastedUrl} next ` },
      { source: "plain", initial: "", expected: "plainnext " },
      {
        source: `\`${pastedUrl}\``,
        initial: "",
        expected: `\`${pastedUrl}\`next `,
      },
    ]) {
      await input.fill(initial);
      await expect(input).toHaveJSProperty("value", initial);
      await input.evaluate(
        (el, { source, caret }) => {
          el.setSelectionRange(caret, caret);
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", source);
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData,
            }),
          );
        },
        { source, caret },
      );
      await page.keyboard.type("next ");
      await expect(input).toHaveJSProperty("value", expected);
    }

    // Markdown titles stay in the authored source while the composer decorates
    // only the destination and label, matching the delivered message renderer.
    const titledSource = '[Docs](https://example.com "Guide")';
    await input.fill(titledSource);
    await expect(input.locator("[data-source]")).toHaveText("Docs");
    await expect(input).toHaveJSProperty("value", titledSource);
    await input.press("Enter");
    expect(
      (await page.evaluate(() => window.linkComposerFixture.sent)).at(-1),
    ).toEqual({ text: titledSource, mentions: [] });

    // A compact label still copies, edits, and sends the full destination.
    const longUrl =
      "https://www.figma.com/design/example/Builderlab-—-Branding?node-id=1119-21207";
    for (const source of [longUrl, `[${longUrl}](${longUrl})`]) {
      await input.fill("");
      await input.fill(source);
      await expect(input.locator("[data-link-kind=figma]")).toHaveText(
        `${longUrl.slice(0, 44)}…`,
      );
      const longCopy = await input.evaluate((el) => {
        el.setSelectionRange(0, el.value.length);
        const clipboardData = new DataTransfer();
        el.dispatchEvent(
          new ClipboardEvent("copy", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        return clipboardData.getData("text/plain");
      });
      expect(longCopy).toBe(source);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Backspace");
      await expect(input).toHaveJSProperty("value", source.slice(0, -1));
      await expect(input.locator("[data-source]")).toHaveCount(0);
      await input.fill("");
      await input.fill(source);
      await page.keyboard.press("Enter");
      expect(
        (await page.evaluate(() => window.linkComposerFixture.sent)).at(-1),
      ).toEqual({ text: source, mentions: [] });
    }

    // Undo restores the pre-edit caret, including edits before rendered tokens.
    await input.fill("ABC");
    await input.evaluate((el) => el.setSelectionRange(1, 1));
    await input.pressSequentially("X");
    await input.press("ControlOrMeta+z");
    await expect(input).toHaveJSProperty("value", "ABC");
    expect(await input.evaluate((el) => el.selectionStart)).toBe(1);
    await input.pressSequentially("Y");
    await expect(input).toHaveJSProperty("value", "AYBC");
    await input.press("Shift+Enter");
    await input.pressSequentially("next");
    await expect(input).toHaveJSProperty("value", "AY\nnextBC");

    await input.fill("");
    await input.pressSequentially("https://github.com/block/buzz-app");
    await expect(input.locator('[data-link-kind="github"]')).toHaveCount(1);
    await input.pressSequentially(" after");
    await expect(input).toHaveJSProperty(
      "value",
      "https://github.com/block/buzz-app after",
    );
    await input.locator("[data-source]").dblclick();
    await input.pressSequentially("https://drive.google.com/file/edited");
    await expect(input).toHaveJSProperty(
      "value",
      "https://drive.google.com/file/edited after",
    );
    await expect(input.locator('[data-link-kind="drive"]')).toHaveCount(1);

    await input.fill("Before ");
    await input.press("End");
    await page
      .getByRole("button", { name: "Mention Alex Chen", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Mention Build Bot", exact: true })
      .click();
    await input.evaluate((el) => el.setSelectionRange(7, 17));
    await input.press("Backspace");
    await expect(input.locator('.inline-chip[data-kind="person"]')).toHaveCount(
      0,
    );
    await expect(input.locator('.inline-chip[data-kind="agent"]')).toHaveCount(
      1,
    );
    await input.press("ControlOrMeta+z");
    await expect(input.locator('.inline-chip[data-kind="person"]')).toHaveCount(
      1,
    );
    expect(
      await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
    ).toEqual([7, 17]);
    await input.press("ControlOrMeta+Shift+z");
    await expect(input.locator('.inline-chip[data-kind="person"]')).toHaveCount(
      0,
    );
    await input.press("Enter");
    expect(
      (await page.evaluate(() => window.linkComposerFixture.sent)).at(-1),
    ).toEqual({ text: "Before  @Build Bot ", mentions: ["b".repeat(64)] });

    await input.fill("IME");
    const compositionKeys = await input.evaluate((el) => {
      el.setSelectionRange(1, 1);
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      const results = ["Home", "End", "Enter"].map((key) => {
        const event = new KeyboardEvent("keydown", {
          key,
          isComposing: true,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        return { prevented: event.defaultPrevented, caret: el.selectionStart };
      });
      el.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      return results;
    });
    expect(compositionKeys).toEqual(
      Array(3).fill({ prevented: false, caret: 1 }),
    );

    // IME input can be noncancelable; enforce the source limit when it commits.
    await input.fill("A".repeat(16000));
    await input.evaluate((el) => {
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: false,
          inputType: "insertCompositionText",
          data: "你",
          isComposing: true,
        }),
      );
      el.value += "你";
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "你",
          isComposing: true,
        }),
      );
      el.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "你" }),
      );
    });
    await expect(input).toHaveJSProperty("value", "A".repeat(16000));

    await input.fill(pasted);
    await page.getByRole("button", { name: "Plugin off", exact: true }).click();
    await expect(preview.locator("[data-link-renderer]")).toHaveCount(0);
    await expect(preview).toContainText("Drive");
    await expect(input).toHaveJSProperty("value", pasted);
  } finally {
    await server.close();
  }
});
