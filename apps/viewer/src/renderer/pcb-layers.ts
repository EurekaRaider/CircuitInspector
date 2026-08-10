import type { LayerSummary, Violation } from "./types";

const DEFAULT_FUNCTIONS = [
  "SIGNAL",
  "POWER_GROUND",
  "MIXED",
  "COPPER",
  "SOLDER_MASK",
  "SOLDERMASK",
  "SILK_SCREEN",
  "LEGEND",
  "COMPONENT"
];

export function defaultLayerIds(layers: LayerSummary[], side: "TOP" | "BOTTOM") {
  const profiles = layers.filter((layer) => layer.function.toUpperCase().includes("PROFILE"));
  const surfaceLayers = layers.filter((layer) =>
    layer.side === side
    && DEFAULT_FUNCTIONS.some((value) => layer.function.toUpperCase().includes(value))
  );
  const selected = [...profiles, ...surfaceLayers]
    .map((layer) => layer.id);
  if (selected.length) return [...new Set(selected)];
  return layers.filter((layer) => layer.side === side).map((layer) => layer.id);
}

export function violationHasLocation(violation: Violation | null | undefined) {
  return Boolean(violation && (violation.measured_value_nm != null || violation.evidence_points?.length));
}
