import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import * as gatewayIcons from "../../../../src/shared/design-system/icons/index";
import {
  createIconInventory,
  CUSTOM_ICONS,
  PHOSPHOR_ICONS,
} from "../../../../src/shared/design-system/icons/inventory";

it("derives the complete categorized inventory from the public gateway", () => {
  const phosphorNames = PHOSPHOR_ICONS.map(({ name }) => name);
  const customNames = CUSTOM_ICONS.map(({ name }) => name);

  expect(customNames).toEqual([
    "BestieIcon",
    "GitHubIssueIcon",
    "OneDriveLogoIcon",
  ]);
  expect([...phosphorNames, ...customNames].sort()).toEqual(
    Object.keys(gatewayIcons).sort(),
  );
  expect(phosphorNames).toEqual(
    [...phosphorNames].sort((a, b) => a.localeCompare(b)),
  );
  expect(CUSTOM_ICONS).toEqual([
    expect.objectContaining({
      name: "BestieIcon",
      category: "Product mark",
      intendedSizes: [
        { width: 15, height: 15 },
        { width: 17, height: 17 },
      ],
    }),
    expect.objectContaining({
      name: "GitHubIssueIcon",
      category: "Product mark",
      intendedSizes: [{ width: 22, height: 22 }],
    }),
    expect.objectContaining({
      name: "OneDriveLogoIcon",
      category: "Custom brand mark",
      intendedSizes: [{ width: 14, height: 14 }],
    }),
  ]);
});

it("fails loudly rather than classifying an unapproved gateway export", () => {
  const UnclassifiedIcon = () => createElement("svg", { role: "img" });

  expect(() =>
    createIconInventory({ ...gatewayIcons, UnclassifiedIcon }),
  ).toThrowError("Unclassified icon gateway export: UnclassifiedIcon");
  expect(renderToStaticMarkup(createElement(UnclassifiedIcon))).not.toContain(
    'aria-hidden="true"',
  );
});

it("keeps every classified gateway icon decorative by default", () => {
  for (const Icon of Object.values(gatewayIcons)) {
    expect(renderToStaticMarkup(createElement(Icon))).toContain(
      'aria-hidden="true"',
    );
  }
});
