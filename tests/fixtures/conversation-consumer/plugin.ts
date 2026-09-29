import type { ChangeEvent } from "react";
import type { Context, RelaySnapshot } from "@buzz/author";

// Test-only external consumer, built into a temporary profile by conversation.spec.mjs.
// Type-only author contract. The installed artifact has no private paths, React
// copy, bundled Channels import, or runtime dependencies.
export const inject = ["react", "pages", "relay", "conversation"];
export function apply(ctx: Context) {
  const React = ctx.react;
  const h = React.createElement;
  const ui = ctx.conversation;
  const relay = ctx.relay;
  function Connected({ connection }: { connection: RelaySnapshot }) {
    const session = connection.session;
    const list = React.useSyncExternalStore(
      session.channels.subscribeList,
      session.channels.list,
      session.channels.list,
    );
    React.useEffect(() => session.channels.ensureList(), [session]);
    const [selected, select] = React.useState("");
    const channel =
      list.channels.find((item) => item.id === selected) ?? list.channels[0];
    return h(
      "section",
      null,
      h(
        "p",
        null,
        "Test-only consumer of the shared session, composer and message UI.",
      ),
      h(
        "label",
        null,
        "Consumer channel",
        h(
          "select",
          {
            value: channel?.id ?? "",
            onChange: (event: ChangeEvent<HTMLSelectElement>) =>
              select(event.target.value),
          },
          list.channels.map((item) =>
            h("option", { key: item.id, value: item.id }, item.name),
          ),
        ),
      ),
      channel
        ? h(Conversation, {
            connection,
            channelId: channel.id,
            channelName: channel.name,
          })
        : h("p", null, list.error ?? "No channels available"),
    );
  }
  function Conversation({
    connection,
    channelId,
    channelName,
  }: {
    connection: RelaySnapshot;
    channelId: string;
    channelName: string;
  }) {
    const [renders, rerender] = React.useState(0);
    React.useEffect(() => {
      const render = () => rerender((value) => value + 1);
      globalThis.addEventListener("conversation-fixture-rerender", render);
      return () =>
        globalThis.removeEventListener("conversation-fixture-rerender", render);
    }, []);
    const session = connection.session;
    const subscribe = React.useCallback(
      (listener: () => void) =>
        session.channels.subscribeWindow(channelId, listener),
      [session, channelId],
    );
    const read = React.useCallback(
      () => session.channels.window(channelId),
      [session, channelId],
    );
    const window = React.useSyncExternalStore(subscribe, read, read);
    React.useEffect(
      () => session.channels.ensure(channelId),
      [session, channelId],
    );
    return h(
      "div",
      null,
      h(
        "button",
        { type: "button", onClick: () => rerender(renders + 1) },
        `Rerender consumer ${renders}`,
      ),
      h(
        "div",
        { "aria-label": "Consumer messages" },
        window.rows.map((row) =>
          h(ui.ui.Message, {
            key: row.id,
            row,
            profile: undefined,
            media: session.media,
            onOpenLink: () => false,
            day: false,
            retry: session.messages.retry,
          }),
        ),
      ),
      h(ui.ui.Composer, {
        session,
        scope: connection.scope ?? "disconnected",
        channelId,
        channelName,
      }),
    );
  }
  ctx.pages.register({
    id: "main",
    title: "Test conversation consumer",
    primary: true,
    component: function Consumer() {
      const connection = React.useSyncExternalStore(
        relay.subscribe,
        relay.snapshot,
        relay.snapshot,
      );
      return h(
        "section",
        { "aria-label": "Test conversation consumer", style: { padding: 24 } },
        h("h1", null, "Test conversation consumer"),
        connection.status === "ready"
          ? h(Connected, {
              key: `${connection.scope}:${connection.generation}`,
              connection,
            })
          : h("p", null, "Waiting for the fixture session."),
      );
    },
  });
}
