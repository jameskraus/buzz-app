import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import react from "../../scripts/react-plugin.ts";
import { createServer } from "./vite-server.mjs";

// Browser-only boundary: actual File/DataTransfer delivery, editor capture and page wiring.
test("picker, pane drop and clipboard files use the same attachment draft and existing Send", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [
      react(),
      {
        name: "attachment-download-fixture",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/api/relay/media?")) return next();
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": "attachment",
              "X-Content-Type-Options": "nosniff",
            });
            res.end("fixture document");
          });
        },
      },
    ],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/relay-composer.html?attachments`,
    );
    const form = page.getByRole("form", {
      name: "Send a message to General",
      exact: true,
    });
    await expect(
      form.getByRole("button", { name: "Attach files", exact: true }),
    ).toBeEnabled();
    // Rejected selections must announce via the host toast, not stretch the form.
    await form.getByRole("textbox").evaluate((input) => {
      const file = new File(["oversized"], "large.pdf", {
        type: "application/pdf",
      });
      Object.defineProperty(file, "size", { value: 501 * 1024 * 1024 });
      const data = new DataTransfer();
      data.items.add(file);
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    const notices = page.getByRole("region", { name: "App notifications" });
    await expect(
      notices.getByText("Could not attach file", { exact: true }),
    ).toBeVisible();
    await expect(form.getByRole("alert")).toHaveCount(0);
    await notices.getByRole("button", { name: "Dismiss notification" }).click();
    await form.getByLabel("Choose attachments").setInputFiles({
      name: "picked.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("picked"),
    });
    await expect(form.getByText(/Ready$/)).toHaveCount(1);
    await expect(form.locator("video")).toHaveCount(0);
    const remove = form.getByRole("button", {
      name: "Remove picked.txt",
      exact: true,
    });
    await expect(remove).toHaveCSS("width", "20px");
    await expect(remove).toHaveCSS("height", "20px");
    await expect(remove.locator("svg").last()).toHaveCSS("width", "12px");
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(
        new File(["dropped"], "dropped.txt", { type: "text/plain" }),
      );
      return data;
    });
    try {
      const zone = page.locator("[data-attachment-drop-zone]").first();
      await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
      await expect(form).toHaveAttribute("data-file-drag", "true");
      await zone.dispatchEvent("drop", { dataTransfer: transfer });
      await expect(form.getByText(/Ready$/)).toHaveCount(2);
      await expect(form).not.toHaveAttribute("data-file-drag", "true");
    } finally {
      await transfer.dispose();
    }
    await form.getByRole("textbox").evaluate((input) => {
      const data = new DataTransfer();
      data.items.add(
        new File(["pasted"], "pasted.txt", { type: "text/plain" }),
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    await expect(form.getByText(/Ready$/)).toHaveCount(3);
    // Real layout proves attachment cards stay in one horizontal lane.
    const cards = form
      .getByRole("region", { name: "Attachments", exact: true })
      .getByRole("listitem");
    const boxes = await cards.evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { top: rect.top, left: rect.left };
      }),
    );
    expect(boxes.every((box) => box.top === boxes[0].top)).toBe(true);
    expect(boxes[1].left).toBeGreaterThan(boxes[0].left);
    await form.screenshot({
      path: test.info().outputPath("compact-attachments.png"),
    });

    await form.getByRole("button", { name: "Remove dropped.txt" }).click();
    await expect(form.getByText(/Ready$/)).toHaveCount(2);
    await form.getByRole("textbox").press("Enter");
    await expect(
      form.getByRole("button", { name: "Remove picked.txt" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: /picked.txt/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /pasted.txt/ })).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "Download picked.txt", exact: true })
      .click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("picked.txt");
    expect(await readFile(await download.path(), "utf8")).toBe(
      "fixture document",
    );
  } finally {
    await server.close();
  }
});

// Browser-only boundary: toolbar geometry and keyboard order with real contributed tools.
test("paperclip follows mentions and recipients, before the remaining tools", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?attachments`,
    );
    const mention = page.getByRole("button", {
      name: "Mention a member",
      exact: true,
    });
    const attach = page.getByRole("button", {
      name: "Attach files",
      exact: true,
    });
    const emoji = page.getByRole("button", {
      name: "Insert emoji",
      exact: true,
    });
    await expect(mention).toBeVisible();
    await expect(attach).toBeEnabled();
    await expect(emoji).toBeVisible();
    await mention.click();
    const pubkey = await page.evaluate(() => window.mentionFixture.first);
    await page
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button", { name: `Honey ${pubkey}`, exact: true })
      .click();
    const recipient = page
      .getByRole("region", { name: "Explicit mentions" })
      .getByRole("button");
    await expect(recipient).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Mention a member or agent" }),
    ).toHaveCount(0);
    await mention.focus();
    for (const next of [recipient, attach, emoji]) {
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();
    }
    const recipientBox = await recipient.boundingBox();
    const attachBox = await attach.boundingBox();
    const emojiBox = await emoji.boundingBox();
    expect(attachBox.x).toBeGreaterThanOrEqual(
      recipientBox.x + recipientBox.width,
    );
    expect(emojiBox.x).toBeGreaterThanOrEqual(attachBox.x + attachBox.width);
    expect(
      Math.abs(
        attachBox.y +
          attachBox.height / 2 -
          (recipientBox.y + recipientBox.height / 2),
      ),
    ).toBeLessThanOrEqual(2);
    await page.screenshot({
      path: test.info().outputPath("attachment-toolbar.png"),
    });
    await page.evaluate(() =>
      window.mentionFixture.change("disable", "buzz.mentions"),
    );
    await expect(mention).toHaveCount(0);
    await expect(attach).toBeEnabled();
    await recipient.focus();
    await page.keyboard.press("Tab");
    await expect(attach).toBeFocused();
  } finally {
    await server.close();
  }
});

// Browser-only boundary: real decoders/canvas, module worker/Wasm and browser output MIME.
test("preparation preserves snapshot/animation and uses lossless WebP for pixel cleanup", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    optimizeDeps: { include: ["@jsquash/webp/encode.js"] },
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    for (const [name, type] of [
      ["still.png", "image/png"],
      ["animated.png", "image/png"],
      ["animated.gif", "image/gif"],
      ["animated.webp", "image/webp"],
      ["profile.webp", "image/webp"],
    ]) {
      const bytes = await readFile(
        new URL(`../fixtures/attachment-media/${name}`, import.meta.url),
      );
      const result = await page.evaluate(
        async ({ name, type, bytes }) => {
          const { prepareAttachment } = await import(
            "/src/features/messages/prepare-attachment.ts"
          );
          const { pngChunks } = await import(
            "/src/features/messages/image-metadata.ts"
          );
          let source = new Uint8Array(bytes);
          let manifest;
          if (name === "still.png") {
            const payload = new TextEncoder().encode(
              "buzz_agent_snapshot\0EXACT_MANIFEST",
            );
            manifest = new Uint8Array(payload.length + 12);
            new DataView(manifest.buffer).setUint32(0, payload.length);
            manifest.set(new TextEncoder().encode("tEXt"), 4);
            manifest.set(payload, 8);
            let crc = 0xffffffff;
            for (const value of manifest.subarray(4, -4)) {
              crc ^= value;
              for (let k = 0; k < 8; k++)
                crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
            }
            new DataView(manifest.buffer).setUint32(
              manifest.length - 4,
              (crc ^ 0xffffffff) >>> 0,
            );
            const copy = new Uint8Array(source.length + manifest.length);
            copy.set(source.subarray(0, 33));
            copy.set(manifest, 33);
            copy.set(source.subarray(33), 33 + manifest.length);
            source = copy;
          }
          const output = await prepareAttachment(
            new File([source], name, { type }),
            new AbortController().signal,
          );
          const bitmap = await createImageBitmap(output);
          const dimensions = [bitmap.width, bitmap.height];
          bitmap.close();
          const prepared = new Uint8Array(await output.arrayBuffer());
          const snapshot = manifest ? pngChunks(prepared)[1].raw : undefined;
          return {
            type: output.type,
            size: output.size,
            dimensions,
            text: new TextDecoder("latin1").decode(prepared),
            snapshot: snapshot && Array.from(snapshot),
            manifest: manifest && Array.from(manifest),
          };
        },
        { name, type, bytes: Array.from(bytes) },
      );
      expect(result.type).toBe(type);
      expect(result.dimensions.every((value) => value > 0)).toBe(true);
      if (name === "still.png")
        expect(result.snapshot).toEqual(result.manifest);
      if (name === "animated.png") {
        expect(result.text).toContain("acTL");
        expect(result.text).toContain("fdAT");
      }
      if (name === "animated.gif") expect(result.text).toContain("NETSCAPE2.0");
      if (name === "animated.webp") {
        expect(result.text).toContain("ANIM");
        expect(result.text).toContain("ANMF");
      }
      if (name === "profile.webp") {
        expect(result.text).toContain("VP8L");
        expect(result.text).not.toContain("ICCP");
      }
    }
  } finally {
    await server.close();
  }
});
