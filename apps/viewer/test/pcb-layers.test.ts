import { describe, expect, it } from "vitest";
import { defaultLayerIds, isolatedLayerIds, layerIdsForTestPoint, layerIdsForViolation, testPointFocusZoom, violationFocusZoom, violationHasLocation } from "../src/renderer/pcb-layers";

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

  it("isolates a selected layer while retaining the board profile", () => {
    expect(isolatedLayerIds([...layers], "top-mask")).toEqual(["profile", "top-mask"]);
  });

  it("isolates the source layer for a test-point review", () => {
    expect(layerIdsForTestPoint([...layers], { source: "/steps/pcb/layers/top-signal/features", layer_id: null })).toEqual(["profile", "top-signal", "top-component", "top-mask"]);
    expect(layerIdsForTestPoint([...layers], { source: "/tmp/top-mask", layer_id: null })).toEqual(["profile", "top-signal", "top-component", "top-mask"]);
    expect(layerIdsForTestPoint([...layers], { source: "/tmp/unrelated", layer_id: "top-signal" })).toEqual(["profile", "top-signal", "top-component", "top-mask"]);
  });

  it("uses a readable bounded zoom for test-point targets", () => {
    expect(testPointFocusZoom(250_000)).toBe(160);
    expect(testPointFocusZoom(50_000)).toBe(720);
    expect(testPointFocusZoom(1)).toBe(1200);
  });

  it("isolates violation layers and frames its measurement endpoints", () => {
    const violation = {
      id: "spacing",
      rule_id: "rule",
      title: "Spacing",
      verdict: "REVIEW" as const,
      severity: "WARNING" as const,
      net_names: ["A", "B"],
      component_refs: [],
      layer_ids: ["top-signal"],
      x_nm: 2_000_000,
      y_nm: 1_000_000,
      measured_value_nm: 2_000_000,
      threshold_nm: 3_000_000,
      message: "review",
      evidence_points: [{ x: 1_000_000, y: 1_000_000 }, { x: 3_000_000, y: 1_000_000 }]
    };
    expect(layerIdsForViolation([...layers], violation, [])).toEqual(["profile", "top-signal", "top-component", "top-mask"]);
    expect(violationFocusZoom(violation)).toBe(130);
  });

  it("finds a violation layer from a matching test-point candidate", () => {
    const violation = {
      id: "diameter",
      rule_id: "rule",
      title: "Diameter",
      verdict: "REVIEW" as const,
      severity: "WARNING" as const,
      net_names: ["A"],
      component_refs: ["TP1"],
      layer_ids: [],
      x_nm: 1_000_000,
      y_nm: 2_000_000,
      measured_value_nm: 200_000,
      threshold_nm: 300_000,
      message: "review",
      evidence_points: [{ x: 1_000_000, y: 2_000_000 }]
    };
    const points = [{ id: "tp", center: { x: 1_000_000, y: 2_000_000 }, radius_nm: 100_000, net_name: "A", component_ref: "TP1", confidence: "INFERRED" as const, layer_id: "top-signal", source: "/steps/pcb/layers/top-signal/features", geometry_source: "/steps/pcb/layers/top-signal/features" }];
    expect(layerIdsForViolation([...layers], violation, points)).toEqual(["profile", "top-signal", "top-component", "top-mask"]);
    expect(violationFocusZoom(violation)).toBe(320);
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
