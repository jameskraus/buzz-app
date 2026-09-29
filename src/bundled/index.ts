import todosManifest from "./todos/manifest.json";
import * as todos from "./todos";
import diffsManifest from "./diffs/manifest.json";
import * as diffs from "./diffs";
import templatesManifest from "./channel-templates/manifest.json";
import * as templates from "./channel-templates";
import namingManifest from "./identity-naming/manifest.json";
import * as naming from "./identity-naming";
import feedbackManifest from "./feedback/manifest.json";
import * as feedback from "./feedback";
import activityManifest from "./agent-activity/manifest.json";
import * as activity from "./agent-activity";
import terminalManifest from "./terminal/manifest.json";
import * as terminal from "./terminal";
import profilesManifest from "./profiles/manifest.json";
import * as profiles from "./profiles";
import mentionsManifest from "./mentions/manifest.json";
import * as mentions from "./mentions";
import emojiManifest from "./emoji/manifest.json";
import * as emoji from "./emoji";
import agentsManifest from "./agents/manifest.json";
import * as agents from "./agents";
import channelsManifest from "./channels/manifest.json";
import githubManifest from "./github/manifest.json";
import * as channels from "./channels";
import * as github from "./github";
import bestieManifest from "./bestie/manifest.json";
import * as bestie from "./bestie";
import inboxManifest from "./inbox/manifest.json";
import * as inbox from "./inbox";
import projectsManifest from "./projects/manifest.json";
import * as projects from "./projects";
import workflowsManifest from "./workflows/manifest.json";
import * as workflows from "./workflows";
import type { BundledPlugin } from "../plugins/manager";
import linksManifest from "./links/manifest.json";
import * as links from "./links";
import hostedManifest from "./hosted-communities/manifest.json";
import * as hosted from "./hosted-communities";
import sessionsManifest from "./sessions/manifest.json";
import * as sessions from "./sessions";
import moderationManifest from "./moderation/manifest.json";
import * as moderation from "./moderation";

export const bundledPlugins: readonly BundledPlugin[] = [
  { manifest: { ...feedbackManifest, apiVersion: 1 }, module: feedback },
  {
    manifest: { ...todosManifest, apiVersion: 1 },
    module: todos,
    enabledByDefault: false,
  },
  { manifest: { ...diffsManifest, apiVersion: 1 }, module: diffs },
  {
    manifest: { ...templatesManifest, apiVersion: 1 },
    module: templates,
    enabledByDefault: false,
  },
  { manifest: { ...namingManifest, apiVersion: 1 }, module: naming },
  { manifest: { ...activityManifest, apiVersion: 1 }, module: activity },
  { manifest: { ...terminalManifest, apiVersion: 1 }, module: terminal },
  { manifest: { ...profilesManifest, apiVersion: 1 }, module: profiles },
  { manifest: { ...linksManifest, apiVersion: 1 }, module: links },
  { manifest: { ...mentionsManifest, apiVersion: 1 }, module: mentions },
  { manifest: { ...emojiManifest, apiVersion: 1 }, module: emoji },
  { manifest: { ...channelsManifest, apiVersion: 1 }, module: channels },
  { manifest: { ...githubManifest, apiVersion: 1 }, module: github },
  { manifest: { ...bestieManifest, apiVersion: 1 }, module: bestie },
  { manifest: { ...inboxManifest, apiVersion: 1 }, module: inbox },
  { manifest: { ...projectsManifest, apiVersion: 1 }, module: projects },
  { manifest: { ...agentsManifest, apiVersion: 1 }, module: agents },
  { manifest: { ...workflowsManifest, apiVersion: 1 }, module: workflows },
  { manifest: { ...sessionsManifest, apiVersion: 1 }, module: sessions },
  { manifest: { ...hostedManifest, apiVersion: 1 }, module: hosted },
  { manifest: { ...moderationManifest, apiVersion: 1 }, module: moderation },
];
