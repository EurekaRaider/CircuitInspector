import { describe, expect, it } from "vitest";
import { approvalBlockers, reviewDecisionLabel, reviewItemResolved, reviewSuggestion, ruleDiagnosticLocation, ruleDiagnosticMessage, ruleDiagnosticSuggestion, severityLabel } from "../src/renderer/RuleLibrary.js";
import { selectApprovedRulePack } from "../src/renderer/rule-catalog.js";
import type { RuleDocumentDiagnostic, RulePack } from "../src/renderer/types.js";

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
      resolution: null,
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
    expect(approvalBlockers(pack)).toEqual(["UNCONFIRMED_SEVERITY", "UNRESOLVED_REVIEW_ITEM"]);

    pack.rules[0]!.severity = "ERROR";
    pack.review_items[0]!.resolution = { decision: "IGNORE", note: "Not applicable to this fixture", rule_id: null };
    expect(approvalBlockers(pack)).toEqual([]);
  });

  it("allows accepting, ignoring, or linking a modified rule while requiring an auditable decision", () => {
    const pack = draftPack();
    const item = pack.review_items[0]!;

    item.resolution = { decision: "ACCEPT_SUGGESTION", note: "", rule_id: null };
    expect(reviewItemResolved(item, pack.rules)).toBe(true);
    item.resolution = { decision: "IGNORE", note: "", rule_id: null };
    expect(reviewItemResolved(item, pack.rules)).toBe(false);
    item.resolution.note = "The controlled product scope excludes this guidance";
    expect(reviewItemResolved(item, pack.rules)).toBe(true);
    item.resolution = { decision: "MODIFY_RULE", note: "Use the product-specific edge threshold", rule_id: null };
    expect(reviewItemResolved(item, pack.rules)).toBe(false);
    item.resolution.rule_id = "tp-edge";
    expect(reviewItemResolved(item, pack.rules)).toBe(true);
    expect(reviewDecisionLabel("IGNORE", "zh-CN")).toBe("忽略建议");
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

  it("shows the shared MCP diagnostic location and suggested change in the active locale", () => {
    const diagnostic: RuleDocumentDiagnostic = {
      id: "rule-diagnostic-1",
      code: "RULE_METADATA_MISMATCH",
      severity: "ERROR",
      blocks_generation: true,
      blocks_approval: true,
      source_path: "/inputs/generated-rules.md",
      page: null,
      line: 31,
      paragraph: null,
      section: "自动几何候选规则",
      rule_id: "DFT-TP-001",
      field: "metric",
      excerpt: "metric: CENTER_TO_CENTER",
      message: "Metric conflicts with the normative sentence.",
      suggestion: "Re-check the PDF and align the sentence and field.",
      message_zh: "距离定义与规范性约束句冲突。",
      suggestion_zh: "重新核对 PDF，使约束句与字段一致。"
    };

    expect(ruleDiagnosticMessage(diagnostic, "zh-CN")).toBe("距离定义与规范性约束句冲突。");
    expect(ruleDiagnosticSuggestion(diagnostic, "en-US")).toContain("align");
    expect(ruleDiagnosticLocation(diagnostic, "zh-CN")).toContain("Markdown 第31行");
    expect(ruleDiagnosticLocation(diagnostic, "zh-CN")).toContain("规则 DFT-TP-001");
    expect(ruleDiagnosticLocation(diagnostic, "en-US")).toContain("field metric");
  });
});
