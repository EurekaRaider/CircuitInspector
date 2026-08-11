import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findingVerdictCounts, inferredTestPointsForViolation, reviewRoute } from "../src/renderer/pcb-review";
import { TestPointReviewEvidence } from "../src/renderer/PcbWorkspace";
import type { RuleDefinition, TestPointCandidate, Violation } from "../src/renderer/types";

const baseViolation: Violation = {
  id: "review",
  rule_id: "rule",
  title: "Review",
  verdict: "REVIEW",
  severity: "WARNING",
  net_names: [],
  component_refs: [],
  layer_ids: [],
  x_nm: 0,
  y_nm: 0,
  message: "required semantic target is not identified",
  evidence_points: []
};

const baseRule: RuleDefinition = {
  id: "rule",
  title: "Rule",
  kind: "MINIMUM_DISTANCE",
  source: "TEST_POINT",
  target: "BOARD_EDGE",
  metric: "EDGE_TO_EDGE",
  threshold_nm: 1,
  severity: "WARNING",
  layer_functions: [],
  same_net_only: false,
  different_net_only: false,
  citation: { source_path: "rule.pdf", source_hash: "hash", page: 1, paragraph: 1, excerpt: "rule" }
};

describe("PCB REVIEW routing", () => {
  it("counts the actual finding rows rather than the number of rules", () => {
    expect(findingVerdictCounts([
      { verdict: "REVIEW" },
      { verdict: "REVIEW" },
      { verdict: "FAIL" }
    ])).toEqual({ fail: 1, review: 2 });
  });

  it("routes inferred test-point findings to candidate review", () => {
    const point: TestPointCandidate = { id: "tp", center: { x: 1, y: 2 }, radius_nm: 3, net_name: null, component_ref: "TP1", confidence: "INFERRED", layer_id: null, source: "fixture", geometry_source: "fixture" };
    expect(reviewRoute({ ...baseViolation, message: "required entities are inferred" }, baseRule, [point])).toBe("TEST_POINT_REVIEW");
  });

  it("selects the candidate explicitly referenced by the finding instead of the first inferred point", () => {
    const points: TestPointCandidate[] = [
      { id: "tp-first", center: { x: 1, y: 2 }, radius_nm: 3, net_name: "SENSE", component_ref: "TP1", confidence: "INFERRED", layer_id: "top", source: "fixture", geometry_source: "fixture" },
      { id: "tp-related", center: { x: 3, y: 4 }, radius_nm: 3, net_name: "SENSE", component_ref: "TP2", confidence: "INFERRED", layer_id: "top", source: "fixture", geometry_source: "fixture" }
    ];

    expect(inferredTestPointsForViolation({ ...baseViolation, entity_ids: ["tp-related"] }, points).map((point) => point.id)).toEqual(["tp-related"]);
  });

  it("does not fall back to the first candidate when an overall semantic finding has no point evidence", () => {
    const points: TestPointCandidate[] = [
      { id: "tp-first", center: { x: 1, y: 2 }, radius_nm: 3, net_name: null, component_ref: null, confidence: "INFERRED", layer_id: null, source: "fixture", geometry_source: "fixture" },
      { id: "tp-second", center: { x: 3, y: 4 }, radius_nm: 3, net_name: null, component_ref: null, confidence: "INFERRED", layer_id: null, source: "fixture", geometry_source: "fixture" }
    ];

    expect(inferredTestPointsForViolation(baseViolation, points)).toEqual([]);
  });

  it("does not pretend unsupported semantic targets can be confirmed", () => {
    expect(reviewRoute(baseViolation, { ...baseRule, target: "BGA_CSP" }, [])).toBe("UNSUPPORTED_ENTITY");
  });

  it("routes measured UV glue and candidate tooling-hole geometry to identity review", () => {
    const measured = { ...baseViolation, semantic_confidence: "INFERRED" as const, measured_value_nm: 600_000, evidence_points: [{ x: 1, y: 2 }] };
    expect(reviewRoute(measured, { ...baseRule, target: "UV_GLUE" }, [])).toBe("ENTITY_IDENTITY_REVIEW");
    expect(reviewRoute(measured, { ...baseRule, target: "TOOLING_HOLE" }, [])).toBe("ENTITY_IDENTITY_REVIEW");
  });

  it("routes measured shield candidates to identity review", () => {
    expect(reviewRoute(
      { ...baseViolation, semantic_confidence: "INFERRED", measured_value_nm: 600_000, evidence_points: [{ x: 1, y: 2 }] },
      { ...baseRule, target: "SHIELD_FENCE" },
      []
    )).toBe("ENTITY_IDENTITY_REVIEW");
  });

  it("routes coordinate-free findings to missing-input guidance", () => {
    expect(reviewRoute(baseViolation, { ...baseRule, source: "COMPONENT", target: "BOARD_EDGE" }, [])).toBe("MISSING_SEMANTICS");
  });

  it("shows board-edge and nearest-test-point evidence for manual review", () => {
    const point: TestPointCandidate = {
      id: "tp-a",
      center: { x: 1_000_000, y: 2_000_000 },
      radius_nm: 100_000,
      net_name: "SENSE",
      component_ref: "TP1",
      confidence: "INFERRED",
      layer_id: "top",
      source: "fixture",
      geometry_source: "fixture",
      review_context: {
        metric: "EDGE_TO_EDGE",
        board_edge: { distance_nm: 900_000, point: { x: 0, y: 2_000_000 }, confidence: "EXPLICIT" },
        nearest_test_point: { id: "tp-b", distance_nm: 1_250_000, center: { x: 2_450_000, y: 2_000_000 }, confidence: "INFERRED" },
        nearest_tooling_hole: { id: "drill:4", distance_nm: 2_000_000, center: { x: 3_100_000, y: 2_000_000 }, confidence: "EXPLICIT" },
        nearest_component: { id: "R1", distance_nm: 750_000, center: { x: 1_950_000, y: 2_000_000 }, confidence: "EXPLICIT" },
        nearest_shield: { id: "SH1", distance_nm: 3_500_000, center: { x: 4_600_000, y: 2_000_000 }, confidence: "INFERRED" }
      }
    };
    const markup = renderToStaticMarkup(createElement(TestPointReviewEvidence, { point, locale: "zh-CN" }));
    expect(markup).toContain("最近板边净距");
    expect(markup).toContain("0.900 mm");
    expect(markup).toContain("最近测试点净距 · tp-b");
    expect(markup).toContain("1.250 mm");
    expect(markup).toContain("最近工装孔净距 · drill:4");
    expect(markup).toContain("最近器件净距 · R1");
    expect(markup).toContain("最近屏蔽结构净距 · SH1 · REVIEW");
    expect(markup).toContain("pad_usage 工装孔为明确语义");
  });
});
