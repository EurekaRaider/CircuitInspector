import { describe, expect, it } from "vitest";
import { approvalBlockers, severityLabel } from "../src/renderer/RuleLibrary.js";
import type { RulePack } from "../src/renderer/types.js";

function draftPack(): RulePack {
  return {
    id: "rules-draft",
    version: "0.2.0-draft",
    title: "Draft rules",
    status: "DRAFT",
    rules: [{
      id: "tp-edge",
      title: "Test point to board edge",
      kind: "MINIMUM_DISTANCE",
      source: "TEST_POINT",
      target: "BOARD_EDGE",
      metric: "EDGE_TO_EDGE",
      threshold_nm: 1_200_000,
      severity: null,
      layer_functions: [],
      same_net_only: false,
      different_net_only: false,
      citation: { source_path: "rules.pdf", source_hash: "hash", page: 1, paragraph: 1, excerpt: "At least 1.2 mm." }
    }],
    review_items: [{
      id: "review-1",
      code: "NON_EXECUTABLE_GUIDANCE",
      message: "Diameter guidance is not an executable spacing rule.",
      acknowledged: false,
      citation: { source_path: "rules.pdf", source_hash: "hash", page: 1, paragraph: 2, excerpt: "0.8 mm diameter." }
    }],
    approval: null
  };
}

describe("rule-library approval gate", () => {
  it("requires every severity and extracted review item to be confirmed", () => {
    const pack = draftPack();
    expect(approvalBlockers(pack)).toEqual(["UNCONFIRMED_SEVERITY", "UNACKNOWLEDGED_REVIEW_ITEM"]);

    pack.rules[0]!.severity = "ERROR";
    pack.review_items[0]!.acknowledged = true;
    expect(approvalBlockers(pack)).toEqual([]);
  });

  it("labels severity as impact after a rule is hit", () => {
    expect(severityLabel(null, "zh-CN")).toBe("待确认");
    expect(severityLabel("ERROR", "zh-CN")).toBe("高（ERROR）");
    expect(severityLabel("WARNING", "en-US")).toBe("Medium (WARNING)");
  });
});
