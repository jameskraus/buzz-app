import {
  BellIcon,
  BestieIcon,
  BrowserIcon,
  ChatsCircleIcon,
  FolderSimpleIcon,
  GearIcon,
  LightningIcon,
  RobotIcon,
} from "../../shared/design-system/icons/index";
import type { RegisteredPage } from "../../features/pages/service";

// Shell-owned presentation keeps plugin content independent of navigation chrome.
// Add page identities here; unknown plugins inherit a consistent layout default.
export const shellPresentation = {
  settings: { label: "Settings", icon: GearIcon, tone: "lavender" },
  channels: { label: "Messages", icon: ChatsCircleIcon, tone: "lime" },
} as const;

// Navigation order is host policy, never plugin activation timing. Match full
// contribution keys so an external page's local ID cannot claim a bundled slot.
const bundledOrder = [
  "buzz.channels/channels",
  "buzz.inbox/inbox",
  "buzz.bestie/bestie",
  "buzz.projects/projects",
];
export function orderPages(pages: readonly RegisteredPage[]) {
  const rank = (page: RegisteredPage) => {
    const slot = bundledOrder.indexOf(page.key);
    return slot === -1 ? bundledOrder.length : slot;
  };
  return [...pages].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      pagePresentation(a).label.localeCompare(
        pagePresentation(b).label,
        "en",
      ) ||
      a.key.localeCompare(b.key, "en"),
  );
}

const bundledIcons = new Map<string, typeof BrowserIcon>([
  ["buzz.inbox/inbox", BellIcon],
  ["buzz.bestie/bestie", BestieIcon],
  ["buzz.projects/projects", FolderSimpleIcon],
  ["buzz.agents/agents", RobotIcon],
  ["buzz.workflows/workflows", LightningIcon],
]);
export function pagePresentation(page: RegisteredPage) {
  if (page.id === "channels") return shellPresentation.channels;
  return {
    label: page.title,
    icon: bundledIcons.get(page.key) ?? BrowserIcon,
    tone: page.layout === "workspace" ? "lime" : "sky",
  };
}
