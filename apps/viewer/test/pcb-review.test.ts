import { describe, expect, it } from "vitest";
import { reviewRoute } from "../src/renderer/pcb-review";
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
});
