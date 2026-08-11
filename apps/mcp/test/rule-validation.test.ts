import { describe, expect, it } from "vitest";
import type { RuleDocumentValidation } from "@circuit-inspector/workflows";
import { ruleValidationText } from "../src/rule-validation.js";

describe("MCP rule-source validation text", () => {
  it("tells an AI exactly where generation failed and how to change the Markdown", () => {
    const validation: RuleDocumentValidation = {
      schema: "CIRCUITINSPECTOR_RULE_SOURCE_V1",
      status: "INVALID",
      diagnostics: [{
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
      }],
      error_count: 1,
      warning_count: 0,
      generation_blocker_count: 1,
      approval_blocker_count: 1
    };

    const text = ruleValidationText(null, 1, validation);

    expect(text).toContain("no rule pack was created");
    expect(text).toContain("RULE_METADATA_MISMATCH");
    expect(text).toContain("/inputs/generated-rules.md:31");
    expect(text).toContain("DFT-TP-001/metric");
    expect(text).toContain("Suggested change: Re-check the PDF");
    expect(text).toContain("call extract_rule_pack again");
  });
});
