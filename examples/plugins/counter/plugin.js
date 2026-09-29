// Prebuilt API v1 module: no build, dependencies, network or filesystem access.
export const inject = ["react", "pages"];

export function apply(ctx) {
  const React = ctx.react;
  ctx.pages.register({
    id: "main",
    title: "Counter playground",
    primary: true,
    component: function Counter() {
      const [count, setCount] = React.useState(0);
      return React.createElement(
        "section",
        {
          className: "ui-card",
          style: { padding: "var(--space-panel-inset)" },
        },
        React.createElement("h1", null, "Counter playground"),
        React.createElement("p", null, "Your local plugin is running. Narf!"),
        React.createElement(
          "button",
          { type: "button", onClick: () => setCount(count + 1) },
          `Clicked ${count} times`,
        ),
        React.createElement(
          "p",
          null,
          "This counter resets when you leave the page. Disable the plugin in Settings to remove it from navigation.",
        ),
      );
    },
  });
}
