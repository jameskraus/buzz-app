import react from "../../scripts/react-plugin.ts";
import { fileURLToPath } from "node:url";

// Deliberately independent of vite.config.ts: no live broker, env file or identity.
export default {
  root: fileURLToPath(new URL("../../", import.meta.url)),
  envFile: false,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 1444, strictPort: true },
};
