// Plain JavaScript is already an installable module; no build step needed.
export const inject = ["pages"];
export function apply(ctx) {
  ctx.pages.register({
    id: "broken",
    title: "Broken page",
    primary: true,
    component: BrokenPage,
  });
}

function BrokenPage() {
  throw new Error("Intentional demo failure: this page could not render.");
}
