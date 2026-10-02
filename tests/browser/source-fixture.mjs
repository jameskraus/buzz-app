import { test as base, expect } from "@playwright/test";
import react from "../../scripts/react-plugin.ts";
import { fileURLToPath } from "node:url";
import { createServer } from "./vite-server.mjs";

// Only stateless source serving is shared. Playwright still owns a fresh context
// per test; fixtures with mutable server middleware must keep their own server.
export const test = base.extend({
  sourceOrigin: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
    async ({}, use) => {
      const server = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        envFile: false,
        plugins: [react()],
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      try {
        await server.listen();
        await use(`http://127.0.0.1:${server.httpServer.address().port}`);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ sourceOrigin }, use) => use(sourceOrigin),
});
export { expect };
