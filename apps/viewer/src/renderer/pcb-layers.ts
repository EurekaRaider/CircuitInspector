import type { LayerSummary, Violation } from "./types";

const DEFAULT_FUNCTIONS = [
  "PROFILE",
  "SIGNAL",
  "POWER_GROUND",
  "MIXED",
  "COPPER",
  "DRILL",
  "SOLDER_MASK",
  "SOLDERMASK",
  "SILK_SCREEN",
  "LEGEND",
  "COMPONENT"
];

export function defaultLayerIds(layers: LayerSummary[]) {
  const selected = layers
    .filter((layer) => DEFAULT_FUNCTIONS.some((value) => layer.function.toUpperCase().includes(value)))
    .map((layer) => layer.id);
  return selected.length ? selected : layers.map((layer) => layer.id);
}

export function violationHasLocation(violation: Violation | null | undefined) {
  return Boolean(violation && (violation.measured_value_nm != null || violation.evidence_points?.length));
}
