import type { PluginModule } from "../../plugins/api";
import { CommunityAdmin } from "./CommunityAdmin";

export const inject = ["relay", "settingsCards"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  // Registered in every build. Native builds cannot mint invites or change
  // members, but the card still shows owners and admins the relay-signed
  // member list and hides those controls itself, so a Settings section,
  // history entry or in-app locator naming it opens instead of failing.
  ctx.settingsCards.register({
    id: "invites",
    title: "Invites",
    group: "Communities",
    component: ({ active }) => <CommunityAdmin relay={relay} active={active} />,
  });
};
