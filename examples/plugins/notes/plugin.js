// Prebuilt API v1 module: notes stay in this component's memory, never on disk.
export const inject = ["react", "pages"];

export function apply(ctx) {
  const React = ctx.react;
  ctx.pages.register({
    id: "main",
    title: "Notes playground",
    primary: true,
    component: function Notes() {
      const [note, setNote] = React.useState("");
      return React.createElement(
        "section",
        {
          className: "ui-card",
          style: { padding: "var(--space-panel-inset)" },
        },
        React.createElement("h1", null, "Notes playground"),
        React.createElement(
          "p",
          null,
          "A second independent plugin from the same parent folder. Nothing is sent or saved; leaving this page discards the note.",
        ),
        React.createElement(
          "label",
          null,
          "Scratch note",
          React.createElement("textarea", {
            value: note,
            rows: 5,
            style: {
              display: "block",
              width: "100%",
              marginTop: "var(--space-2)",
            },
            onChange: (event) => setNote(event.target.value),
          }),
        ),
        React.createElement(
          "p",
          { role: "status" },
          `${note.length} characters`,
        ),
      );
    },
  });
}
