import type { RuleDefinition, TestPointCandidate, Violation } from "./types";

export type ReviewRoute = "TEST_POINT_REVIEW" | "UNSUPPORTED_ENTITY" | "MISSING_SEMANTICS" | "MEASUREMENT_EVIDENCE";

const UNSUPPORTED_ENTITIES = new Set(["PANEL_TAB", "BGA_CSP", "SHIELD_FENCE", "UV_GLUE"]);

export function reviewRoute(violation: Violation, rule: RuleDefinition | undefined, testPoints: TestPointCandidate[]): ReviewRoute {
  const entities = [rule?.source, rule?.target].filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (entities.some((entity) => UNSUPPORTED_ENTITIES.has(entity))) return "UNSUPPORTED_ENTITY";
  if (entities.includes("TEST_POINT") && (
    violation.semantic_confidence === "INFERRED"
    || violation.message.toLocaleLowerCase("en-US").includes("inferred")
    || testPoints.some((point) => point.confidence === "INFERRED")
  )) return "TEST_POINT_REVIEW";
  if (!violation.evidence_points?.length && violation.measured_value_nm == null) return "MISSING_SEMANTICS";
  return "MEASUREMENT_EVIDENCE";
}
