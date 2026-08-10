import { describe, expect, it } from "vitest";
import { defaultLayerIds, violationHasLocation } from "../src/renderer/pcb-layers";

describe("PCB workspace display defaults", () => {
  it("shows production board layers without documentation and paste layers", () => {
    const ids = defaultLayerIds([
      { id: "top", name: "top", function: "SIGNAL", side: "TOP", feature_count: 1 },
      { id: "paste", name: "paste", function: "SOLDER_PASTE", side: "TOP", feature_count: 1 },
      { id: "fab", name: "fab", function: "DOCUMENT", side: "NA", feature_count: 1 },
      { id: "drill", name: "drill", function: "DRILL", side: "NA", feature_count: 1 }
    ]);
    expect(ids).toEqual(["top", "drill"]);
  });

  it("does not assign a fake board location to semantic review findings", () => {
    expect(violationHasLocation({
      id: "coverage",
      rule_id: "rule",
      title: "Coverage",
      verdict: "REVIEW",
      severity: "WARNING",
      net_names: [],
      component_refs: [],
      layer_ids: [],
      x_nm: 1,
      y_nm: 2,
      message: "missing semantics",
      evidence_points: []
    })).toBe(false);
  });
});
