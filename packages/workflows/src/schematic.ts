import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SchematicComponent,
  SchematicConfirmedScope,
  SchematicCorrection,
  SchematicDocument,
  SchematicGraphPin,
  SchematicNet,
  SchematicPinout,
  SchematicWire
} from "@circuit-inspector/contracts";
import { importSchematicPinout, readPinout } from "./wiring.js";
import { buildInterfaceCandidates, classifySchematicComponent, rebuildDerivedSchematic, traceInterfacePaths } from "./schematic-graph.js";
import { parseSchematicPdf, SCHEMATIC_PARSER_VERSION } from "./schematic-pdf.js";

export interface SchematicCorrectionInput {
  operation: SchematicCorrection["operation"];
  entity_kind: SchematicCorrection["entity_kind"];
  entity_id: string;
  after?: Record<string, unknown> | null | undefined;
}

export async function importSchematicDocument(
  sourcePath: string,
  role: "PRODUCT" | "WIB",
  cacheDir: string,
  revision?: string,
  onProgress?: (progress: number, message: string) => void
): Promise<SchematicDocument> {
  const absolute = path.resolve(sourcePath);
  const bytes = await readFile(absolute);
  const sourceHash = sha256(bytes);
  const extension = path.extname(absolute).toLowerCase();
  const id = `schematic-${sourceHash.slice(0, 16)}-${role.toLowerCase()}`;
  const directory = schematicDirectory(cacheDir, id);
  const cached = await tryReadDocumentFile(path.join(directory, "document.json"));
  if (
    cached?.source_hash === sourceHash
    && cached.parser_version === SCHEMATIC_PARSER_VERSION
    && (extension !== ".pdf" || await hasCompletePdfPageCache(cached, directory))
  ) return cached;
  await mkdir(directory, { recursive: true });

  let document: SchematicDocument;
  if (extension === ".pdf") {
    document = await parseSchematicPdf({ bytes, sourcePath: absolute, sourceHash, id, role, revision: revision?.trim() || null, directory, onProgress });
  } else {
    onProgress?.(12, "Importing structured schematic mapping");
    const legacy = await importSchematicPinout(absolute, role, cacheDir, revision);
    document = structuredPinoutToDocument(legacy, id);
  }
  document.interface_candidates = buildInterfaceCandidates(document.components, document.graph_pins, document.nets);
  document.diagnostics.push(...await findRevisionSourceConflicts(document, cacheDir));
  await saveSchematicDocument(document, cacheDir);
  onProgress?.(100, "Schematic graph candidate is ready for review");
  return document;
}

export async function readSchematicDocument(id: string, cacheDir: string): Promise<SchematicDocument> {
  assertArtifactId(id);
  const current = await tryReadDocumentFile(path.join(schematicDirectory(cacheDir, id), "document.json"));
  if (current) {
    const directory = schematicDirectory(cacheDir, current.id);
    const canRebuildWithoutLosingReviewWork = current.status === "DRAFT"
      && current.corrections.length === 0
      && current.confirmed_scopes.length === 0;
    const needsPdfRebuild = current.source_format === "PDF"
      && canRebuildWithoutLosingReviewWork && (
      current.parser_version !== SCHEMATIC_PARSER_VERSION
      || !await hasCompletePdfPageCache(current, directory)
    );
    if (!needsPdfRebuild) return current;
    try {
      const source = await stat(current.source_path);
      if (source.isFile()) {
        return await importSchematicDocument(
          current.source_path,
          current.role,
          cacheDir,
          current.revision ?? undefined
        );
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    return current;
  }
  const legacy = await readPinout(id, cacheDir);
  return structuredPinoutToDocument(legacy, `schematic-${legacy.source_hash.slice(0, 16)}-${legacy.role.toLowerCase()}`);
}

export async function tryReadSchematicDocument(id: string, cacheDir: string): Promise<SchematicDocument | null> {
  try {
    return await readSchematicDocument(id, cacheDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export async function traceSchematicInterface(id: string, candidateId: string, cacheDir: string): Promise<SchematicDocument> {
  const document = await readSchematicDocument(id, cacheDir);
  document.paths = traceInterfacePaths(document, candidateId);
  document.interface_candidates = document.interface_candidates.map((candidate) => ({ ...candidate, confirmed: candidate.id === candidateId ? candidate.confirmed : false }));
  await saveSchematicDocument(document, cacheDir);
  return document;
}

export async function applySchematicCorrections(
  id: string,
  corrections: SchematicCorrectionInput[],
  correctedBy: string,
  cacheDir: string,
  candidateId?: string
): Promise<SchematicDocument> {
  if (!correctedBy.trim()) throw new Error("corrected_by is required");
  if (!corrections.length) throw new Error("At least one schematic correction is required");
  let document = structuredClone(await readSchematicDocument(id, cacheDir));
  for (const input of corrections) {
    const before = correctionTarget(document, input.entity_kind, input.entity_id);
    const beforeRecord = before ? asRecord(structuredClone(before)) : null;
    applyCorrection(document, input);
    const after = correctionTarget(document, input.entity_kind, input.entity_id);
    const afterRecord = after ? asRecord(structuredClone(after)) : input.after ?? null;
    const correctedAt = new Date().toISOString();
    const contentHash = sha256(JSON.stringify({ operation: input.operation, entity_kind: input.entity_kind, entity_id: input.entity_id, before: beforeRecord, after: afterRecord, corrected_by: correctedBy.trim(), corrected_at: correctedAt }));
    document.corrections.push({
      id: `correction-${contentHash.slice(0, 18)}`,
      operation: input.operation,
      entity_kind: input.entity_kind,
      entity_id: input.entity_id,
      before: beforeRecord,
      after: afterRecord,
      corrected_by: correctedBy.trim(),
      corrected_at: correctedAt,
      content_hash: contentHash
    });
  }
  document.confirmed_scopes = [];
  document.confirmation = null;
  document.status = "DRAFT";
  document.diagnostics = document.diagnostics.filter((diagnostic) => diagnostic.code !== "SCHEMATIC_SOURCE_CONFLICT");
  document = rebuildDerivedSchematic(document, candidateId);
  document.pins = projectInterfacePins(document, candidateId);
  await saveSchematicDocument(document, cacheDir);
  return document;
}

export async function confirmSchematicPaths(
  id: string,
  candidateId: string,
  pathIds: string[],
  confirmedBy: string,
  cacheDir: string
): Promise<SchematicDocument> {
  if (!confirmedBy.trim()) throw new Error("confirmed_by is required");
  if (!pathIds.length) throw new Error("At least one schematic path must be confirmed");
  const document = await readSchematicDocument(id, cacheDir);
  if (document.diagnostics.some((diagnostic) => diagnostic.code === "SCHEMATIC_SOURCE_CONFLICT")) throw new Error("Resolve the PDF/structured schematic source conflict with an audited graph correction before confirming paths");
  const candidate = document.interface_candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Unknown schematic interface candidate ${candidateId}`);
  if (!document.paths.length || pathIds.some((pathId) => !document.paths.some((path) => path.id === pathId))) {
    document.paths = traceInterfacePaths(document, candidateId);
  }
  const selected = pathIds.map((pathId) => document.paths.find((path) => path.id === pathId) ?? missingPath(pathId));
  const candidateComponent = document.components.find((component) => component.id === candidate.component_id);
  const candidatePinIds = new Set(candidateComponent?.pin_ids ?? []);
  if (selected.some((item) => !candidatePinIds.has(item.anchor_pin_id))) throw new Error("Confirmed paths must belong to the selected interface candidate");
  const confirmedAt = new Date().toISOString();
  const contentHash = sha256(JSON.stringify({ source_hash: document.source_hash, parser_version: document.parser_version, candidate_id: candidateId, paths: selected, corrections: document.corrections.map((correction) => correction.content_hash) }));
  const scope: SchematicConfirmedScope = {
    id: `scope-${contentHash.slice(0, 18)}`,
    anchor_candidate_id: candidateId,
    path_ids: [...new Set(pathIds)].sort(),
    confirmed_by: confirmedBy.trim(),
    confirmed_at: confirmedAt,
    content_hash: contentHash
  };
  document.confirmed_scopes = [scope];
  document.interface_candidates = document.interface_candidates.map((item) => ({ ...item, confirmed: item.id === candidateId }));
  const completeCandidateScope = candidatePinIds.size > 0 && document.paths
    .filter((path) => candidatePinIds.has(path.anchor_pin_id))
    .every((path) => pathIds.includes(path.id));
  document.status = document.source_format === "PDF" || !completeCandidateScope ? "PARTIALLY_CONFIRMED" : "CONFIRMED";
  document.confirmation = { confirmed_by: confirmedBy.trim(), confirmed_at: confirmedAt, content_hash: contentHash };
  document.pins = projectInterfacePins(document, candidateId);
  await saveSchematicDocument(document, cacheDir);
  return document;
}

export async function readSchematicPage(id: string, pageNumber: number, cacheDir: string) {
  const document = await readSchematicDocument(id, cacheDir);
  const page = document.pages.find((item) => item.number === pageNumber);
  if (!page) throw new Error(`Unknown schematic page ${pageNumber}`);
  const root = schematicDirectory(cacheDir, document.id);
  const renderPath = assertPathInside(root, page.render_path);
  const thumbnailPath = assertPathInside(root, page.thumbnail_path);
  const [bytes, thumbnailBytes] = await Promise.all([readFile(renderPath), readFile(thumbnailPath)]);
  return {
    page,
    bytes,
    thumbnailBytes,
    components: document.components.filter((component) => component.page === pageNumber),
    pins: document.graph_pins.filter((pin) => pin.page === pageNumber),
    wires: document.wires.filter((wire) => wire.page === pageNumber),
    junctions: document.junctions.filter((junction) => junction.page === pageNumber),
    labels: document.labels.filter((label) => label.page === pageNumber)
  };
}

export async function readSchematicThumbnail(id: string, pageNumber: number, cacheDir: string) {
  const document = await readSchematicDocument(id, cacheDir);
  const page = document.pages.find((item) => item.number === pageNumber);
  if (!page) throw new Error(`Unknown schematic page ${pageNumber}`);
  const root = schematicDirectory(cacheDir, document.id);
  const file = assertPathInside(root, page.thumbnail_path);
  const bytes = await readFile(file);
  return { page: pageNumber, bytes };
}

async function hasCompletePdfPageCache(document: SchematicDocument, root: string) {
  if (document.pages.length === 0) return false;
  try {
    await Promise.all(document.pages.flatMap((page) => [page.render_path, page.thumbnail_path].map(async (file) => {
      const metadata = await stat(assertPathInside(root, file));
      if (!metadata.isFile() || metadata.size === 0) throw new Error("Incomplete cached schematic page");
    })));
    return true;
  } catch {
    return false;
  }
}

export async function saveSchematicDocument(document: SchematicDocument, cacheDir: string) {
  const directory = schematicDirectory(cacheDir, document.id);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "document.json");
  const temporary = path.join(directory, `.document.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
  await rename(temporary, target);
}

export function structuredPinoutToDocument(pinout: SchematicPinout, id = `schematic-${pinout.source_hash.slice(0, 16)}-${pinout.role.toLowerCase()}`): SchematicDocument {
  const components = new Map<string, SchematicComponent>();
  const graphPins: SchematicGraphPin[] = [];
  const nets = new Map<string, SchematicNet>();
  for (const row of pinout.pins) {
    const componentId = `component-${safeId(row.connector)}`;
    let component = components.get(componentId);
    const evidence = {
      source_path: pinout.source_path,
      source_hash: pinout.source_hash,
      page: row.evidence?.page ?? null,
      bbox: null,
      excerpt: row.evidence?.excerpt ?? `${row.connector} ${row.pin} ${row.net_name}`,
      method: "STRUCTURED" as const,
      confidence: row.confidence === "EXPLICIT" ? 1 : 0.72
    };
    if (!component) {
      component = { id: componentId, refdes: row.connector, value: null, kind: classifySchematicComponent(row.connector), page: row.evidence?.page ?? null, bbox: null, pin_ids: [], passthrough_pin_pairs: [], evidence: [evidence] };
      components.set(componentId, component);
    }
    const netId = `net-${safeId(row.net_name.toLocaleUpperCase("en-US"))}`;
    let net = nets.get(netId);
    if (!net) {
      net = { id: netId, name: row.net_name, pin_ids: [], wire_ids: [], label_ids: [], page_numbers: row.evidence?.page == null ? [] : [row.evidence.page], confidence: evidence.confidence, evidence: [evidence] };
      nets.set(netId, net);
    }
    const graphPin: SchematicGraphPin = { id: `pin-${safeId(row.connector)}-${safeId(row.pin)}`, component_id: componentId, number: row.pin, name: null, net_id: netId, page: row.evidence?.page ?? null, x: null, y: null, evidence: [evidence] };
    graphPins.push(graphPin);
    component.pin_ids.push(graphPin.id);
    net.pin_ids.push(graphPin.id);
  }
  for (const component of components.values()) {
    if ((component.kind === "PASSIVE" || component.kind === "PROTECTION") && component.pin_ids.length === 2) component.passthrough_pin_pairs = [[component.pin_ids[0]!, component.pin_ids[1]!]];
  }
  const document: SchematicDocument = {
    schema_version: 2,
    parser_version: SCHEMATIC_PARSER_VERSION,
    id,
    role: pinout.role,
    source_path: pinout.source_path,
    source_hash: pinout.source_hash,
    source_format: pinout.source_format,
    revision: pinout.revision,
    status: pinout.status,
    pages: [],
    components: [...components.values()],
    graph_pins: graphPins,
    nets: [...nets.values()],
    wires: [],
    junctions: [],
    labels: [],
    edges: [],
    interface_candidates: [],
    paths: [],
    corrections: [],
    confirmed_scopes: pinout.confirmation ? [{ id: `scope-${pinout.confirmation.content_hash.slice(0, 18)}`, anchor_candidate_id: "legacy-pinout", path_ids: [], confirmed_by: pinout.confirmation.confirmed_by, confirmed_at: pinout.confirmation.confirmed_at, content_hash: pinout.confirmation.content_hash }] : [],
    pins: pinout.pins,
    design_metrics: pinout.design_metrics,
    diagnostics: pinout.diagnostics,
    confirmation: pinout.confirmation
  };
  document.interface_candidates = buildInterfaceCandidates(document.components, document.graph_pins, document.nets);
  return document;
}

function applyCorrection(document: SchematicDocument, input: SchematicCorrectionInput) {
  if (input.operation === "MERGE_NETS") return mergeNets(document, input);
  if (input.operation === "SPLIT_NET") return splitNet(document, input);
  if (input.operation === "SET_PASSTHROUGH") return setPassthrough(document, input);
  const collection = correctionCollection(document, input.entity_kind);
  const index = collection.findIndex((item) => typeof item === "object" && item !== null && "id" in item && item.id === input.entity_id);
  if (input.operation === "ADD") {
    if (!input.after || index >= 0) throw new Error(`Cannot add ${input.entity_kind} ${input.entity_id}`);
    collection.push({ ...input.after, id: input.entity_id });
    return;
  }
  if (index < 0) throw new Error(`Unknown ${input.entity_kind} ${input.entity_id}`);
  if (input.operation === "DELETE") {
    collection.splice(index, 1);
    return;
  }
  if (input.operation === "SET_JUNCTION" || input.operation === "SET_OFF_PAGE") {
    if (!input.after) throw new Error(`${input.operation} requires after data`);
    collection[index] = { ...collection[index], ...input.after, id: input.entity_id };
    return;
  }
  if (input.operation !== "UPDATE" || !input.after) throw new Error(`Unsupported correction operation ${input.operation}`);
  collection[index] = { ...collection[index], ...input.after, id: input.entity_id };
}

function splitNet(document: SchematicDocument, input: SchematicCorrectionInput) {
  const source = document.nets.find((net) => net.id === input.entity_id);
  if (!source) throw new Error(`Unknown source net ${input.entity_id}`);
  const newNetId = typeof input.after?.new_net_id === "string" ? input.after.new_net_id : "";
  const name = typeof input.after?.name === "string" ? input.after.name.trim() : "";
  const pinIds = Array.isArray(input.after?.pin_ids) ? input.after.pin_ids.filter((value): value is string => typeof value === "string") : [];
  const wireIds = Array.isArray(input.after?.wire_ids) ? input.after.wire_ids.filter((value): value is string => typeof value === "string") : [];
  if (!newNetId || !name || (!pinIds.length && !wireIds.length)) throw new Error("SPLIT_NET requires new_net_id, name, and selected pin_ids or wire_ids");
  if (document.nets.some((net) => net.id === newNetId)) throw new Error(`Net ${newNetId} already exists`);
  if (pinIds.some((id) => !source.pin_ids.includes(id)) || wireIds.some((id) => !source.wire_ids.includes(id))) throw new Error("SPLIT_NET selections must belong to the source net");
  const evidence = source.evidence.length ? [...source.evidence] : [];
  document.nets.push({ id: newNetId, name, pin_ids: pinIds, wire_ids: wireIds, label_ids: [], page_numbers: [], confidence: 1, evidence });
  document.graph_pins.forEach((pin) => { if (pinIds.includes(pin.id)) pin.net_id = newNetId; });
  document.wires.forEach((wire) => { if (wireIds.includes(wire.id)) wire.net_id = newNetId; });
}

function mergeNets(document: SchematicDocument, input: SchematicCorrectionInput) {
  const sourceIds = Array.isArray(input.after?.source_ids) ? input.after.source_ids.filter((value): value is string => typeof value === "string") : [];
  if (sourceIds.length < 2) throw new Error("MERGE_NETS requires at least two source_ids");
  const target = document.nets.find((net) => net.id === input.entity_id);
  if (!target) throw new Error(`Unknown target net ${input.entity_id}`);
  for (const sourceId of sourceIds) {
    if (sourceId === target.id) continue;
    const source = document.nets.find((net) => net.id === sourceId);
    if (!source) throw new Error(`Unknown source net ${sourceId}`);
    document.graph_pins.forEach((pin) => { if (pin.net_id === source.id) pin.net_id = target.id; });
    document.wires.forEach((wire) => { if (wire.net_id === source.id) wire.net_id = target.id; });
    target.evidence.push(...source.evidence);
  }
  document.nets = document.nets.filter((net) => !sourceIds.includes(net.id) || net.id === target.id);
}

function setPassthrough(document: SchematicDocument, input: SchematicCorrectionInput) {
  const component = document.components.find((item) => item.id === input.entity_id);
  if (!component) throw new Error(`Unknown component ${input.entity_id}`);
  const rawPairs = Array.isArray(input.after?.pin_pairs) ? input.after.pin_pairs : [];
  const pairs = rawPairs.map((value) => {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") throw new Error("Each passthrough pin pair must contain two pin IDs");
    if (!component.pin_ids.includes(value[0]) || !component.pin_ids.includes(value[1])) throw new Error("Passthrough pins must belong to the selected component");
    return [value[0], value[1]] as [string, string];
  });
  component.passthrough_pin_pairs = pairs;
}

function correctionTarget(document: SchematicDocument, kind: SchematicCorrection["entity_kind"], id: string): unknown {
  return correctionCollection(document, kind).find((item) => typeof item === "object" && item !== null && "id" in item && item.id === id);
}

function correctionCollection(document: SchematicDocument, kind: SchematicCorrection["entity_kind"]): Array<Record<string, unknown>> {
  const value = kind === "COMPONENT" ? document.components
    : kind === "PIN" ? document.graph_pins
      : kind === "NET" ? document.nets
        : kind === "WIRE" ? document.wires
          : kind === "JUNCTION" ? document.junctions
            : document.labels;
  return value as unknown as Array<Record<string, unknown>>;
}

function projectInterfacePins(document: SchematicDocument, candidateId?: string) {
  const candidate = document.interface_candidates.find((item) => item.id === candidateId) ?? document.interface_candidates.find((item) => item.confirmed);
  const component = candidate ? document.components.find((item) => item.id === candidate.component_id) : undefined;
  if (!component) return document.pins;
  const netById = new Map(document.nets.map((net) => [net.id, net]));
  return component.pin_ids.flatMap((pinId) => {
    const pin = document.graph_pins.find((item) => item.id === pinId);
    if (!pin?.net_id) return [];
    const net = netById.get(pin.net_id);
    if (!net?.name) return [];
    const evidence = pin.evidence[0];
    return [{
      connector: component.refdes,
      pin: pin.number,
      net_name: net.name,
      confidence: document.confirmed_scopes.some((scope) => scope.path_ids.includes(document.paths.find((path) => path.anchor_pin_id === pin.id)?.id ?? "")) ? "EXPLICIT" as const : "INFERRED" as const,
      ...(evidence ? { evidence: { source_path: evidence.source_path, source_hash: evidence.source_hash, page: evidence.page, line: null, excerpt: evidence.excerpt } } : {})
    }];
  });
}

function missingPath(id: string): never { throw new Error(`Unknown schematic path ${id}`); }

function schematicDirectory(cacheDir: string, id: string) {
  return path.join(cacheDir, "schematics", assertArtifactId(id));
}

async function tryReadDocumentFile(file: string): Promise<SchematicDocument | null> {
  try {
    const [text] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const parsed = JSON.parse(text) as SchematicDocument;
    return parsed.schema_version === 2 ? parsed : null;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function assertArtifactId(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid schematic artifact identifier");
  return value;
}

function assertPathInside(root: string, value: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(value);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Schematic page path escapes its artifact directory");
  return resolved;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Schematic correction target must be an object");
  return value as Record<string, unknown>;
}

function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function safeId(value: string) { return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item"; }

async function findRevisionSourceConflicts(document: SchematicDocument, cacheDir: string) {
  if (!document.revision?.trim()) return [];
  const root = path.join(cacheDir, "schematics");
  let ids: string[];
  try {
    ids = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const currentPins = new Map(document.pins.map((pin) => [`${pin.connector}\u0000${pin.pin}`.toLocaleUpperCase("en-US"), pin.net_name.toLocaleUpperCase("en-US")]));
  const diagnostics: SchematicDocument["diagnostics"] = [];
  for (const id of ids) {
    if (id === document.id) continue;
    const other = await tryReadDocumentFile(path.join(root, id, "document.json"));
    if (!other || other.role !== document.role || other.revision?.trim().toLocaleUpperCase("en-US") !== document.revision.trim().toLocaleUpperCase("en-US") || other.source_format === document.source_format) continue;
    const otherPins = new Map(other.pins.map((pin) => [`${pin.connector}\u0000${pin.pin}`.toLocaleUpperCase("en-US"), pin.net_name.toLocaleUpperCase("en-US")]));
    const keys = new Set([...currentPins.keys(), ...otherPins.keys()]);
    const differences = [...keys].filter((key) => currentPins.get(key) !== otherPins.get(key));
    if (differences.length) diagnostics.push({ code: "SCHEMATIC_SOURCE_CONFLICT", severity: "WARNING", message: `${document.source_format} evidence conflicts with ${other.source_format} artifact ${other.id} at ${differences.length} connector pin(s). No source was given silent precedence.` });
  }
  return diagnostics;
}
