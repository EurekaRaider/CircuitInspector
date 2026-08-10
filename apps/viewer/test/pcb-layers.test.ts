import { describe, expect, it } from "vitest";
import { defaultLayerIds, violationHasLocation } from "../src/renderer/pcb-layers";

describe("PCB workspace display defaults", () => {
  const layers = [
    { id: "profile", name: "profile", function: "PROFILE", side: "NA", feature_count: 1 },
    { id: "top-signal", name: "top-signal", function: "SIGNAL", side: "TOP", feature_count: 1 },
    { id: "top-component", name: "top-component", function: "COMPONENT", side: "TOP", feature_count: 1 },
    { id: "top-mask", name: "top-mask", function: "SOLDER_MASK", side: "TOP", feature_count: 1 },
    { id: "bottom-signal", name: "bottom-signal", function: "SIGNAL", side: "BOTTOM", feature_count: 1 },
    { id: "bottom-component", name: "bottom-component", function: "COMPONENT", side: "BOTTOM", feature_count: 1 },
    { id: "inner", name: "inner", function: "SIGNAL", side: "INNER", feature_count: 1 },
    { id: "paste", name: "paste", function: "SOLDER_PASTE", side: "TOP", feature_count: 1 },
    { id: "fab", name: "fab", function: "DOCUMENT", side: "NA", feature_count: 1 },
    { id: "drill", name: "drill", function: "DRILL", side: "NA", feature_count: 1 }
  ] as const;

  it("shows only the top surface and board profile by default", () => {
    expect(defaultLayerIds([...layers], "TOP")).toEqual([
      "profile",
      "top-signal",
      "top-component",
      "top-mask"
    ]);
  });

  it("switches the default selection to the bottom surface", () => {
    expect(defaultLayerIds([...layers], "BOTTOM")).toEqual([
      "profile",
      "bottom-signal",
      "bottom-component"
    ]);
  });

  it("does not fall back to stacking inner layers", () => {
    expect(defaultLayerIds([
      { id: "inner-1", name: "inner-1", function: "SIGNAL", side: "INNER", feature_count: 1 },
      { id: "inner-2", name: "inner-2", function: "POWER_GROUND", side: "INNER", feature_count: 1 }
    ], "TOP")).toEqual([]);
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
