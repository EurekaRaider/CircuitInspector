import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findingVerdictCounts, reviewRoute } from "../src/renderer/pcb-review";
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
    const point: TestPointCandidate = { id: "tp", center: { x: 1, y: 2 }, radius_nm: 3, net_name: null, component_ref: "TP1", confidence: "INFERRED", source: "fixture" };
    expect(reviewRoute({ ...baseViolation, message: "required entities are inferred" }, baseRule, [point])).toBe("TEST_POINT_REVIEW");
  });

  it("does not pretend unsupported semantic targets can be confirmed", () => {
    expect(reviewRoute(baseViolation, { ...baseRule, target: "BGA_CSP" }, [])).toBe("UNSUPPORTED_ENTITY");
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
      source: "fixture",
      review_context: {
        metric: "EDGE_TO_EDGE",
        board_edge: { distance_nm: 900_000, point: { x: 0, y: 2_000_000 } },
        nearest_test_point: { id: "tp-b", distance_nm: 1_250_000, center: { x: 2_450_000, y: 2_000_000 } }
      }
    };
    const markup = renderToStaticMarkup(createElement(TestPointReviewEvidence, { point, locale: "zh-CN" }));
    expect(markup).toContain("最近板边净距");
    expect(markup).toContain("0.900 mm");
    expect(markup).toContain("最近测试点净距 · tp-b");
    expect(markup).toContain("1.250 mm");
    expect(markup).toContain("边缘到边缘；由导入几何计算");
  });
});
