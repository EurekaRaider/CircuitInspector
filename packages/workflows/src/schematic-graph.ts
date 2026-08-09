import { createHash } from "node:crypto";
import type {
  Diagnostic,
  SchematicComponent,
  SchematicComponentKind,
  SchematicDocument,
  SchematicEvidence,
  SchematicGraphEdge,
  SchematicGraphPin,
  SchematicInterfaceCandidate,
  SchematicNet,
  SchematicPath
} from "@circuit-inspector/contracts";

const CONNECTOR_RE = /^(?:J|P|CN|X|CONN)\d+[A-Z0-9_-]*$/i;
const IC_RE = /^(?:U|IC|MCU|FPGA)\d+[A-Z0-9_-]*$/i;
const PASSIVE_RE = /^(?:R|C|L|FB|F|FL|NTC|PTC)\d+[A-Z0-9_-]*$/i;
const PROTECTION_RE = /^(?:D|TVS|ESD|Q)\d+[A-Z0-9_-]*$/i;

export function classifySchematicComponent(refdes: string): SchematicComponentKind {
  const normalized = refdes.trim().toLocaleUpperCase("en-US");
  if (CONNECTOR_RE.test(normalized)) return "CONNECTOR";
  if (IC_RE.test(normalized)) return "IC";
  if (PASSIVE_RE.test(normalized)) return "PASSIVE";
  if (PROTECTION_RE.test(normalized)) return "PROTECTION";
  if (/^(?:VCC|VDD|GND|PWR)/.test(normalized)) return "POWER";
  return "UNKNOWN";
}

export function buildInterfaceCandidates(components: SchematicComponent[], pins: SchematicGraphPin[], nets: SchematicNet[]): SchematicInterfaceCandidate[] {
  const pinById = new Map(pins.map((pin) => [pin.id, pin]));
  const netById = new Map(nets.map((net) => [net.id, net]));
  return components
    .filter((component) => component.kind === "CONNECTOR")
    .map((component) => {
      const componentPins = component.pin_ids.map((id) => pinById.get(id)).filter((pin): pin is SchematicGraphPin => Boolean(pin));
      const namedNets = componentPins.filter((pin) => pin.net_id && netById.get(pin.net_id)?.name).length;
      const confidence = mean(component.evidence.map((evidence) => evidence.confidence));
      const score = Math.round(componentPins.length * 12 + namedNets * 8 + confidence * 20);
      const reasons = [
        `${component.refdes} classified as connector`,
        `${componentPins.length} extracted pin(s)`,
        `${namedNets} named net(s)`
      ];
      return {
        id: `interface-${safeId(component.refdes)}-${shortHash(component.id)}`,
        component_id: component.id,
        score,
        reasons,
        confirmed: false
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function traceInterfacePaths(document: SchematicDocument, candidateId: string): SchematicPath[] {
  const candidate = document.interface_candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown schematic interface candidate ${candidateId}`);
  const anchor = document.components.find((component) => component.id === candidate.component_id);
  if (!anchor) throw new Error(`Interface candidate ${candidateId} has no component`);

  const components = new Map(document.components.map((component) => [component.id, component]));
  const pins = new Map(document.graph_pins.map((pin) => [pin.id, pin]));
  const nets = new Map(document.nets.map((net) => [net.id, net]));
  const paths: SchematicPath[] = [];

  for (const anchorPinId of anchor.pin_ids) {
    const anchorPin = pins.get(anchorPinId);
    if (!anchorPin) continue;
    const queue: Array<{ pinId: string; nodes: string[]; componentIds: string[]; edges: SchematicGraphEdge[]; evidence: SchematicEvidence[] }> = [{
      pinId: anchorPin.id,
      nodes: [anchorPin.id],
      componentIds: [anchor.id],
      edges: [],
      evidence: [...anchorPin.evidence]
    }];
    const visitedPins = new Set<string>();
    const endpointPinIds = new Set<string>();
    const traversedNodeIds = new Set<string>([anchorPin.id]);
    const traversedComponentIds = new Set<string>([anchor.id]);
    const traversedEdges = new Map<string, SchematicGraphEdge>();
    const pathEvidence: SchematicEvidence[] = [...anchorPin.evidence];
    const diagnostics: Diagnostic[] = [];

    while (queue.length) {
      const current = queue.shift()!;
      if (visitedPins.has(current.pinId)) continue;
      visitedPins.add(current.pinId);
      const pin = pins.get(current.pinId);
      if (!pin) continue;
      const component = components.get(pin.component_id);
      if (!component) continue;
      current.nodes.forEach((id) => traversedNodeIds.add(id));
      current.componentIds.forEach((id) => traversedComponentIds.add(id));
      current.edges.forEach((edge) => traversedEdges.set(edge.id, edge));
      pathEvidence.push(...current.evidence);

      if (component.kind === "IC" && component.id !== anchor.id) {
        endpointPinIds.add(pin.id);
        continue;
      }
      if (component.kind === "UNKNOWN" && component.id !== anchor.id) {
        diagnostics.push({ code: "UNCLASSIFIED_PATH_COMPONENT", severity: "WARNING", message: `${component.refdes} is unclassified and stops automatic path traversal.` });
        continue;
      }

      if (pin.net_id) {
        const net = nets.get(pin.net_id);
        if (net) {
          const netNode = `net:${net.id}`;
          const netEdge = graphEdge(`edge-${pin.id}-${net.id}`, pin.id, netNode, "NET_LABEL", [...pin.evidence, ...net.evidence]);
          for (const nextPinId of net.pin_ids) {
            if (nextPinId === pin.id || visitedPins.has(nextPinId)) continue;
            const nextPin = pins.get(nextPinId);
            if (!nextPin) continue;
            const nextEdge = graphEdge(`edge-${net.id}-${nextPin.id}`, netNode, nextPin.id, "NET_LABEL", [...net.evidence, ...nextPin.evidence]);
            queue.push({
              pinId: nextPin.id,
              nodes: [...current.nodes, netNode, nextPin.id],
              componentIds: [...current.componentIds, nextPin.component_id],
              edges: [...current.edges, netEdge, nextEdge],
              evidence: [...current.evidence, ...net.evidence, ...nextPin.evidence]
            });
          }
        }
      }

      const passthrough = component.passthrough_pin_pairs
        .filter(([left, right]) => left === pin.id || right === pin.id)
        .map(([left, right]) => left === pin.id ? right : left);
      if ((component.kind === "PASSIVE" || component.kind === "PROTECTION") && component.pin_ids.length > 2 && passthrough.length === 0) {
        diagnostics.push({ code: "PASSTHROUGH_MODEL_REQUIRED", severity: "WARNING", message: `${component.refdes} requires an explicit passthrough pin model.` });
      }
      for (const nextPinId of passthrough) {
        if (visitedPins.has(nextPinId)) continue;
        const nextPin = pins.get(nextPinId);
        if (!nextPin) continue;
        const edge = graphEdge(`passthrough-${component.id}-${pin.id}-${nextPin.id}`, pin.id, nextPin.id, "PASSTHROUGH", component.evidence);
        queue.push({
          pinId: nextPin.id,
          nodes: [...current.nodes, nextPin.id],
          componentIds: [...current.componentIds, component.id],
          edges: [...current.edges, edge],
          evidence: [...current.evidence, ...component.evidence, ...nextPin.evidence]
        });
      }
    }

    if (endpointPinIds.size === 0) diagnostics.push({ code: "NO_CHIP_ENDPOINT", severity: "WARNING", message: `${anchor.refdes}.${anchorPin.number} does not reach an identified IC pin.` });
    if (endpointPinIds.size > 1) diagnostics.push({ code: "AMBIGUOUS_CHIP_ENDPOINT", severity: "WARNING", message: `${anchor.refdes}.${anchorPin.number} reaches ${endpointPinIds.size} IC pins; no endpoint was guessed.` });
    const confidence = minimumConfidence(pathEvidence);
    if (confidence < 0.85) diagnostics.push({ code: "INFERRED_PATH_EVIDENCE", severity: "WARNING", message: `${anchor.refdes}.${anchorPin.number} includes inferred PDF/OCR evidence.` });
    const status = endpointPinIds.size === 1 && !diagnostics.some((diagnostic) => diagnostic.code !== "INFERRED_PATH_EVIDENCE") ? "RESOLVED" : "REVIEW";
    paths.push({
      id: `path-${safeId(anchor.refdes)}-${safeId(anchorPin.number)}-${shortHash([...endpointPinIds].join("|"))}`,
      anchor_pin_id: anchorPin.id,
      node_ids: [...traversedNodeIds],
      edge_ids: [...traversedEdges.keys()],
      component_ids: [...traversedComponentIds],
      endpoint_pin_ids: [...endpointPinIds],
      status,
      confidence,
      diagnostics: uniqueDiagnostics(diagnostics),
      evidence: uniqueEvidence(pathEvidence)
    });
  }
  return paths.sort((left, right) => naturalCompare(pins.get(left.anchor_pin_id)?.number ?? left.id, pins.get(right.anchor_pin_id)?.number ?? right.id));
}

export function rebuildDerivedSchematic(document: SchematicDocument, candidateId?: string): SchematicDocument {
  const components = document.components.map((component) => {
    const pinIds = document.graph_pins.filter((pin) => pin.component_id === component.id).map((pin) => pin.id);
    return { ...component, pin_ids: pinIds, passthrough_pin_pairs: component.passthrough_pin_pairs.filter(([left, right]) => pinIds.includes(left) && pinIds.includes(right)) };
  });
  const nets = document.nets.map((net) => {
    const pinIds = document.graph_pins.filter((pin) => pin.net_id === net.id).map((pin) => pin.id);
    const wireIds = document.wires.filter((wire) => wire.net_id === net.id).map((wire) => wire.id);
    const labelIds = document.labels.filter((label) => label.net_id === net.id).map((label) => label.id);
    const pageNumbers = [...new Set([
      ...document.graph_pins.filter((pin) => pin.net_id === net.id).flatMap((pin) => pin.page == null ? [] : [pin.page]),
      ...document.wires.filter((wire) => wire.net_id === net.id).map((wire) => wire.page),
      ...document.labels.filter((label) => label.net_id === net.id).map((label) => label.page)
    ])].sort((left, right) => left - right);
    return { ...net, pin_ids: pinIds, wire_ids: wireIds, label_ids: labelIds, page_numbers: pageNumbers };
  });
  for (const component of components) {
    if ((component.kind === "PASSIVE" || component.kind === "PROTECTION") && component.pin_ids.length === 2 && component.passthrough_pin_pairs.length === 0) {
      component.passthrough_pin_pairs = [[component.pin_ids[0]!, component.pin_ids[1]!]];
    }
  }
  const interfaceCandidates = buildInterfaceCandidates(components, document.graph_pins, nets).map((candidate) => ({
    ...candidate,
    confirmed: document.interface_candidates.find((known) => known.component_id === candidate.component_id)?.confirmed ?? false
  }));
  const next = { ...document, components, nets, interface_candidates: interfaceCandidates, paths: [] };
  const selectedCandidate = candidateId ?? interfaceCandidates.find((candidate) => candidate.confirmed)?.id;
  return { ...next, paths: selectedCandidate ? traceInterfacePaths(next, selectedCandidate) : [] };
}

function graphEdge(id: string, from: string, to: string, kind: SchematicGraphEdge["kind"], evidence: SchematicEvidence[]): SchematicGraphEdge {
  return { id, from, to, kind, evidence };
}

function minimumConfidence(evidence: SchematicEvidence[]) {
  return evidence.length ? Math.min(...evidence.map((item) => item.confidence)) : 0;
}

function mean(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function uniqueDiagnostics(diagnostics: Diagnostic[]) {
  return [...new Map(diagnostics.map((diagnostic) => [`${diagnostic.code}:${diagnostic.message}`, diagnostic])).values()];
}

function uniqueEvidence(evidence: SchematicEvidence[]) {
  return [...new Map(evidence.map((item) => [`${item.page}:${item.method}:${item.bbox?.x ?? "-"}:${item.bbox?.y ?? "-"}:${item.excerpt}`, item])).values()];
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
