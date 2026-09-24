import { expect, it } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import {
  inventoryDecision as decide,
  localHereGroup,
  importGroup,
  localOtherGroup,
  relayGroup,
} from "./inventory-decisions";
import { inventoryIdentities } from "./inventory-model";
import type { AgentView } from "../../features/agents/control";
function inventoryDecision(
  agents: AgentView[],
  communities: string[],
  destination: string,
  oldBuzz: boolean,
) {
  const pubkey = controlFixture().agent.pubkey;
  const rows = inventoryIdentities(
    [{ pubkey, name: "Agent" }],
    new Map(communities.map((community) => [community, [pubkey]])),
    {
      agents,
      parked: oldBuzz
        ? [{ pubkey, name: "Agent", sources: ["installed"] }]
        : [],
    },
    (_key, name) => name,
  );
  const row = rows.get(pubkey);
  if (!row) throw new Error("Missing fixture identity");
  return decide(row, destination);
}
const here = "https://relay.example.test";
const other = "https://other.example";
it("uses local custody and community, independent of process and key readiness", () => {
  const { agent } = controlFixture();
  for (const status of ["running", "stopped", "failed"] as const) {
    const local = { ...agent, status, error: "Key locked" };
    expect(inventoryDecision([local], [], here, false)).toMatchObject({
      group: localHereGroup,
      action: "controls",
    });
    expect(
      inventoryDecision([{ ...local, configured: false }], [], here, false),
    ).toMatchObject({ group: localHereGroup, action: "use" });
  }
  expect(inventoryDecision([], [here], here, false)).toMatchObject({
    group: relayGroup,
    action: "unavailable",
  });
  expect(inventoryDecision([], [other], here, false)).toMatchObject({
    group: relayGroup,
    action: "unavailable",
  });
  expect(
    inventoryDecision([{ ...agent, relayUrl: other }], [], here, false),
  ).toMatchObject({ group: localOtherGroup, action: "clone" });
});
it("uses community sets, with current placement winning without moving other setups", () => {
  const { agent } = controlFixture();
  const local = { ...agent, relayUrl: other };
  expect(inventoryDecision([local], [here, other], here, false)).toMatchObject({
    group: localOtherGroup,
    action: "clone",
  });
  expect(
    inventoryDecision([], [other, other, "https://third.example"], here, false)
      .group,
  ).toEqual(relayGroup);
});
it("does not infer another community or offer actions from missing or stale reads", () => {
  const { agent } = controlFixture();
  expect(inventoryDecision([], [], here, false)).toMatchObject({
    group: relayGroup,
    action: "unavailable",
  });
  for (const destination of [here, ""]) {
    expect(
      inventoryDecision(
        [{ ...agent, relayUrl: other }],
        [other],
        destination,
        false,
      ),
    ).toMatchObject({
      group: localOtherGroup,
      action: "clone",
    });
  }
});

it.each([
  [false, false, false, false],
  [false, false, true, true],
  [false, true, false, false],
  [false, true, true, false],
  [true, false, false, false],
  [true, false, true, true],
  [true, true, false, false],
  [true, true, true, false],
])(
  "Import visibility: community=%s local=%s oldBuzz=%s => %s",
  (community, local, oldBuzz, showImport) => {
    const { agent } = controlFixture();
    const decision = inventoryDecision(
      local ? [agent] : [],
      community ? [here] : [],
      here,
      oldBuzz,
    );
    expect(decision.action === "import").toBe(showImport);
    expect(decision.group).toBe(
      local ? localHereGroup : oldBuzz ? importGroup : relayGroup,
    );
    if (!local && !oldBuzz) {
      expect(decision.action).toBe("unavailable");
      expect(decision.blocked).toBe(
        "No import source has been confirmed. Check any discovery warnings.",
      );
    }
  },
);
