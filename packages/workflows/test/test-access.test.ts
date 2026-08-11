import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalysisSummary, DesignSummary, RulePack, Violation } from "@circuit-inspector/contracts";
import { analyzeTestAccess, type TestPointSnapshot } from "../src/test-access.js";
import { approveManufacturingTestPlan, recommendManufacturingTests } from "../src/test-recommendations.js";
import { confirmLayoutBaseline } from "../src/layout-baseline.js";
import { confirmSchematicPinout, importSchematicPinout } from "../src/wiring.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("approved DFT requirement to Layout test access", () => {
  it("fails an explicit missing physical target and marks an approved virtual method not applicable", async () => {
    const fixture = await controlledFixture();
    const result = await analyzeTestAccess({
      design: design("EXPLICIT"),
      testPoints: [],
      geometryAnalysis: geometry([]),
      rulePack,
      testPlanId: fixture.planId
    }, fixture.cache);

    expect(result.verdict).toBe("FAIL");
    expect(result.mappings.find((item) => item.target_net_names.includes("GND"))?.status).toBe("FAIL");
    expect(result.mappings.find((item) => item.target_net_names.includes("SWDIO"))?.status).toBe("NOT_APPLICABLE");
    expect(result.production_readiness_verdict).toBe("REVIEW");
    expect(result.factory_confirmation_items.every((item) => item.verification_mode === "MANUAL_FACTORY_CONFIRMATION")).toBe(true);
  });

  it("keeps inferred test-point identity in REVIEW", async () => {
    const fixture = await controlledFixture();
    const result = await analyzeTestAccess({
      design: design("INFERRED"),
      testPoints: [point("INFERRED")],
      geometryAnalysis: geometry([]),
      rulePack,
      testPlanId: fixture.planId
    }, fixture.cache);

    expect(result.verdict).toBe("REVIEW");
    expect(result.mappings.find((item) => item.target_net_names.includes("GND"))?.status).toBe("REVIEW");
    expect(result.baseline_checks.some((item) => item.status === "REVIEW")).toBe(true);
  });

  it("passes the static access scope only after the exact ODB++ baseline and semantics are confirmed", async () => {
    const fixture = await controlledFixture();
    const summary = design("EXPLICIT");
    const baseline = await confirmLayoutBaseline({
      design: summary,
      approvedTestPlanId: fixture.planId,
      sourceUnits: "MM",
      coordinateOrigin: "ODB datum at lower-left tooling reference",
      bottomMirroredInTopView: true,
      panelStepRepeat: "UNIT BOARD; no step-repeat",
      approvedBy: "layout-owner"
    }, fixture.cache);
    const result = await analyzeTestAccess({
      design: summary,
      testPoints: [point("EXPLICIT")],
      geometryAnalysis: geometry([]),
      rulePack,
      testPlanId: fixture.planId
    }, fixture.cache);

    expect(result.verdict).toBe("PASS");
    expect(result.layout_baseline_confirmation_id).toBe(baseline.id);
    expect(result.baseline_checks.every((item) => item.status === "PASS")).toBe(true);
    expect(result.production_readiness_verdict).toBe("REVIEW");
  });

  it("keeps a NET match with unknown Top/Bottom identity in REVIEW", async () => {
    const fixture = await controlledFixture();
    const unknownSide = { ...point("EXPLICIT"), layer_id: null, source: "ODBPP:test-point-without-layer" };
    const result = await analyzeTestAccess({
      design: design("EXPLICIT"),
      testPoints: [unknownSide],
      geometryAnalysis: geometry([]),
      rulePack,
      testPlanId: fixture.planId
    }, fixture.cache);

    expect(result.mappings.find((item) => item.target_net_names.includes("GND"))?.status).toBe("REVIEW");
  });

  it("fails an explicit target that violates the approved geometry rule", async () => {
    const fixture = await controlledFixture();
    const violation = geometryViolation();
    const result = await analyzeTestAccess({
      design: design("EXPLICIT"),
      testPoints: [point("EXPLICIT")],
      geometryAnalysis: geometry([violation]),
      rulePack,
      testPlanId: fixture.planId
    }, fixture.cache);

    const mapping = result.mappings.find((item) => item.target_net_names.includes("GND"));
    expect(mapping?.status).toBe("FAIL");
    expect(mapping?.geometry_violation_ids).toContain(violation.id);
  });
});

async function controlledFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-test-access-"));
  temporaryDirectories.push(root);
  const cache = path.join(root, "cache");
  const source = path.join(root, "product.json");
  await writeFile(source, JSON.stringify({ connectors: [{ reference: "J1", pins: [{ number: "1", net: "GND" }, { number: "2", net: "SWDIO" }] }] }), "utf8");
  const product = await importSchematicPinout(source, "PRODUCT", cache, "A");
  await confirmSchematicPinout(product.id, "product-owner", cache);
  const draft = await recommendManufacturingTests(product.id, cache);
  const approved = await approveManufacturingTestPlan(draft.id, {
    approvedBy: "test-owner",
    factory: "Factory A",
    line: "Line 1",
    tester: "ICT-01",
    approvedRulePackId: rulePack.id
  }, cache);
  return { cache, planId: approved.id };
}

function design(testPointCoverage: "EXPLICIT" | "INFERRED"): DesignSummary {
  return {
    id: "design-1",
    format: "ODBPP",
    source_path: "/controlled/layout.tgz",
    content_hash: "design-hash",
    bounds: { min_x: 0, min_y: 0, max_x: 10_000_000, max_y: 10_000_000 },
    layers: [{ id: "top", name: "Top", function: "SIGNAL", side: "TOP", feature_count: 1 }],
    component_count: 1,
    net_count: 2,
    test_point_count: testPointCoverage === "EXPLICIT" ? 1 : 0,
    drill_count: 0,
    semantic_coverage: { layers: "EXPLICIT", nets: "EXPLICIT", components: "EXPLICIT", pins: "EXPLICIT", test_points: testPointCoverage, drills: "EXPLICIT" },
    diagnostics: [],
    cache_hit: true,
    elapsed_ms: 0
  };
}

function point(confidence: "EXPLICIT" | "INFERRED"): TestPointSnapshot {
  return { id: "tp-gnd", center: { x: 2_000_000, y: 2_000_000 }, radius_nm: 300_000, net_name: "GND", component_ref: "TP1", confidence, layer_id: "top", source: "ODBPP", geometry_source: "PAD" };
}

function geometry(violations: Violation[]): AnalysisSummary {
  return { id: "geometry-1", design_id: "design-1", rule_pack_id: rulePack.id, verdict: violations.length ? "FAIL" : "PASS", pass_count: violations.length ? 0 : 1, fail_count: violations.length, review_count: 0, not_applicable_count: 0, violations, report_uri: "circuit://analysis/geometry-1/report", elapsed_ms: 0 };
}

function geometryViolation(): Violation {
  return {
    id: "violation-tp-edge",
    analysis_id: "geometry-1",
    rule_id: "TP-EDGE",
    title: "Test point to edge",
    severity: "ERROR",
    verdict: "FAIL",
    source_format: "ODBPP",
    semantic_confidence: "EXPLICIT",
    net_names: ["GND"],
    component_refs: ["TP1"],
    layer_ids: ["top"],
    x_nm: 2_000_000,
    y_nm: 2_000_000,
    measured_value_nm: 200_000,
    threshold_nm: 500_000,
    message: "Approved clearance violated",
    evidence_points: [{ x: 2_000_000, y: 2_000_000 }],
    evidence_uris: ["circuit://analysis/geometry-1/evidence/violation-tp-edge.png"],
    rule_citation: rulePack.rules[0]!.citation
  };
}

const rulePack: RulePack = {
  id: "rules-factory-a",
  version: "1",
  title: "Factory A ICT access",
  status: "APPROVED",
  rules: [{
    id: "TP-EDGE",
    title: "Test point to board edge",
    kind: "MINIMUM_DISTANCE",
    source: "TEST_POINT",
    target: "BOARD_EDGE",
    metric: "EDGE_TO_EDGE",
    threshold_nm: 500_000,
    severity: "ERROR",
    layer_functions: [],
    same_net_only: false,
    different_net_only: false,
    citation: { source_path: "/controlled/factory-rules.pdf", source_hash: "rule-source-hash", page: 1, paragraph: 1, excerpt: "Approved controlled value" }
  }],
  review_items: [],
  approval: { approved_by: "factory-owner", approved_at: "2026-08-11T00:00:00.000Z", content_hash: "approved-rule-hash" }
};
