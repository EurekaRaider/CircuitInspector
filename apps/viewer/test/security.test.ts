import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertArtifactId, assertGrantedPath, assertOneOf, assertPathInside, assertRuleDraftUpdate, assertTestPointReviewUpdate, assertViolationReviewUpdate, withArtifactId } from "../src/main/security.js";

describe("viewer IPC security boundaries", () => {
  it("accepts stable IDs and rejects traversal-like artifact identifiers", () => {
    expect(assertArtifactId("analysis_01-a")).toBe("analysis_01-a");
    expect(() => assertArtifactId("../analysis.json")).toThrow(/Invalid/);
    expect(() => withArtifactId({}, "analysis_id")).toThrow(/Invalid/);
  });

  it("only accepts exact paths granted by a file chooser", () => {
    const selected = path.resolve("/tmp/circuit-selected/input.csv");
    const grants = new Set([selected]);
    expect(assertGrantedPath(grants, selected)).toBe(selected);
    expect(() => assertGrantedPath(grants, "/tmp/circuit-selected/other.csv")).toThrow(/not selected/);
  });

  it("keeps evidence opening inside a concrete artifact directory", () => {
    const root = path.resolve("/tmp/circuit-cache/evidence");
    expect(assertPathInside(root, path.join(root, "analysis-a", "report.html"))).toBe(path.join(root, "analysis-a", "report.html"));
    expect(() => assertPathInside(root, root)).toThrow(/inside/);
    expect(() => assertPathInside(root, path.resolve("/tmp/circuit-cache/evidence-copy/report.html"))).toThrow(/inside/);
  });

  it("rejects unexpected enum values crossing IPC", () => {
    expect(assertOneOf("CSV", ["CSV", "JSON"] as const, "format")).toBe("CSV");
    expect(() => assertOneOf("HTML", ["CSV", "JSON"] as const, "format")).toThrow(/Invalid format/);
  });

  it("validates rule draft mutations before they cross IPC", () => {
    const valid = assertRuleDraftUpdate({
      rule_pack_id: "rules-1",
      rules: [{ id: "rule-1" }],
      review_item_resolutions: [{ review_item_id: "review-1", decision: "MODIFY_RULE", note: "Updated threshold", rule_id: "rule-1" }]
    });
    expect(valid.rule_pack_id).toBe("rules-1");
    expect(valid.review_item_resolutions[0]?.decision).toBe("MODIFY_RULE");
    expect(() => assertRuleDraftUpdate({ rule_pack_id: "../rules", rules: [], review_item_resolutions: [] })).toThrow(/Invalid/);
    expect(() => assertRuleDraftUpdate({ rule_pack_id: "rules-1", rules: [{ id: "../rule" }], review_item_resolutions: [] })).toThrow(/Invalid/);
    expect(() => assertRuleDraftUpdate({ rule_pack_id: "rules-1", rules: [], review_item_resolutions: "review-1" })).toThrow(/Invalid/);
    expect(() => assertRuleDraftUpdate({ rule_pack_id: "rules-1", rules: [], review_item_resolutions: [{ review_item_id: "review-1", decision: "SKIP", note: "", rule_id: null }] })).toThrow(/Invalid/);
  });

  it("validates complete inline TP review actions before they cross IPC", () => {
    const valid = assertTestPointReviewUpdate({
      catalog_id: "catalog-1",
      reviewed_by: "dft-owner",
      decisions: [{ candidate_id: "tp-1", review_action: "IGNORE", comment: "Out of scope" }]
    });
    expect(valid.decisions[0]?.review_action).toBe("IGNORE");
    expect(() => assertTestPointReviewUpdate({ ...valid, reviewed_by: "" })).toThrow(/reviewer/);
    expect(() => assertTestPointReviewUpdate({ ...valid, decisions: [{ ...valid.decisions[0], review_action: "SKIP" }] })).toThrow(/action/);
    expect(() => assertTestPointReviewUpdate({ ...valid, decisions: [{ ...valid.decisions[0], candidate_id: "../tp" }] })).toThrow(/Invalid/);
  });

  it("requires an auditable comment when ignoring a shield-coverage review", () => {
    const valid = assertViolationReviewUpdate({
      analysis_id: "analysis-1",
      violation_id: "tp-component:tp-1:SH1",
      decision: "IGNORE",
      comment: "Shield can blocks fixture access on the released assembly.",
      reviewed_by: "dft-owner"
    });
    expect(valid.decision).toBe("IGNORE");
    expect(() => assertViolationReviewUpdate({ ...valid, comment: "" })).toThrow(/comment/);
    expect(assertViolationReviewUpdate({ ...valid, decision: "PASS", comment: "" }).decision).toBe("PASS");
    expect(() => assertViolationReviewUpdate({ ...valid, decision: "FAIL", comment: "" })).toThrow(/comment/);
    expect(() => assertViolationReviewUpdate({ ...valid, decision: "SKIP" })).toThrow(/decision/);
    expect(() => assertViolationReviewUpdate({ ...valid, analysis_id: "../analysis" })).toThrow(/Invalid/);
  });
});
