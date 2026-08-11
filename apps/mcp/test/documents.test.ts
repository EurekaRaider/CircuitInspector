import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractRulePack, extractRulePackWithValidation } from "../src/documents.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("rule document extraction", () => {
  it("creates an auditable draft and never silently approves it", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.resolve("docs/rules/fixture-rule.md");
    const result = await extractRulePack([fixture], cache, "Fixture rules");

    expect(result.rulePack.status).toBe("DRAFT");
    expect(result.rulePack.approval).toBeNull();
    expect(result.ruleCount).toBe(2);
    expect(result.rulePack.rules.map((rule) => rule.threshold_nm)).toEqual([500_000, 150_000]);
    expect(result.rulePack.rules.every((rule) => rule.severity === null)).toBe(true);
    expect(result.rulePack.rules.every((rule) => rule.citation.source_hash.length === 64)).toBe(true);

    const index = JSON.parse(await readFile(result.ragIndexPath, "utf8")) as { passages: unknown[] };
    expect(index.passages.length).toBeGreaterThan(0);
  });

  it("extracts test-point diameter candidates without confusing pogo pitch and keeps conditional alternatives in review", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "factory-guidance.md");
    await writeFile(fixture, [
      "Keep a 1/2 diameter gap for test points smaller than 0.5 mm diameter.",
      "0.8 mm diameter test points are widely used where there is space.",
      "0.55 mm diameter test points have been validated with a 0.3 mm~0.35 mm pitch blade pogo module.",
      "Engineering test points can use either 0.4 mm diameter or 0.2 mm diameter depending on the product.",
      "An unrelated board outline example is 10 mm by 20 mm.",
      "Test point edge to board edge requires at least 1.2 mm clearance.",
      "Keep at least 2 mm from the test point edge to the tooling hole edge.",
      "Test point edge to panel tab edge requires 4 mm clearance."
    ].join("\n\n"), "utf8");

    const result = await extractRulePack([fixture], cache, "Factory guidance");

    expect(result.rulePack.rules.map((rule) => ({ kind: rule.kind, target: rule.target, threshold: rule.threshold_nm }))).toEqual([
      { kind: "MINIMUM_DIAMETER", target: null, threshold: 800_000 },
      { kind: "MINIMUM_DIAMETER", target: null, threshold: 550_000 },
      { kind: "MINIMUM_DISTANCE", target: "BOARD_EDGE", threshold: 1_200_000 },
      { kind: "MINIMUM_DISTANCE", target: "TOOLING_HOLE", threshold: 2_000_000 },
      { kind: "MINIMUM_DISTANCE", target: "PANEL_TAB", threshold: 4_000_000 }
    ]);
    expect(result.rulePack.rules.every((rule) => rule.severity === null)).toBe(true);
    expect(result.rulePack.review_items.map((item) => item.code)).toEqual([
      "RELATIVE_THRESHOLD",
      "AMBIGUOUS_THRESHOLD"
    ]);
    expect(result.rulePack.review_items.every((item) => item.acknowledged === false)).toBe(true);
  });

  it("extracts concrete keep-out baselines even when the prose repeats a value or names a specialized target", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "specific-clearances.md");
    await writeFile(fixture, [
      "Test point edge to board edge: make sure 1.2 mm keep-out; less than 1.2 mm is high risk.",
      "Test point edge to BGA and CSP outline requires 2.5 mm keep-out.",
      "Suggest having 0.6 mm keep-out between the test point and shielding fence outline.",
      "If UV dispensing is close to the test point, it requires a 0.5 mm gap from the test point edge to the UV glue edge."
    ].join("\n\n"), "utf8");

    const result = await extractRulePack([fixture], cache, "Specific clearances");

    expect(result.rulePack.rules.map((rule) => [rule.target, rule.threshold_nm])).toEqual([
      ["BOARD_EDGE", 1_200_000],
      ["BGA_CSP", 2_500_000],
      ["SHIELD_FENCE", 600_000],
      ["UV_GLUE", 500_000]
    ]);
    expect(result.rulePack.review_items).toEqual([]);
  });

  it("accepts a complete model-generated rule-source template and returns a clean validation result", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "generated-rules.md");
    await writeFile(fixture, strictRuleSource(), "utf8");

    const result = await extractRulePackWithValidation([fixture], cache, "Generated rules");

    expect(result.rulePack).not.toBeNull();
    expect(result.validation).toMatchObject({
      schema: "CIRCUITINSPECTOR_RULE_SOURCE_V1",
      status: "VALID",
      error_count: 0,
      warning_count: 0,
      generation_blocker_count: 0,
      approval_blocker_count: 0
    });
    expect(result.rulePack?.rules[0]).toMatchObject({
      kind: "MINIMUM_DISTANCE",
      source: "TEST_POINT",
      target: "TEST_POINT",
      metric: "EDGE_TO_EDGE",
      threshold_nm: 500_000
    });
  });

  it("returns located actionable diagnostics and no pack for an incomplete template", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "incomplete-rules.md");
    await writeFile(fixture, [
      "# <规则源文档标题>",
      "",
      "## 1. 受控来源",
      "",
      "- `rule_source_schema`: `CIRCUITINSPECTOR_RULE_SOURCE_V1`",
      "- `source_pdf`: `UNKNOWN`",
      "- `conversion_status`: `APPROVED`"
    ].join("\n"), "utf8");

    const result = await extractRulePackWithValidation([fixture], cache, "Incomplete rules");
    const codes = result.validation.diagnostics.map((diagnostic) => diagnostic.code);

    expect(result.rulePack).toBeNull();
    expect(result.validation.status).toBe("INVALID");
    expect(codes).toContain("TEMPLATE_SECTION_MISSING");
    expect(codes).toContain("TEMPLATE_FIELD_MISSING");
    expect(codes).toContain("TEMPLATE_PLACEHOLDER_REMAINS");
    expect(codes).toContain("SOURCE_PDF_REQUIRED");
    expect(codes).toContain("CONVERSION_STATUS_INVALID");
    expect(codes).toContain("NO_EXECUTABLE_RULES");
    expect(result.validation.diagnostics.every((diagnostic) => diagnostic.source_path === fixture)).toBe(true);
    expect(result.validation.diagnostics.some((diagnostic) => diagnostic.line !== null && diagnostic.suggestion.length > 20)).toBe(true);
    expect(JSON.parse(await readFile(result.ragIndexPath, "utf8"))).toHaveProperty("validation.status", "INVALID");
  });

  it("blocks generation when rule metadata disagrees with the PDF-backed normative sentence", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "mismatched-rules.md");
    await writeFile(fixture, strictRuleSource({ kind: "MINIMUM_WIDTH", source: "COPPER", target: "NONE", metric: "NONE" }), "utf8");

    const result = await extractRulePackWithValidation([fixture], cache, "Mismatched rules");
    const mismatches = result.validation.diagnostics.filter((diagnostic) => diagnostic.code === "RULE_METADATA_MISMATCH");

    expect(result.rulePack).toBeNull();
    expect(mismatches.map((diagnostic) => diagnostic.field)).toEqual(["kind", "source", "target", "metric"]);
    expect(mismatches.every((diagnostic) => diagnostic.rule_id === "DFT-TP-001" && diagnostic.blocks_generation)).toBe(true);
  });

  it("blocks a contiguous value and unit in the non-automated section before legacy extraction can misclassify it", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "unsafe-review-rules.md");
    const content = strictRuleSource({ manualLine: "测试点到板边距离不得低于 0.40 mm。" });
    await writeFile(fixture, content, "utf8");

    const result = await extractRulePackWithValidation([fixture], cache, "Unsafe review rules");
    const diagnostic = result.validation.diagnostics.find((item) => item.code === "UNSAFE_NON_AUTOMATED_THRESHOLD");
    const expectedLine = content.split("\n").findIndex((line) => line.includes("0.40 mm")) + 1;

    expect(result.rulePack).toBeNull();
    expect(diagnostic).toMatchObject({ line: expectedLine, blocks_generation: true, field: "source_value_tokens" });
    expect(diagnostic?.suggestion).toContain("VALUE=0.5; UNIT=mm");
  });
});

function strictRuleSource(overrides: {
  kind?: string;
  source?: string;
  target?: string;
  metric?: string;
  manualLine?: string;
} = {}) {
  return [
    "# Factory DFT rule source",
    "",
    "## 1. 受控来源",
    "",
    "- `rule_source_schema`: `CIRCUITINSPECTOR_RULE_SOURCE_V1`",
    "- `source_pdf`: `factory-rules.pdf`",
    "- `source_sha256`: `UNKNOWN`",
    "- `document_id`: `FACTORY-DFT`",
    "- `document_revision`: `A`",
    "- `document_title`: `Factory DFT rules`",
    "- `effective_date`: `UNKNOWN`",
    "- `project`: `PROJECT-A`",
    "- `product_revisions`: `A1`",
    "- `factory`: `SZ01`",
    "- `tester_or_fixture`: `ICT01`",
    "- `authority_tier`: `PROJECT_FACTORY_TESTER`",
    "- `conversion_model`: `fixture-model`",
    "- `conversion_time`: `2026-08-11T00:00:00Z`",
    "- `conversion_status`: `DRAFT_SOURCE`",
    "",
    "### 1.1 适用范围原文",
    "",
    "PROJECT-A revision A1 at SZ01.",
    "",
    "### 1.2 术语与测量定义",
    "",
    "Test-point spacing is measured edge to edge.",
    "",
    "## 2. 自动几何候选规则",
    "",
    "### DFT-TP-001 Test point edge spacing",
    "",
    "[SOURCE pdf=\"factory-rules.pdf\" page=\"12\" clause=\"4.2\"] 测试点边缘间距不得低于 0.50 mm。",
    "",
    "- `verification_mode`: `AUTOMATED_GEOMETRY`",
    `- \`kind\`: \`${overrides.kind ?? "MINIMUM_DISTANCE"}\``,
    `- \`source\`: \`${overrides.source ?? "TEST_POINT"}\``,
    `- \`target\`: \`${overrides.target ?? "TEST_POINT"}\``,
    `- \`metric\`: \`${overrides.metric ?? "EDGE_TO_EDGE"}\``,
    "- `layer_functions`: `ANY`",
    "- `net_relation`: `ANY`",
    "- `applicability`: `DOCUMENT_SCOPE`",
    "- `source_severity`: `UNCONFIRMED`",
    "- `source_fidelity`: `EXACT_TEXT`",
    "- `review_note`: `NONE`",
    "",
    "## 3. 待人工复核候选",
    "",
    "NONE",
    "",
    "## 4. 不进入自动规则包的要求和不安全候选",
    "",
    overrides.manualLine ?? "NONE",
    "",
    "## 5. 转换完整性与冲突清单",
    "",
    "- `pages_processed`: `ALL`",
    "- `pages_unreadable`: `NONE`",
    "- `tables_reconstructed`: `NONE`",
    "- `cross_page_dependencies`: `NONE`",
    "- `conflicts_found`: `NONE`",
    "- `omitted_passages`: `NONE`",
    "- `model_assumptions`: `NONE`",
    "",
    "## 6. 生成后自检",
    "",
    "- [x] Source and template checks complete."
  ].join("\n");
}
