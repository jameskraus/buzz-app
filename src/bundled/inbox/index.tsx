import type { PluginModule } from "../../plugins/api";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "inbox",
    title: "Inbox",
    layout: "workspace",
    primary: true,
    component: InboxPage,
  });
};

// A sidebar destination of its own, holding the place until inbox content exists.
function InboxPage() {
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Inbox">
        <div className="flex h-full min-h-0 flex-col">
          <PanelHeader title="Inbox" />
          <div className="grid flex-1 place-items-center p-6 text-body-sm text-muted">
            <p>Content coming soon</p>
          </div>
        </div>
      </FullPageSurface>
    </div>
  );
}
