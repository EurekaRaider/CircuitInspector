import { describe, expect, it } from "vitest";
import { approvalBlockers, reviewSuggestion, severityLabel } from "../src/renderer/RuleLibrary.js";
import { selectApprovedRulePack } from "../src/renderer/rule-catalog.js";
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
      message: "Pogo pitch guidance is not a test-point geometry rule.",
      acknowledged: false,
      citation: { source_path: "rules.pdf", source_hash: "hash", page: 1, paragraph: 2, excerpt: "0.3 mm pogo pitch." }
    }],
    approval: null
  };
}

describe("rule-library approval gate", () => {
  it("refreshes the layout-review selection when the approved catalog changes", () => {
    const first = { ...draftPack(), id: "approved-a", status: "APPROVED" as const };
    const second = { ...draftPack(), id: "approved-b", status: "APPROVED" as const };
    expect(selectApprovedRulePack([first, second], second.id)).toBe(second.id);
    expect(selectApprovedRulePack([first], second.id)).toBe(first.id);
    expect(selectApprovedRulePack([draftPack()], first.id)).toBe("");
  });

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

  it("gives a concrete human action for every extraction review code", () => {
    const codes: RulePack["review_items"][number]["code"][] = [
      "RELATIVE_THRESHOLD",
      "AMBIGUOUS_THRESHOLD",
      "NON_EXECUTABLE_GUIDANCE",
      "UNSUPPORTED_TARGET",
      "LEGACY_AUTO_SEVERITY"
    ];
    for (const code of codes) {
      expect(reviewSuggestion(code, "zh-CN").length).toBeGreaterThan(20);
      expect(reviewSuggestion(code, "en-US").length).toBeGreaterThan(20);
    }
    expect(reviewSuggestion("AMBIGUOUS_THRESHOLD", "zh-CN")).toContain("不要猜选");
    expect(reviewSuggestion("NON_EXECUTABLE_GUIDANCE", "zh-CN")).toContain("不转换成自动 PASS/FAIL 规则");
  });
});
