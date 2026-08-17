import type { RuleDefinition, TestPointCandidate, Violation } from "./types";

export type ReviewRoute = "SHIELD_COVERAGE_REVIEW" | "TEST_POINT_REVIEW" | "ENTITY_IDENTITY_REVIEW" | "UNSUPPORTED_ENTITY" | "MISSING_SEMANTICS" | "MEASUREMENT_EVIDENCE";

export function findingVerdictCounts(findings: Array<Pick<Violation, "verdict">>) {
  return findings.reduce((counts, finding) => {
    if (finding.verdict === "FAIL") counts.fail += 1;
    if (finding.verdict === "REVIEW") counts.review += 1;
    return counts;
  }, { fail: 0, review: 0 });
}

const UNSUPPORTED_ENTITIES = new Set(["PANEL_TAB", "BGA_CSP"]);
const INFERRED_IDENTITY_ENTITIES = new Set(["SHIELD_FENCE", "TOOLING_HOLE", "UV_GLUE"]);

export function inferredTestPointsForViolation(violation: Violation, testPoints: TestPointCandidate[]): TestPointCandidate[] {
  const candidates = testPoints.filter((point) => point.confidence === "INFERRED");
  const entityIds = new Set(violation.entity_ids ?? []);
  const entityMatches = candidates.filter((point) => entityIds.has(point.id));
  if (entityMatches.length) return entityMatches;

  const componentRefs = new Set(violation.component_refs);
  const componentMatches = candidates.filter((point) => point.component_ref && componentRefs.has(point.component_ref));
  if (componentMatches.length) return componentMatches;

  const evidencePoints = violation.evidence_points ?? [];
  const coordinateMatches = candidates.filter((point) => evidencePoints.some((evidence) => evidence.x === point.center.x && evidence.y === point.center.y));
  if (coordinateMatches.length) return coordinateMatches;

  const netNames = new Set(violation.net_names);
  const layerIds = new Set(violation.layer_ids);
  return candidates.filter((point) => point.net_name
    && netNames.has(point.net_name)
    && (!point.layer_id || layerIds.size === 0 || layerIds.has(point.layer_id)));
}

export function reviewRoute(violation: Violation, rule: RuleDefinition | undefined, testPoints: TestPointCandidate[]): ReviewRoute {
  if (violation.review?.kind === "SHIELD_COVERAGE_EXCLUSION") return "SHIELD_COVERAGE_REVIEW";
  const entities = [rule?.source, rule?.target].filter((value): value is NonNullable<typeof value> => Boolean(value));
  const normalizedMessage = violation.message.toLocaleLowerCase("en-US");
  if (entities.some((entity) => UNSUPPORTED_ENTITIES.has(entity))) return "UNSUPPORTED_ENTITY";
  if (entities.some((entity) => INFERRED_IDENTITY_ENTITIES.has(entity)) && violation.semantic_confidence === "INFERRED") return "ENTITY_IDENTITY_REVIEW";
  if (entities.includes("TEST_POINT") && (
    normalizedMessage.includes("test-point identity")
    || normalizedMessage.includes("required entities are inferred")
    || violation.semantic_confidence === "INFERRED"
    || inferredTestPointsForViolation(violation, testPoints).length > 0
  )) return "TEST_POINT_REVIEW";
  if (!violation.evidence_points?.length && violation.measured_value_nm == null) return "MISSING_SEMANTICS";
  return "MEASUREMENT_EVIDENCE";
}
