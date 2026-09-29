// Installed fixture code only; app composition, manager, contributions and UI remain production.
import * as shortcutCounter from "../../examples/plugins/shortcut-counter/plugin.js";
import shortcutManifest from "../../examples/plugins/shortcut-counter/manifest.json";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { BundledPlugin } from "../../src/plugins/manager";
import type { Navigation } from "../../src/features/navigation/controller";
import type { PageProps } from "../../src/features/pages/service";
import type { PageNavigation } from "../../src/features/navigation/service";
import type { RelayData } from "../../src/features/relay/service";
import type { PanelProps } from "../../src/features/panels/service";
import type { NotificationInput } from "../../src/features/notifications/service";

declare global {
  interface Window {
    stalePanelClose?: () => void;
    fixtureNavigation?: Navigation;
    fixtureNotify?: (input: NotificationInput) => Promise<boolean>;
    fixturePageBroken?: boolean;
    delayFixture?: { started: boolean; release?: () => void };
    stopFixtureDependency?: () => Promise<void>;
    startFixtureDependency?: () => void;
    capturedPendingRequest?: PageNavigation | undefined;
    pendingMounted?: boolean;
    fixtureRelay?: RelayData;
    revocationProbe?: "complete" | "resolve";
    revocationAccepted?: boolean;
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    fixtureConnection: object;
  }
}
function PendingDestination({ navigation }: PageProps) {
  useEffect(() => {
    if (!navigation) return;
    window.capturedPendingRequest = navigation;
    window.pendingMounted = true;
    return () => {
      window.pendingMounted = false;
    };
  }, [navigation]);
  return <p>Pending provider destination</p>;
}
function Notes({ close, target }: PanelProps) {
  const [text, setText] = useState("");
  useEffect(() => {
    window.stalePanelClose = close;
  }, [close]);
  return (
    <label>
      Panel note ({target})
      <input
        aria-label="Panel note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
function Legacy() {
  const [text, setText] = useState("");
  return (
    <label>
      Legacy page draft
      <input
        aria-label="Legacy page draft"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
function RetryPage() {
  const [broken, setBroken] = useState(false);
  if (broken || window.fixturePageBroken)
    throw new Error("Fixture page render failure");
  return (
    <button type="button" onClick={() => setBroken(true)}>
      Break fixture page
    </button>
  );
}
export const fixturePlugins: readonly BundledPlugin[] = [
  {
    manifest: {
      id: "fixture.notifications",
      name: "Notification fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["notifications"],
      apply(ctx) {
        const producer = ctx.notifications.register({
          id: "updates",
          label: "Fixture updates",
        });
        window.fixtureNotify = producer.submit;
      },
    },
  },
  {
    manifest: {
      id: "fixture.dependency",
      name: "Dependency fixture",
      apiVersion: 1,
    },
    module: {
      apply(ctx) {
        const start = () =>
          ctx.plugin((child) => {
            child.provide("fixtureConnection", {});
          });
        let provider = start();
        window.stopFixtureDependency = async () => {
          await provider.dispose();
        };
        window.startFixtureDependency = () => {
          provider = start();
        };
      },
    },
  },
  {
    manifest: { id: "fixture.pending", name: "Pending fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "fixtureConnection", "relay"],
      apply(ctx) {
        window.fixtureRelay = ctx.relay;
        ctx.pages.register({
          id: "pending",
          title: "Pending fixture",
          primary: true,
          handlesNavigation: true,
          component: PendingDestination,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.session", name: "Session fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "relay"],
      apply(ctx) {
        const relay = ctx.relay;
        window.fixtureRelay = relay;
        function SessionPage({ navigation }: PageProps) {
          const connection = useSyncExternalStore(
            relay.subscribe,
            relay.snapshot,
          );
          const bound = navigation?.forSession(relay, connection);
          return connection.status === "ready" ? (
            <PendingDestination
              key={`${connection.scope}:${connection.generation}`}
              navigation={bound}
            />
          ) : (
            <p>Session pending reconnect</p>
          );
        }
        ctx.pages.register({
          id: "session",
          title: "Session fixture",
          primary: true,
          handlesNavigation: true,
          component: SessionPage,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.delayed", name: "Delayed fixture", apiVersion: 1 },
    module: {
      inject: ["pages"],
      async apply(ctx) {
        const gate = window.delayFixture;
        if (gate)
          await new Promise<void>((resolve) => {
            gate.started = true;
            gate.release = resolve;
          });
        ctx.pages.register({
          id: "slow",
          title: "Delayed fixture",
          primary: true,
          component: () => <p>Delayed destination presented</p>,
        });
      },
    },
  },
  { manifest: { ...shortcutManifest, apiVersion: 1 }, module: shortcutCounter },
  {
    manifest: {
      id: "fixture.navigation",
      name: "Navigation fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["pages", "navigation"],
      apply(ctx) {
        window.fixtureNavigation = ctx.navigation;
        // Run in the contribution notification itself, before React unmount cleanup.
        ctx.effect(() =>
          ctx.pages.subscribe(() => {
            const request = window.capturedPendingRequest;
            if (
              !request ||
              !window.revocationProbe ||
              ctx.pages
                .snapshot()
                .some((page) => page.key === "fixture.pending/pending")
            )
              return;
            window.revocationAccepted =
              window.revocationProbe === "complete"
                ? request.complete({ status: "opened" })
                : request.resolve({
                    version: 1,
                    kind: "settings",
                    section: "appearance",
                  });
            delete window.revocationProbe;
          }),
        );
        ctx.pages.register({
          id: "retry",
          title: "Retry fixture",
          primary: true,
          component: RetryPage,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.notes", name: "Notes fixture", apiVersion: 1 },
    module: {
      inject: ["panels", "pages"],
      apply(ctx) {
        // Registered first on purpose: a global resolve(target) launcher bug must hit this instead.
        ctx.panels.register({
          id: "catch-all",
          title: "Wrong panel",
          matches: () => true,
          component: () => <p>Wrong match</p>,
        });
        ctx.panels.register({
          id: "notes",
          title: "Notes",
          matches: () => false,
          launcher: { icon: "/bestie.png", target: "not-an-agent-api" },
          component: Notes,
        });
        ctx.pages.register({
          id: "legacy",
          title: "Legacy",
          primary: true,
          component: Legacy,
        });
      },
    },
  },
];
