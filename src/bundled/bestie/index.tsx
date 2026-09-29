import type { PluginModule } from "../../plugins/api";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";

export const inject = ["pages", "panels"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "bestie",
    title: "Bestie",
    layout: "workspace",
    primary: true,
    component: BestiePage,
  });
  ctx.panels.register({
    id: "companion",
    title: "Bestie",
    matches: () => false,
    launcher: { icon: "/bestie.png", target: "" },
    component: Bestie,
  });
};

// Bestie's home page; the companion card shares its body until agent chat connects.
function BestiePage() {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader title="Bestie" />
          <div className="min-h-0 flex-1 overflow-auto">
            <Bestie />
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}

function Bestie() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <img src="/bestie.png" alt="" className="size-20 object-contain" />
      <h2 className="text-heading">Meet your Bestie</h2>
      <p className="max-w-xs text-body-sm text-muted">
        Your companion’s home in Buzz. Agent chat isn’t connected yet.
      </p>
    </div>
  );
}
