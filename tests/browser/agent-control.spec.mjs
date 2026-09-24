import { test, expect } from "@playwright/test";
import { npubEncode } from "nostr-tools/nip19";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";
import { watchPageErrors } from "./page-errors.mjs";

async function closeEditor(page) {
  const dialog = page.getByRole("dialog", { name: "Edit agent", exact: true });
  if (await dialog.count())
    await dialog.getByRole("button", { name: "Close editor" }).click();
}
async function openImport(panel) {
  await panel
    .getByRole("button", {
      name: "Import from another installation",
      exact: true,
    })
    .click();
  await expect(
    panel.getByRole("button", { name: "Import Fixture agent" }),
  ).toBeVisible();
  const options = panel.getByText("Import options", { exact: true });
  if (!(await options.evaluate((el) => el.parentElement.open)))
    await options.click();
}
async function openEditor(page, name = "Fixture agent") {
  const dialog = page.getByRole("dialog", { name: "Edit agent", exact: true });
  if (!(await dialog.count())) {
    await page
      .getByRole("article", { name: `Agent ${name}`, exact: true })
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  }
  const runtime = dialog.getByRole("button", { name: "Runtime", exact: true });
  if ((await runtime.getAttribute("aria-expanded")) !== "true")
    await runtime.click();
  for (const name of ["Environment", "Model"]) {
    const summary = dialog.getByRole("button", { name, exact: true });
    if ((await summary.getAttribute("aria-expanded")) !== "true")
      await summary.click();
  }
  return dialog;
}

test("local controls preserve drafts, confirm operations and distinguish disabled from sleeping", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const errors = watchPageErrors(page);
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const panel = page.getByRole("region", {
      name: "Local agent controls",
      includeHidden: true,
    });
    const editor = await openEditor(page);
    await expect(
      editor.getByText("Process running · relay readiness unverified", {
        exact: true,
      }),
    ).toBeVisible();
    await editor
      .getByRole("button", { name: "Technical details", exact: true })
      .click();
    await expect(
      editor.getByText(npubEncode("ab".repeat(32)), { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText("ab".repeat(32), { exact: true }),
    ).toHaveCount(0);

    await editor
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("My unsaved prompt");
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await page.evaluate(() => window.agentControlFixture.failSave(true));
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByRole("alert").first()).toContainText(
      "Could not confirm",
    );
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await page.evaluate(() => window.agentControlFixture.failSave(false));
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await editor
      .getByLabel("Replacement for EXAMPLE_TOKEN")
      .fill("fixture-only-value");
    await expect(
      editor.getByLabel("Replacement for EXAMPLE_TOKEN"),
    ).toHaveAttribute("type", "password");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.getByText("Saved.", { exact: true })).toBeVisible();
    await expect(
      editor.getByText(/Saved revision 2 · Running revision 1/),
    ).toBeVisible();
    await expect(
      editor.getByLabel("Replacement for EXAMPLE_TOKEN"),
    ).toHaveValue("");
    const saved = await page.evaluate(() =>
      window.agentControlFixture.calls
        .filter((call) => call.action === "save")
        .at(-1),
    );
    expect(saved.payload.edit.environment).toEqual({
      EXAMPLE_TOKEN: "fixture-only-value",
    });
    await editor.getByRole("button", { name: "Restart to apply" }).click();
    await expect(
      editor.getByText(/Saved revision 2 · Running revision 2/),
    ).toBeVisible();
    await editor
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("Keep this conflict draft");
    await page.evaluate(async () => {
      window.agentControlFixture.agent.revision++;
      await window.agentControlFixture.control.refresh();
    });
    await expect(editor.getByRole("alert")).toContainText(
      "newer saved revision",
    );
    await expect(
      editor.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("Keep this conflict draft");
    await editor.getByRole("button", { name: "Discard changes" }).click();
    await expect(
      editor.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("My unsaved prompt");
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      editor.getByText("Process stopped", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText(
        "Manual start · a later sent mention can start this agent",
        { exact: true },
      ),
    ).toBeVisible();
    const before = await page.evaluate(() =>
      window.agentControlFixture.calls.filter(
        (call) => call.action !== "snapshot",
      ),
    );
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action !== "snapshot",
        ),
      ),
    ).toEqual(before);
    await closeEditor(page);
    await openImport(panel);
    await panel
      .getByRole("combobox", { name: "Source library", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Development Buzz", exact: true })
      .click();
    await panel
      .getByLabel("Destination community", { exact: true })
      .fill("wss://chosen.example");
    await panel.getByRole("button", { name: "Load agents" }).click();
    await expect(
      panel.getByText("/fixture/development/managed-agents.json"),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Import Fixture agent" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action === "import",
        ),
      ),
    ).toEqual([]);
    await panel.getByRole("button", { name: "Import Fixture agent" }).click();
    // Only the two managed identities have controls; the template stays read-only.
    await expect(
      panel.getByRole("article").filter({
        has: page.getByRole("button", { name: /^Actions for / }),
      }),
    ).toHaveCount(2);
    await expect(
      panel
        .getByRole("region", { name: "Library identities", exact: true })
        .getByRole("article"),
    ).toHaveCount(0);
    await expect(
      panel
        .getByRole("region", { name: "Profiles without identities" })
        .getByRole("article", { name: "Agent Library only", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.data.agents.every((a) => !a.enabled),
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("agent-controls-light.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Toggle appearance" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "Add agent" }).blur();
    await page.mouse.move(0, 0);
    // Primary aliases prominent: dark resting fill is white, grey is hover.
    await expect(panel.getByRole("button", { name: "Add agent" })).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await page.screenshot({
      path: test.info().outputPath("agent-controls-dark-narrow.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Toggle browser-only mode" })
      .click();
    await closeEditor(page);
    await expect(panel.getByText(/This browser cannot run/)).toBeVisible();
    // Library-only entries no longer pretend to be managed cards with Edit.
    await expect(panel.getByText("Add agent", { exact: true })).toHaveCount(0);
    const libraryCard = page.getByRole("article", {
      name: "Agent Fixture agent",
      exact: true,
    });
    await expect(libraryCard).toBeVisible();
    await expect(
      libraryCard.getByRole("button", { name: /Actions|Start|Edit/ }),
    ).toHaveCount(0);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("explicit-on preference survives Stop without changing the enabled state", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const editor = await openEditor(page);
    // Native owns the legacy None → enabled projection (store/tests.rs).
    // This browser fixture witnesses explicit-on while running and after Stop.
    await page.evaluate(() =>
      window.agentControlFixture.control.setStartOnAppLaunch(
        "fixture-agent",
        true,
      ),
    );
    await expect(
      editor.getByText("Enabled · starts with buzz-app", { exact: true }),
    ).toBeVisible();
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      editor.getByText("Process stopped", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText("Start on launch enabled", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        enabled: window.agentControlFixture.agent.enabled,
        startOnAppLaunch: window.agentControlFixture.agent.startOnAppLaunch,
        actions: window.agentControlFixture.calls.filter((call) =>
          ["startOnAppLaunch", "stop"].includes(call.action),
        ),
      })),
    ).toEqual({
      enabled: false,
      startOnAppLaunch: true,
      actions: [
        {
          action: "startOnAppLaunch",
          payload: { id: "fixture-agent", enabled: true },
        },
        { action: "stop", payload: { id: "fixture-agent" } },
      ],
    });
  } finally {
    await server.close();
  }
});

for (const previouslyStopped of [false, true]) {
  test(`unreadable status allows only explicit Stop from a retained ${previouslyStopped ? "stopped" : "running"} snapshot`, async ({
    page,
  }) => {
    const server = await createServer({
      ...config,
      configFile: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
      );
      const panel = page.getByRole("region", {
        name: "Local agent controls",
        includeHidden: true,
      });
      const editor = await openEditor(page);
      const stop = editor.getByRole("button", { name: "Stop", exact: true });
      if (previouslyStopped) {
        await stop.click();
        await expect(stop).toBeDisabled();
      }
      await closeEditor(page);
      await openImport(panel);
      await panel
        .getByLabel("Destination community", { exact: true })
        .fill("wss://chosen.example");
      await panel.getByRole("button", { name: "Load agents" }).click();
      await openEditor(page);
      await page.evaluate(() => {
        const fixture = window.agentControlFixture;
        const { snapshot, action } = fixture.host;
        fixture.host.snapshot = async () => {
          throw "Unreadable settings.";
        };
        fixture.host.action = async (id, operation) => {
          if (operation !== "stop") return action(id, operation);
          fixture.calls.push({ action: operation, payload: { id } });
          // Native teardown succeeded, but durable disable failed: no snapshot confirmation.
          fixture.agent.status = "stopped";
          fixture.agent.runningRevision = null;
          throw "Stopped owned process, but could not persist disabled settings.";
        };
        fixture.restoreStore = () =>
          Object.assign(fixture.host, { snapshot, action });
      });
      await page.evaluate(() => window.agentControlFixture.control.refresh());
      await expect(page.getByRole("alert")).toContainText("Could not refresh");
      await expect(stop).toBeEnabled();
      if (previouslyStopped)
        await expect(
          editor.getByRole("button", { name: "Start", exact: true }),
        ).toBeDisabled();
      await expect(
        editor.getByRole("button", { name: "Restart", exact: true }),
      ).toBeDisabled();
      await editor
        .getByRole("textbox", { name: "Agent instructions", exact: true })
        .fill("Keep my recovery draft");
      await expect(
        editor.getByRole("button", { name: "Save changes", exact: true }),
      ).toBeDisabled();
      for (const name of ["Import Fixture agent"]) {
        await expect(
          panel.getByRole("button", { name, exact: true, includeHidden: true }),
        ).toBeDisabled();
      }
      await page.evaluate(() => window.agentControlFixture.control.refresh());
      await expect(page.getByRole("alert")).toContainText("Could not refresh");
      const before = await page.evaluate(() =>
        window.agentControlFixture.calls.filter(
          (call) => call.action !== "snapshot",
        ),
      );
      await stop.click();
      await expect(page.getByRole("alert")).toContainText(
        "could not persist disabled settings",
      );
      await expect(page.getByRole("alert")).toContainText("Could not confirm");
      await expect(
        panel.getByText("The agent statuses below may be out of date."),
      ).toBeVisible();
      if (!previouslyStopped) {
        await expect(
          editor.getByText("Enabled · manual-start only", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          editor.getByText(
            "Last known: Process running · relay readiness unverified",
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        await expect(
          editor.getByText("Process stopped", { exact: true }),
        ).toHaveCount(0);
      }
      await expect(
        editor.getByRole("textbox", {
          name: "Agent instructions",
          exact: true,
        }),
      ).toHaveValue("Keep my recovery draft");
      await expect(
        editor.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await expect(stop).toBeEnabled();
      expect(
        await page.evaluate(() =>
          window.agentControlFixture.calls.filter(
            (call) => call.action !== "snapshot",
          ),
        ),
      ).toEqual([
        ...before,
        { action: "stop", payload: { id: "fixture-agent" } },
      ]);
      // Repairing the host does not implicitly retry. A second explicit Stop can recover.
      await page.evaluate(() => window.agentControlFixture.restoreStore());
      await stop.click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(
        editor.getByText("Process stopped", { exact: true }),
      ).toBeVisible();
      await expect(
        editor.getByText(
          "Manual start · a later sent mention can start this agent",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        editor.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled();
    } finally {
      await server.close();
    }
  });
}

test("unavailable runtime blocks launch and credential import while retaining Stop", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    await page.evaluate(async () => {
      const fixture = window.agentControlFixture;
      fixture.data.runtimeAvailable = false;
      fixture.data.importAvailable = false;
      fixture.data.runtimeMessage = "Execution blocked by native host";
      fixture.agent.status = "stopped";
      fixture.agent.runningRevision = null;
      fixture.agent.enabled = true;
      await fixture.control.refresh();
    });
    const panel = page.getByRole("region", {
      name: "Local agent controls",
      includeHidden: true,
    });
    await closeEditor(page);
    await expect(
      panel
        .getByRole("region", { name: "My agents" })
        .getByText("Execution blocked by native host"),
    ).toBeVisible();
    const editor = await openEditor(page);
    await expect(
      editor.getByRole("button", { name: "Start", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Restart", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Stop", exact: true }),
    ).toBeEnabled();
    await closeEditor(page);
    await openImport(panel);
    await expect(
      panel.getByText(/Import is unavailable in this app session/),
    ).toBeVisible();
    await panel
      .getByLabel("Destination community", { exact: true })
      .fill("wss://chosen.example");
    await panel.getByRole("button", { name: "Load agents" }).click();
    await expect(
      panel.getByRole("button", { name: "Import Fixture agent" }),
    ).toBeDisabled();
    await openEditor(page);
    await editor.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(
      editor.getByText("Process stopped", { exact: true }),
    ).toBeVisible();
    await expect(
      editor.getByText(
        "Manual start · a later sent mention can start this agent",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.filter((call) =>
          ["start", "restart", "import"].includes(call.action),
        ),
      ),
    ).toEqual([]);
  } finally {
    await server.close();
  }
});

test("native-supplied harness choices preserve current values and save only explicit edits", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const editor = await openEditor(page);

    const harness = editor.getByRole("combobox", {
      name: "Harness",
      exact: true,
    });
    const provider = editor.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    const executable = editor.getByRole("textbox", {
      name: "Executable",
      exact: true,
    });
    const model = editor.getByRole("textbox", {
      name: "Model ID (custom or blank)",
      exact: true,
    });
    const prompt = editor.getByRole("textbox", {
      name: "Agent instructions",
      exact: true,
    });
    const save = editor.getByRole("button", { name: "Save changes" });
    const lastSave = () =>
      page.evaluate(
        () =>
          window.agentControlFixture.calls
            .filter((c) => c.action === "save")
            .at(-1).payload,
      );
    const original = await page.evaluate(() =>
      structuredClone(window.agentControlFixture.agent.harness),
    );
    delete original.environmentKeys;
    await expect(executable).toHaveValue("fixture-acp");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("fixture-provider");
    await expect(save).toBeDisabled();
    await prompt.fill("Unrelated edit");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: original,
      environment: {},
    });

    // Selecting either suggestion changes only that field: no implicit args/model/env rewrite.
    await harness.click();
    await page.getByRole("option", { name: "Buzz Agent", exact: true }).click();
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("fixture-provider");
    await provider.click();
    await page
      .getByRole("option", { name: "Databricks v2", exact: true })
      .click();
    await expect(model).toHaveValue(original.model);
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        ...original,
        command: "buzz-agent",
        provider: "databricks_v2",
      },
      environment: {},
    });
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();
    await closeEditor(page);
    await page
      .getByRole("button", { name: "Toggle page", exact: true })
      .click();

    await openEditor(page);
    await expect(harness).toHaveText("Buzz Agent");
    await expect(provider).toHaveText("Databricks v2");
    await expect(save).toBeDisabled();

    // Merely entering custom editing never writes a placeholder or erases the current value.
    await harness.click();
    await page
      .getByRole("option", {
        name: "Custom executable / current value",
        exact: true,
      })
      .click();
    await expect(executable).toHaveValue("buzz-agent");
    await expect(save).toBeDisabled();
    await executable.fill("/custom path/buzz-agent");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("databricks_v2");
    await provider.click();
    await page.getByRole("option", { name: "Not set", exact: true }).click();
    await model.fill("");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        ...original,
        command: "/custom path/buzz-agent",
        model: "",
        provider: "",
      },
      environment: {},
    });
    await expect(executable).toHaveValue("/custom path/buzz-agent");
    await provider.click();
    await page
      .getByRole("option", {
        name: "Custom provider / current value",
        exact: true,
      })
      .click();
    await editor
      .getByLabel("Custom provider", { exact: true })
      .fill("unknown-provider");
    await model.fill("unknown-model");
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("unknown-provider");
    await page.evaluate(async () => {
      window.agentControlFixture.agent.revision++;
      await window.agentControlFixture.control.refresh();
    });
    await expect(save).toBeDisabled();
    await editor.getByRole("button", { name: "Discard changes" }).click();
    await expect(model).toHaveValue("");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("");
    await expect(executable).toHaveValue("/custom path/buzz-agent");

    // Re-read blank selectors plus unknown/absolute command; unrelated saves stay exact.
    await prompt.fill("Blank selectors stay blank");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        ...original,
        command: "/custom path/buzz-agent",
        model: "",
        provider: "",
      },
      environment: {},
    });
    await editor
      .getByLabel("Custom provider", { exact: true })
      .fill("unknown-provider");
    await model.fill("unknown-model");

    const args = ["--custom", "literal space", 'quoted "value"'];
    await editor
      .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
      .fill(JSON.stringify(args));
    await save.click();
    await prompt.fill("Keep unknown values too");
    await save.click();
    expect((await lastSave()).edit).toMatchObject({
      harness: {
        command: "/custom path/buzz-agent",
        args,
        model: "unknown-model",
        provider: "unknown-provider",
      },
      environment: {},
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("harness-dropdown-narrow.png"),
      fullPage: true,
    });
    await expect(
      editor.getByText(/Environment overrides take precedence/),
    ).toBeVisible();
  } finally {
    await server.close();
  }
});

test("editor renders host choices rather than its own catalog, and tolerates an older host", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const editor = await openEditor(page);
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      f.data.harnessOptions = [
        {
          command: "host-command",
          label: "Host harness",
          providers: [{ value: "host-provider", label: "Host provider" }],
        },
      ];
      await f.control.refresh();
    });

    const harness = editor.getByRole("combobox", {
      name: "Harness",
      exact: true,
    });
    const provider = editor.getByRole("combobox", {
      name: "Provider",
      exact: true,
    });
    await harness.click();
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
      "Host harness",
      "Custom executable / current value",
    ]);
    await page
      .getByRole("option", { name: "Host harness", exact: true })
      .click();
    await provider.click();
    await page
      .getByRole("option", { name: "Host provider", exact: true })
      .click();
    await editor.getByRole("button", { name: "Save changes" }).click();
    expect(
      await page.evaluate(() => window.agentControlFixture.agent.harness),
    ).toMatchObject({ command: "host-command", provider: "host-provider" });
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      delete f.data.harnessOptions;
      await f.control.refresh();
    });
    await expect(
      editor.getByRole("textbox", { name: "Executable", exact: true }),
    ).toHaveValue("host-command");
    await expect(
      editor.getByLabel("Custom provider", { exact: true }),
    ).toHaveValue("host-provider");
    await expect(
      editor.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
  } finally {
    await server.close();
  }
});

for (const launch of ["start", "restart"]) {
  for (const lateFailure of [false, true]) {
    test(`${launch} credential wait leaves real Stop buttons usable and ignores late ${lateFailure ? "failure" : "success"}`, async ({
      page,
    }) => {
      const server = await createServer({
        ...config,
        configFile: false,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0, strictPort: false },
      });
      await server.listen();
      try {
        await page.goto(
          `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
        );
        await expect(
          page.getByRole("article", { name: "Agent Fixture agent" }),
        ).toBeVisible();
        await page.evaluate(
          async ({ launch, lateFailure }) => {
            const f = window.agentControlFixture;
            f.agent.enabled = launch === "restart";
            f.agent.status = launch === "restart" ? "running" : "stopped";
            f.data.agents.push({
              ...structuredClone(f.agent),
              id: "other",
              pubkey: "bc".repeat(32),
              name: "Other running agent",
              enabled: true,
              status: "running",
            });
            await f.control.refresh();
            const stale = structuredClone(f.data);
            f.host.action = (id, action) => {
              f.calls.push({ action, payload: { id } });
              if (action !== "stop")
                return new Promise((resolve, reject) => {
                  window.releaseLaunch = () =>
                    lateFailure
                      ? reject("Late cancelled launch")
                      : resolve(stale);
                });
              return new Promise((resolve) => {
                window.releaseStop = () => {
                  const row = f.data.agents.find((agent) => agent.id === id);
                  row.enabled = false;
                  row.status = "stopped";
                  row.runningRevision = null;
                  resolve(structuredClone(f.data));
                };
              });
            };
          },
          { launch, lateFailure },
        );
        const first = await openEditor(page);
        const other = first; // one dialog; target changes only via exact card selection
        const firstStop = first.getByRole("button", {
          name: "Stop",
          exact: true,
        });
        const otherStop = firstStop;
        await first
          .getByRole("button", {
            name: launch === "start" ? "Start" : "Restart",
            exact: true,
          })
          .click();
        await expect
          .poll(() => page.evaluate(() => typeof window.releaseLaunch))
          .toBe("function");
        await expect(firstStop).toBeEnabled(); // even the previously stopped row
        await closeEditor(page);
        await openEditor(page, "Other running agent");
        await expect(otherStop).toBeEnabled();
        await expect(
          other.getByRole("button", { name: "Restart", exact: true }),
        ).toBeDisabled();
        // A different running agent can be stopped without releasing the prompt.
        await otherStop.click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                window.agentControlFixture.calls
                  .filter((call) => call.action === "stop")
                  .at(-1)?.payload.id,
            ),
          )
          .toBe("other");
        await expect(firstStop).toBeDisabled(); // one Stop IPC at a time
        await page.evaluate(() => window.releaseStop());
        await expect(
          other.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          other.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await closeEditor(page);
        await openEditor(page);
        await expect(firstStop).toBeEnabled();
        // Then cancel the pending launch via the real button/projection as well.
        await firstStop.click();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                window.agentControlFixture.calls
                  .filter((call) => call.action === "stop")
                  .at(-1)?.payload.id,
            ),
          )
          .toBe("fixture-agent");
        await page.evaluate(() => window.releaseStop());
        await expect(
          first.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          first.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          first.getByRole("button", { name: "Restart", exact: true }),
        ).toBeDisabled();
        await page.evaluate(() => window.releaseLaunch());
        await expect
          .poll(() =>
            page.evaluate(
              () => window.agentControlFixture.control.snapshot().pendingLaunch,
            ),
          )
          .toBe(null);
        await expect(
          first.getByRole("button", { name: "Restart", exact: true }),
        ).toBeEnabled();
        await expect(
          first.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          first.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await closeEditor(page);
        await openEditor(page, "Other running agent");
        await expect(
          other.getByText("Process stopped", { exact: true }),
        ).toBeVisible();
        await expect(
          other.getByText(
            "Manual start · a later sent mention can start this agent",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page
            .getByRole("region", { name: "Local agent controls" })
            .getByRole("alert"),
        ).toHaveCount(0);
      } finally {
        await server.close();
      }
    });
  }
}

for (const changed of ["destination", "source"]) {
  test(`import ${changed} edits invalidate candidates and fence delayed previews`, async ({
    page,
  }) => {
    const server = await createServer({
      ...config,
      configFile: false,
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    try {
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
      );
      const panel = page.getByRole("region", {
        name: "Local agent controls",
        includeHidden: true,
      });
      await closeEditor(page);
      await openImport(panel);
      const destination = panel.getByLabel("Destination community", {
        exact: true,
      });
      const preview = panel.getByRole("button", {
        name: "Load agents",
      });
      const commit = panel.getByRole("button", {
        name: "Import Fixture agent",
      });
      await expect(destination).toHaveValue("https://relay.example.test");
      await expect(preview).toBeEnabled();
      await destination.fill("wss://first.example");
      await preview.click();
      await expect(commit).toBeEnabled();
      if (changed === "destination")
        await destination.fill("wss://chosen.example");
      else {
        await panel
          .getByRole("combobox", { name: "Source library", exact: true })
          .click();
        await page
          .getByRole("option", { name: "Development Buzz", exact: true })
          .click();
      }
      if (changed === "destination") {
        await expect(commit).toHaveCount(0);
        await preview.click();
      }
      await expect(commit).toBeEnabled();
      expect(
        await page.evaluate(() =>
          window.agentControlFixture.calls.filter(
            (call) => call.action === "import",
          ),
        ),
      ).toEqual([]);
      // Delay the actual host boundary, not a leaf projection helper.
      await page.evaluate(() => {
        const fixture = window.agentControlFixture;
        const original = fixture.host.previewImport;
        fixture.host.previewImport = async (...args) => {
          const result = await original(...args);
          await new Promise((resolve) => {
            fixture.releasePreview = resolve;
          });
          return result;
        };
        fixture.restorePreview = () => {
          fixture.host.previewImport = original;
        };
      });
      await preview.click();
      await expect(preview).toBeDisabled();
      await expect
        .poll(() =>
          page.evaluate(() => typeof window.agentControlFixture.releasePreview),
        )
        .toBe("function");
      // Inputs remain editable during this read-only preview; writes remain blocked.
      if (changed === "destination")
        await destination.fill("wss://final.example");
      else {
        await panel
          .getByRole("combobox", { name: "Source library", exact: true })
          .click();
        await page
          .getByRole("option", { name: "Installed Buzz", exact: true })
          .click();
      }
      await page.evaluate(() => window.agentControlFixture.releasePreview());
      await expect(preview).toBeEnabled();
      await expect(commit).toHaveCount(0);
      await page.evaluate(() => window.agentControlFixture.restorePreview());
      await preview.click();
      await expect(commit).toBeEnabled();
      const expectedDestination =
        changed === "destination"
          ? "wss://final.example"
          : "wss://first.example";
      await expect(
        panel.getByText(`Community: ${expectedDestination}`, { exact: true }),
      ).toBeVisible();
      await commit.click();
      const saved = await page.evaluate(() =>
        window.agentControlFixture.data.agents.at(-1),
      );
      expect(saved.relayUrl).toBe(expectedDestination);
      expect(saved.enabled).toBe(false);
      const calls = await page.evaluate(() => window.agentControlFixture.calls);
      expect(
        calls.filter((call) => call.action === "preview").at(-1).payload,
      ).toEqual({
        source: "installed",
        destination: expectedDestination,
      });
      expect(calls.filter((call) => call.action === "import")).toHaveLength(1);
      expect(
        calls.some(
          (call) => call.action === "start" || call.action === "restart",
        ),
      ).toBe(false);
    } finally {
      await server.close();
    }
  });
}

test("rejected import preview keeps inputs and recovers through Load agents", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const panel = page.getByRole("region", {
      name: "Local agent controls",
      includeHidden: true,
    });
    await closeEditor(page);
    await openImport(panel);
    const destination = panel.getByLabel("Destination community", {
      exact: true,
    });
    const preview = panel.getByRole("button", {
      name: "Load agents",
    });
    await destination.fill("ws://not-supported.example");
    await page.evaluate(() => {
      const fixture = window.agentControlFixture;
      const original = fixture.host.previewImport;
      fixture.host.previewImport = async () => {
        throw "Choose a secure community origin without credentials, path or query";
      };
      fixture.restorePreview = () => {
        fixture.host.previewImport = original;
      };
    });
    await preview.click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Choose a secure community origin" }),
    ).toContainText("Choose a secure community origin");
    await expect(destination).toHaveValue("ws://not-supported.example");
    await expect(preview).toBeEnabled();
    await expect(destination).toBeEnabled();
    await page.evaluate(() => window.agentControlFixture.restorePreview());
    await destination.fill("wss://corrected.example");
    await preview.click();
    await expect(
      panel.getByText("Community: wss://corrected.example", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Import Fixture agent" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() =>
        window.agentControlFixture.calls.some(
          (call) => call.action === "import",
        ),
      ),
    ).toBe(false);
  } finally {
    await server.close();
  }
});

test("card Import opens a focused review and restores focus after dismissal", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.route("**/api/relay/*/agent-inventory", (route) =>
      route.fulfill({ json: { identities: [] } }),
    );
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    await closeEditor(page);
    await page.evaluate(async () => {
      const fixture = window.agentControlFixture;
      fixture.data.parked = [
        {
          pubkey: "cd".repeat(32),
          name: "Selected import",
          sources: ["development"],
        },
      ];
      await fixture.control.refresh();
    });
    const card = page.getByRole("article", { name: "Agent Selected import" });
    await expect(card).toBeVisible();
    // A tall inventory must not put the selected import review below the viewport.
    await page
      .getByRole("region", { name: "My agents" })
      .evaluate((element) => {
        element.style.minHeight = "2500px";
      });
    await card.getByRole("button", { name: "Import", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Import Selected import?",
    });
    await expect(dialog).toBeInViewport();
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Import from another installation" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Import agent" }),
    ).toBeEnabled();
    await expect(
      dialog.getByText("Development Buzz", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Source library")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /Clone|Load agents/ }),
    ).toHaveCount(0);
    await expect(dialog.getByText("Identity", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(
      dialog.getByRole("button", { name: "Import agent" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.screenshot({
      path: testInfo.outputPath("import-healthy.png"),
    });
    await page.setViewportSize({ width: 360, height: 480 });
    await dialog
      .getByRole("button", { name: "Import agent" })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole("button", { name: "Import agent" }),
    ).toBeInViewport();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath("import-narrow.png") });
    await page.setViewportSize({ width: 1440, height: 950 });
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const trigger = card.getByRole("button", { name: "Import", exact: true });
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.evaluate(() => {
      const fixture = window.agentControlFixture;
      const commit = fixture.host.commitImport;
      const gate = new Promise((resolve) => {
        fixture.releaseImport = resolve;
      });
      fixture.host.commitImport = async (...args) => {
        await gate;
        return commit(...args);
      };
    });
    await trigger.click();
    await dialog
      .getByRole("button", { name: "Import agent", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    const local = page.getByRole("article", {
      name: "Agent Fixture agent",
      exact: true,
    });
    await expect(
      local.getByRole("button", { name: "Stop", exact: true }),
    ).toBeEnabled();
    await local.getByRole("button", { name: "Stop", exact: true }).click();
    await page.evaluate(() => window.agentControlFixture.releaseImport());
    // The host's rejection explains the conflicting Stop.
    await expect(dialog.getByRole("alert")).toContainText(
      "Could not confirm the operation",
    );
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await dialog.screenshot({ path: testInfo.outputPath("import-error.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.evaluate(() => window.agentControlFixture.control.refresh());
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .getByRole("article", { name: "Agent Fixture agent", exact: true })
        .filter({
          hasText:
            "npub1ehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxumnwdehxskccvaq",
        }),
    ).toContainText("Process stopped");
  } finally {
    await page
      .evaluate(() => window.agentControlFixture?.releaseImport?.())
      .catch(() => {});
    await server.close();
  }
});

test("inventory keeps current-community tiles and compact rows without repeated detail", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.route("**/api/relay/register", (route) => {
      expect(route.request().postDataJSON()).toEqual({
        url: "https://relay.example.test",
      });
      return route.fulfill({ json: {} });
    });
    await page.route("**/api/relay/*/agent-inventory", (route) =>
      route.fulfill({
        json: { identities: ["ef".repeat(32), "12".repeat(32)] },
      }),
    );
    await page.route("**/api/relay/*/query", (route) => {
      expect(route.request().postDataJSON()).toEqual([
        { kinds: [0], authors: ["ef".repeat(32), "12".repeat(32)], limit: 500 },
      ]);
      return route.fulfill({ json: [] });
    });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    await closeEditor(page);
    await page.evaluate(async () => {
      const fixture = window.agentControlFixture;
      fixture.data.agents.push({
        ...fixture.data.agents[0],
        id: "other-community",
        pubkey: "56".repeat(32),
        name: "Other community agent",
        relayUrl: "wss://other.example",
      });
      fixture.data.parked = [
        {
          pubkey: "cd".repeat(32),
          name: "Research assistant with a longer name",
          sources: ["development"],
        },
        {
          pubkey: "34".repeat(32),
          name: "Release helper",
          sources: ["installed", "development"],
        },
      ];
      await fixture.control.refresh();
    });
    const inventory = page.getByRole("region", {
      name: "My agents",
      exact: true,
    });
    const imports = inventory.getByRole("region", {
      name: "Available to import",
      exact: true,
    });
    const relay = inventory.getByRole("region", {
      name: "Relay-only agents",
      exact: true,
    });
    await expect(imports.getByRole("article")).toHaveCount(2);
    await expect(relay.getByRole("article")).toHaveCount(2);
    await expect(inventory.getByText(/No import source confirmed/)).toHaveCount(
      0,
    );
    await expect(inventory.locator("[data-public-key]:visible")).toHaveCount(0);
    await expect(
      inventory.getByText(
        /Known community:|Found in old Buzz:|Discovery does not import/,
      ),
    ).toHaveCount(0);
    const local = inventory.getByRole("article", {
      name: "Agent Fixture agent",
      exact: true,
    });
    await expect(
      local.getByRole("button", { name: "Stop", exact: true }),
    ).toBeEnabled();
    expect(await local.evaluate((el) => getComputedStyle(el).display)).toBe(
      "flex",
    );
    const other = inventory
      .getByRole("region", {
        name: "Local agents in other communities",
        exact: true,
      })
      .getByRole("article");
    await expect(
      inventory.getByRole("heading", {
        level: 3,
        name: "https://other.example",
        exact: true,
      }),
    ).toBeVisible();
    await expect(other.getByRole("heading", { level: 4 })).toHaveText(
      "Other community agent",
    );
    await expect(relay.getByRole("heading", { level: 3 })).toHaveCount(1);
    await expect(relay.getByRole("region").getByRole("article")).toHaveCount(2);
    await expect(other).toHaveClass(/agent-inventory-row/);
    await expect(
      other.getByText("wss://other.example", { exact: true }),
    ).toHaveCount(0);
    // The app runs this setup, so its row keeps its own lifecycle control.
    await expect(
      other.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(1);
    await expect(
      other.getByRole("button", { name: "Use here", exact: true }),
    ).toHaveCount(0);
    await expect(
      other.getByRole("button", { name: "Clone", exact: true }),
    ).toBeVisible();
    const first = imports.getByRole("article").first();
    const second = imports.getByRole("article").nth(1);
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      const otherBox = await other.boundingBox();
      expect(otherBox.width).toBeGreaterThan(width === 1200 ? 600 : 250);
      const cloneBox = await other
        .getByRole("button", { name: "Clone", exact: true })
        .boundingBox();
      expect(cloneBox.x + cloneBox.width).toBeLessThanOrEqual(
        otherBox.x + otherBox.width,
      );
      const firstBox = await first.boundingBox();
      const secondBox = await second.boundingBox();
      expect(firstBox.x).toBe(secondBox.x);
      expect(firstBox.width).toBe(secondBox.width);
      expect(secondBox.y).toBeGreaterThanOrEqual(firstBox.y + firstBox.height);
      expect(firstBox.height).toBeLessThan(width === 1200 ? 100 : 180);
      expect(
        await inventory.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const relayRow = relay.getByRole("article").first();
      const nameBox = await relayRow.getByRole("heading").boundingBox();
      const detailBox = await relayRow.locator("summary").boundingBox();
      expect(detailBox.x).toBeGreaterThan(nameBox.x + nameBox.width);
      expect(
        Math.abs(
          detailBox.y + detailBox.height / 2 - nameBox.y - nameBox.height / 2,
        ),
      ).toBeLessThan(2);
      await inventory.screenshot({
        path: testInfo.outputPath(`inventory-${width}.png`),
      });
    }
    await other
      .getByLabel("Details for Other community agent", { exact: true })
      .click();
    await expect(
      other.getByRole("button", { name: "Clone", exact: true }),
    ).toBeVisible();
    await expect(other.locator("[data-public-key]")).toBeVisible();
    // Edit, Duplicate and Delete stay reachable for a setup outside this community.
    await expect(
      other.getByRole("button", { name: "Actions for Other community agent" }),
    ).toBeVisible();
    const details = first.getByLabel("Details for Release helper", {
      exact: true,
    });
    await expect(
      imports.getByRole("button", { name: "Clone", exact: true }),
    ).toHaveCount(0);
    await details.click();
    await expect(
      first.getByRole("button", { name: "Clone", exact: true }),
    ).toBeVisible();
    await expect(first.locator("[data-public-key]")).toBeVisible();
    expect(
      await inventory.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await details.click();
    const source = first.getByLabel("Old Buzz installation");
    await expect(
      first.getByRole("button", { name: "Import", exact: true }),
    ).toBeDisabled();
    await source.selectOption("installed");
    await expect(
      first.getByRole("button", { name: "Import", exact: true }),
    ).toBeEnabled();
  } finally {
    await server.close();
  }
});
