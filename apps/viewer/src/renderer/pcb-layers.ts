import type { LayerSummary, TestPointCandidate, Violation } from "./types";

const SHARED_CONTEXT_FUNCTIONS = ["PROFILE", "BOARD", "ROUT", "DRILL", "TOOL", "PANEL"];

export function defaultLayerIds(layers: LayerSummary[], side: "TOP" | "BOTTOM") {
  const sharedContext = layers.filter((layer) => layer.side === "NA" && SHARED_CONTEXT_FUNCTIONS.some((value) => layer.function.toUpperCase().includes(value)));
  const surfaceLayers = layers.filter((layer) => layer.side === side);
  const selected = [...sharedContext, ...surfaceLayers]
    .map((layer) => layer.id);
  return [...new Set(selected)];
}

export function isolatedLayerIds(layers: LayerSummary[], layerId: string) {
  const profiles = layers
    .filter((layer) => layer.function.toUpperCase().includes("PROFILE"))
    .map((layer) => layer.id);
  return [...new Set([...profiles, layerId])];
}

export function layerIdsForTestPoint(layers: LayerSummary[], point: Pick<TestPointCandidate, "source" | "layer_id">) {
  const declared = point.layer_id && layers.some((layer) => layer.id === point.layer_id)
    ? [point.layer_id]
    : [];
  if (declared.length) return layerIdsWithSurfaceContext(layers, declared);
  const source = point.source.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  const segments = source.split("/");
  const matches = layers.filter((layer) => {
    const name = layer.name.toLocaleLowerCase("en-US");
    const id = layer.id.toLocaleLowerCase("en-US");
    return segments.includes(name)
      || source.includes(`/layers/${name}/`)
      || source.startsWith(`manual:${id}:`);
  });
  if (!matches.length) return [];
  return layerIdsWithSurfaceContext(layers, matches.map((layer) => layer.id));
}

export function testPointFocusZoom(radiusNm: number | null) {
  const radiusMm = Math.max(0.01, (radiusNm ?? 250_000) / 1_000_000);
  return Math.round(Math.min(1200, Math.max(160, 36 / radiusMm)));
}

export function layerIdsForViolation(layers: LayerSummary[], violation: Violation, testPoints: TestPointCandidate[]) {
  const declared = layers
    .filter((layer) => violation.layer_ids.includes(layer.id))
    .map((layer) => layer.id);
  const evidence = violation.evidence_points ?? [];
  const matchingPoint = testPoints.find((point) => evidence.some((candidate) =>
    candidate.x === point.center.x && candidate.y === point.center.y
  ));
  const inferred = matchingPoint ? layerIdsForTestPoint(layers, matchingPoint) : [];
  return layerIdsWithSurfaceContext(layers, [...declared, ...inferred]);
}

function layerIdsWithSurfaceContext(layers: LayerSummary[], sourceLayerIds: string[]) {
  const selected = new Set(sourceLayerIds);
  for (const layer of layers) {
    if (layer.function.toUpperCase().includes("PROFILE")) selected.add(layer.id);
  }
  const sides = new Set(layers
    .filter((layer) => selected.has(layer.id) && (layer.side === "TOP" || layer.side === "BOTTOM"))
    .map((layer) => layer.side as "TOP" | "BOTTOM"));
  for (const side of sides) {
    for (const layerId of defaultLayerIds(layers, side)) selected.add(layerId);
  }
  return layers.filter((layer) => selected.has(layer.id)).map((layer) => layer.id);
}

export function violationFocusZoom(violation: Violation) {
  const points = violation.evidence_points ?? [];
  if (points.length >= 2) {
    const widthMm = (Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x))) / 1_000_000;
    const heightMm = (Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))) / 1_000_000;
    const spanMm = Math.max(widthMm, heightMm, 0.05);
    return Math.round(Math.min(320, Math.max(80, 260 / spanMm)));
  }
  const markerNm = violation.measured_value_nm ?? violation.threshold_nm ?? 250_000;
  return Math.min(320, testPointFocusZoom(Math.max(1, markerNm / 2)));
}

export function violationHasLocation(violation: Violation | null | undefined) {
  return Boolean(violation && (violation.measured_value_nm != null || violation.evidence_points?.length));
}
