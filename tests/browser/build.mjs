import { fixtureAliases } from "../relay-config.ts";
import { build } from "vite";
import react from "../../scripts/react-plugin.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Playwright owns this worker-scoped build. Only compiled assets are shared;
// each test still owns its server, identities, relay state and browser storage.
export async function buildApp(
  { developmentReact, pluginFixtures, companionFixture },
  use,
) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-browser-build-"));
  try {
    const config = {
      root,
      mode: "production",
      configFile: false,
      envFile: false, // Never read the developer's live identity configuration.
      logLevel: "error",
      plugins: [
        react(),
        ...(pluginFixtures || companionFixture
          ? [
              {
                name: "fixture-installed-plugins",
                transform(code, id) {
                  if (id !== join(root, "src/bundled/index.ts")) return;
                  const source = pluginFixtures
                    ? "plugin-fixtures"
                    : "companion-fixture";
                  const exported = pluginFixtures
                    ? "fixturePlugins"
                    : "companionPlugins";
                  // Keep the companion after the built-ins so catalog scrolling
                  // remains part of its focus-restoration journey.
                  const injected = pluginFixtures
                    ? code.replace("= [", `= [ ...${exported},`)
                    : code.replace(/\];\s*$/, `].concat(${exported});`);
                  return `import { ${exported} } from ${JSON.stringify(join(root, `tests/browser/${source}.tsx`))};\n${injected}`;
                },
              },
            ]
          : []),
      ],
      define: {
        ...(developmentReact ? { "import.meta.env.DEV": "true" } : {}),
        "import.meta.env.VITE_BUZZ_LIVE": '"1"',
        "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
          JSON.stringify(fixtureAliases),
        ...(developmentReact
          ? { "process.env.NODE_ENV": '"development"' }
          : {}),
      },
      build: { outDir: join(directory, "dist"), emptyOutDir: true },
    };
    const start = performance.now();
    await build(config);
    await use({ config, durationMs: performance.now() - start });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
