import { defineConfig } from "vite";
import react from "./scripts/react-plugin.ts";

// Product specimens have their own document, CSS reset and bundle. The design
// viewer's core-only import guard remains unchanged.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  base: "./",
  build: {
    outDir: "dist/design-system",
    emptyOutDir: false,
    rollupOptions: { input: "tests/fixtures/message-gallery.html" },
  },
});
