import type { RuleDefinition, TestPointCandidate, Violation } from "./types";

export type ReviewRoute = "TEST_POINT_REVIEW" | "ENTITY_IDENTITY_REVIEW" | "UNSUPPORTED_ENTITY" | "MISSING_SEMANTICS" | "MEASUREMENT_EVIDENCE";

export function findingVerdictCounts(findings: Array<Pick<Violation, "verdict">>) {
  return findings.reduce((counts, finding) => {
    if (finding.verdict === "FAIL") counts.fail += 1;
    if (finding.verdict === "REVIEW") counts.review += 1;
    return counts;
  }, { fail: 0, review: 0 });
}

const UNSUPPORTED_ENTITIES = new Set(["PANEL_TAB", "BGA_CSP", "UV_GLUE"]);

export function reviewRoute(violation: Violation, rule: RuleDefinition | undefined, testPoints: TestPointCandidate[]): ReviewRoute {
  const entities = [rule?.source, rule?.target].filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (entities.some((entity) => UNSUPPORTED_ENTITIES.has(entity))) return "UNSUPPORTED_ENTITY";
  if (entities.includes("SHIELD_FENCE") && violation.semantic_confidence === "INFERRED") return "ENTITY_IDENTITY_REVIEW";
  if (entities.includes("TEST_POINT") && (
    violation.message.toLocaleLowerCase("en-US").includes("test-point identity")
    || testPoints.some((point) => point.confidence === "INFERRED")
  )) return "TEST_POINT_REVIEW";
  if (!violation.evidence_points?.length && violation.measured_value_nm == null) return "MISSING_SEMANTICS";
  return "MEASUREMENT_EVIDENCE";
}
