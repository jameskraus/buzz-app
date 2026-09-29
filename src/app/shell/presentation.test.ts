import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { BellIcon, BrowserIcon } from "../../shared/design-system/icons/index";
import { orderPages, pagePresentation } from "./presentation";

function page(key: string, title: string): RegisteredPage {
  const separator = key.indexOf("/");
  const pluginId = key.slice(0, separator);
  const id = key.slice(separator + 1);
  return {
    key,
    pluginId,
    id,
    title,
    revision: "bundled",
    component: () => null,
  };
}

const messages = page("buzz.channels/channels", "Channels");
const inbox = page("buzz.inbox/inbox", "Inbox");
const bestie = page("buzz.bestie/bestie", "Bestie");
const projects = page("buzz.projects/projects", "Projects");

test("bundled page order ignores activation order without mutating the registry", () => {
  const input = Object.freeze([projects, bestie, messages, inbox]);
  expect(orderPages(input)).toEqual([messages, inbox, bestie, projects]);
  expect(input).toEqual([projects, bestie, messages, inbox]);
  expect(orderPages([messages, projects])).toEqual([messages, projects]);
  expect(orderPages([projects])).toEqual([projects]);
  expect(orderPages([])).toEqual([]);
});

test("other pages sort by label then full key and cannot claim bundled slots", () => {
  const alpha = page("example.alpha/page", "Alpha");
  const alpha2 = page("example.other/page", "Alpha");
  const foreignInbox = page("example.mail/inbox", "Inbox");
  const sameId = page("example.custom/projects", "Projects");
  const zulu = page("example.zulu/page", "Zulu");
  const expected = [
    messages,
    inbox,
    bestie,
    projects,
    alpha,
    alpha2,
    foreignInbox,
    sameId,
    zulu,
  ];
  expect(orderPages([...expected].reverse())).toEqual(expected);
  expect(
    orderPages([
      sameId,
      projects,
      alpha2,
      bestie,
      zulu,
      foreignInbox,
      messages,
      inbox,
      alpha,
    ]),
  ).toEqual(expected);
});

test("bundled pages get their own icons and Bestie's row shows its artwork", () => {
  expect(pagePresentation(inbox).icon).toBe(BellIcon);
  expect(
    renderToStaticMarkup(
      createElement(pagePresentation(bestie).icon, { size: 15 }),
    ),
  ).toContain("/bestie.png");
  expect(pagePresentation(page("example.mail/inbox", "Inbox")).icon).toBe(
    BrowserIcon,
  );
});
