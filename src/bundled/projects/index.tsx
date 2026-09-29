import type { PluginModule } from "../../plugins/api";
import { parseEntityRoute } from "../../features/projects/routes";
import { ProjectsPage } from "./ProjectsPage";

export const inject = ["pages", "relay", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "projects",
    title: "Projects",
    layout: "workspace",
    primary: true,
    handlesNavigation: true,
    route: {
      version: 1,
      validate: (params) => parseEntityRoute(params) !== null,
    },
    component: (props) => (
      <ProjectsPage {...props} relay={ctx.relay} open={ctx.navigation.open} />
    ),
  });
};
