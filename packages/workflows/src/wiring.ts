import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SchematicDocument, SchematicPath } from "@circuit-inspector/contracts";

export type WiringVerdict = "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE";
export type PinoutRole = "PRODUCT" | "WIB";

export interface PinEvidence {
  source_path: string;
  source_hash: string;
  page: number | null;
  line: number | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  excerpt: string;
}

export interface PinConnection {
  connector: string;
  pin: string;
  net_name: string;
  confidence: "EXPLICIT" | "INFERRED";
  evidence: PinEvidence;
}

export interface PinoutDocument {
  schema_version: 1;
  id: string;
  role: PinoutRole;
  source_path: string;
  source_hash: string;
  source_format: "JSON" | "CSV" | "TSV" | "TEXT" | "PDF";
  revision: string | null;
  status: "DRAFT" | "CONFIRMED";
  pins: PinConnection[];
  design_metrics: DesignMetric[];
  diagnostics: Array<{ code: string; severity: "INFO" | "WARNING" | "ERROR"; message: string }>;
  confirmation: {
    confirmed_by: string;
    confirmed_at: string;
    content_hash: string;
  } | null;
}

export interface DesignMetric {
  id: string;
  value: string | number;
  unit: string | null;
  confidence: "EXPLICIT" | "INFERRED";
  evidence: PinEvidence;
}

export interface ConnectorMapping {
  product_connector: string;
  wib_connector: string;
  pin_map?: Array<{ product_pin: string; wib_pin: string }> | undefined;
}

export interface NetAlias {
  product_net: string;
  wib_net: string;
}

export interface WiringConnection {
  id: string;
  product_connector: string;
  product_pin: string;
  product_net: string | null;
  wib_connector: string;
  wib_pin: string;
  wib_net: string | null;
  product_endpoint_refs?: string[];
  wib_endpoint_refs?: string[];
  product_path_component_refs?: string[];
  wib_path_component_refs?: string[];
  product_path_component_kinds?: string[];
  wib_path_component_kinds?: string[];
  product_path_id?: string | null;
  wib_path_id?: string | null;
  verdict: WiringVerdict;
  message: string;
}

export interface NetNameReviewRow {
  net_name: string;
  product_locations: string[];
  wib_locations: string[];
  product_count: number;
  wib_count: number;
  status: "MATCH_CANDIDATE" | "COUNT_MISMATCH" | "PRODUCT_ONLY" | "WIB_ONLY";
  message: string;
}

export interface WiringFinding {
  id: string;
  analysis_id: string;
  rule_id: string;
  title: string;
  severity: "INFO" | "WARNING" | "ERROR";
  verdict: WiringVerdict;
  verification_mode: "DOCUMENT_BACKED";
  net_names: string[];
  component_refs: string[];
  layer_ids: string[];
  x_nm: number;
  y_nm: number;
  measured_value_nm: null;
  threshold_nm: null;
  message: string;
  evidence_uris: string[];
  product_connector: string | null;
  product_pin: string | null;
  product_net: string | null;
  wib_connector: string | null;
  wib_pin: string | null;
  wib_net: string | null;
}

export interface WiringAnalysis {
  schema_version: 1;
  kind: "WIRING_COMPARISON";
  id: string;
  product_pinout_id: string;
  wib_pinout_id: string;
  product: PinoutDocument;
  wib: PinoutDocument;
  connector_mappings: ConnectorMapping[];
  net_aliases: NetAlias[];
  case_sensitive?: boolean;
  verdict: WiringVerdict;
  verification_mode: "DOCUMENT_BACKED";
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  connections: WiringConnection[];
  net_name_review: NetNameReviewRow[];
  violations: WiringFinding[];
  diagnostics: Array<{ code: string; severity: "INFO" | "WARNING" | "ERROR"; message: string }>;
  report_uri: string;
  report_path: string;
  elapsed_ms: number;
}

export async function importSchematicPinout(
  sourcePath: string,
  role: PinoutRole,
  cacheDir: string,
  revision?: string
): Promise<PinoutDocument> {
  const absolute = path.resolve(sourcePath);
  const bytes = await readFile(absolute);
  const sourceHash = sha256(bytes);
  const extension = path.extname(absolute).toLowerCase();
  const evidenceBase = { source_path: absolute, source_hash: sourceHash };
  let sourceFormat: PinoutDocument["source_format"];
  let pins: PinConnection[];
  let designMetrics: DesignMetric[] = [];
  let sourceRevision: string | null = null;
  const diagnostics: PinoutDocument["diagnostics"] = [];

  if (extension === ".json") {
    sourceFormat = "JSON";
    const parsed = parseJsonPinout(bytes.toString("utf8"), evidenceBase);
    pins = parsed.pins;
    designMetrics = parsed.designMetrics;
    sourceRevision = parsed.revision;
  } else if (extension === ".csv" || extension === ".tsv") {
    sourceFormat = extension === ".csv" ? "CSV" : "TSV";
    pins = parseDelimitedPinout(bytes.toString("utf8"), extension === ".csv" ? "," : "\t", evidenceBase);
  } else if (extension === ".txt" || extension === ".net" || extension === ".pinout") {
    sourceFormat = "TEXT";
    pins = parseTextPinout(bytes.toString("utf8"), evidenceBase);
  } else if (extension === ".pdf") {
    sourceFormat = "PDF";
    pins = await parsePdfPinout(bytes, evidenceBase);
    diagnostics.push({
      code: "PDF_CANDIDATES_REQUIRE_CONFIRMATION",
      severity: "WARNING",
      message: "PDF pinout rows are extraction candidates. Confirm the page evidence and complete pin list before comparison can produce PASS or FAIL."
    });
  } else {
    throw new Error(`Unsupported schematic pinout: ${absolute}. Use JSON, CSV, TSV, text, or PDF.`);
  }

  pins = sortPins(validateCandidatePins(pins));
  if (pins.length === 0) {
    diagnostics.push({
      code: "NO_PINOUT_ROWS",
      severity: "ERROR",
      message: "No connector/pin/NET NAME rows were recognized. Export a structured pinout or provide confirmed rows."
    });
  }
  if (pins.some((pin) => pin.confidence === "INFERRED")) {
    diagnostics.push({
      code: "INFERRED_PINOUT",
      severity: "WARNING",
      message: "At least one pin row was inferred from document text and cannot support PASS/FAIL until confirmed."
    });
  }

  const id = `pinout-${sourceHash.slice(0, 16)}-${role.toLowerCase()}`;
  const document: PinoutDocument = {
    schema_version: 1,
    id,
    role,
    source_path: absolute,
    source_hash: sourceHash,
    source_format: sourceFormat,
    revision: revision?.trim() || sourceRevision,
    status: "DRAFT",
    pins,
    design_metrics: designMetrics,
    diagnostics,
    confirmation: null
  };
  await savePinout(document, cacheDir);
  return document;
}

export async function confirmSchematicPinout(
  pinoutId: string,
  confirmedBy: string,
  cacheDir: string,
  confirmedPins?: Array<{ connector: string; pin: string; net_name: string }>,
  revision?: string,
  confirmedMetrics?: Array<{ id: string; value: string | number; unit?: string | null | undefined }>
): Promise<PinoutDocument> {
  if (!confirmedBy.trim()) throw new Error("confirmed_by is required");
  const document = await readPinout(pinoutId, cacheDir);
  const pins = confirmedPins
    ? confirmedPins.map((pin, index) => ({
        connector: normalizedIdentifier(pin.connector, "connector"),
        pin: normalizedIdentifier(pin.pin, "pin"),
        net_name: normalizedNet(pin.net_name),
        confidence: "EXPLICIT" as const,
        evidence: {
          source_path: document.source_path,
          source_hash: document.source_hash,
          page: null,
          line: index + 1,
          bbox: null,
          excerpt: `${pin.connector} ${pin.pin} ${pin.net_name}`
        }
      }))
    : document.pins.map((pin) => ({ ...pin, confidence: "EXPLICIT" as const }));
  const validated = sortPins(validateConfirmedPins(pins));
  if (validated.length === 0) throw new Error("A confirmed pinout must contain at least one connector pin");
  document.pins = validated;
  if (confirmedMetrics) {
    document.design_metrics = validateDesignMetrics(confirmedMetrics.map((metric, index) => ({
      id: normalizedIdentifier(metric.id, "design metric id"),
      value: normalizedMetricValue(metric.value),
      unit: metric.unit?.trim() || null,
      confidence: "EXPLICIT" as const,
      evidence: {
        source_path: document.source_path,
        source_hash: document.source_hash,
        page: null,
        line: index + 1,
        bbox: null,
        excerpt: `${metric.id}=${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`
      }
    })), true);
  } else {
    document.design_metrics = validateDesignMetrics(
      (document.design_metrics ?? []).map((metric) => ({ ...metric, confidence: "EXPLICIT" as const })),
      true
    );
  }
  document.revision = revision?.trim() || document.revision;
  document.status = "CONFIRMED";
  document.diagnostics = document.diagnostics.filter((diagnostic) =>
    diagnostic.code !== "PDF_CANDIDATES_REQUIRE_CONFIRMATION" &&
    diagnostic.code !== "INFERRED_PINOUT" &&
    diagnostic.code !== "NO_PINOUT_ROWS"
  );
  const contentHash = sha256(JSON.stringify({ role: document.role, revision: document.revision, pins: comparablePins(document.pins), design_metrics: comparableMetrics(document.design_metrics) }));
  document.confirmation = {
    confirmed_by: confirmedBy.trim(),
    confirmed_at: new Date().toISOString(),
    content_hash: contentHash
  };
  await savePinout(document, cacheDir);
  return document;
}

export async function compareFixtureWiring(
  productPinoutId: string,
  wibPinoutId: string,
  cacheDir: string,
  options: {
    connectorMappings?: ConnectorMapping[];
    netAliases?: NetAlias[];
    caseSensitive?: boolean;
  } = {}
): Promise<WiringAnalysis> {
  const started = performance.now();
  const loaded = await loadComparisonInputs(productPinoutId, wibPinoutId, cacheDir);
  const product = loaded.product;
  const wib = loaded.wib;
  if (product.role !== "PRODUCT") throw new Error(`${product.id} is not a PRODUCT pinout`);
  if (wib.role !== "WIB") throw new Error(`${wib.id} is not a WIB pinout`);

  const diagnostics: WiringAnalysis["diagnostics"] = [];
  const mappingResolution = resolveConnectorMappings(product, wib, options.connectorMappings);
  diagnostics.push(...mappingResolution.diagnostics);
  const mappings = mappingResolution.mappings;
  const aliases = validateAliases(options.netAliases ?? []);
  const comparisonIdentity = JSON.stringify({
    product: loaded.productDocument ? schematicIdentity(loaded.productDocument) : product.confirmation?.content_hash ?? product.source_hash,
    wib: loaded.wibDocument ? schematicIdentity(loaded.wibDocument) : wib.confirmation?.content_hash ?? wib.source_hash,
    mappings,
    aliases,
    caseSensitive: options.caseSensitive ?? false
  });
  const analysisId = `wiring-${sha256(comparisonIdentity).slice(0, 20)}`;
  const connections: WiringConnection[] = [];
  const findings: WiringFinding[] = [];
  const exactPinScope = hasExactPinScope(product, wib, mappings, mappingResolution.diagnostics);
  const netNameReview = exactPinScope ? [] : compareNetNameInventory(product, wib, aliases, options.caseSensitive ?? false);
  if (!exactPinScope) {
    const message = "NET NAME inventory was compared without assuming connector or pin correspondence. This supports human review, but cannot prove pin identity or detect swaps, so PASS/FAIL remains unavailable until exact correspondence is established.";
    if (!diagnostics.some((diagnostic) => diagnostic.code === "NET_NAME_REVIEW_ONLY")) {
      diagnostics.push({ code: "NET_NAME_REVIEW_ONLY", severity: "WARNING", message });
    }
    findings.push(makeScopeFinding(analysisId, message));
  }

  if (product.status !== "CONFIRMED" || wib.status !== "CONFIRMED") {
    diagnostics.push({
      code: "UNCONFIRMED_PINOUT",
      severity: "WARNING",
      message: loaded.productDocument || loaded.wibDocument
        ? "Only selected, resolved schematic paths can support PASS or FAIL; unconfirmed or ambiguous paths remain REVIEW."
        : "Both product and WIB pinouts must be CONFIRMED before mismatches can be adjudicated as PASS or FAIL."
    });
  }

  for (const mapping of exactPinScope ? mappings : []) {
    const productPins = pinsForConnector(product, mapping.product_connector);
    const wibPins = pinsForConnector(wib, mapping.wib_connector);
    const pinPairs = resolvePinPairs(mapping, productPins, wibPins);
    for (const pair of pinPairs) {
      const productPin = productPins.get(normalizedKey(pair.product_pin));
      const wibPin = wibPins.get(normalizedKey(pair.wib_pin));
      const id = connectionId(mapping, pair.product_pin, pair.wib_pin);
      const productState = loaded.productDocument ? schematicPinState(loaded.productDocument, mapping.product_connector, pair.product_pin) : null;
      const wibState = loaded.wibDocument ? schematicPinState(loaded.wibDocument, mapping.wib_connector, pair.wib_pin) : null;
      const productConfirmed = loaded.productDocument
        ? productPin ? productState?.confirmed === true : interfaceFullyConfirmed(loaded.productDocument, mapping.product_connector)
        : product.status === "CONFIRMED";
      const wibConfirmed = loaded.wibDocument
        ? wibPin ? wibState?.confirmed === true : interfaceFullyConfirmed(loaded.wibDocument, mapping.wib_connector)
        : wib.status === "CONFIRMED";
      const isConfirmed = productConfirmed && wibConfirmed;
      let verdict: WiringVerdict;
      let message: string;
      let ruleId: string | null = null;
      if (!productPin) {
        verdict = isConfirmed ? "FAIL" : "REVIEW";
        ruleId = "WIB_PIN_NOT_IN_PRODUCT";
        message = `WIB ${mapping.wib_connector}.${pair.wib_pin} (${wibPin?.net_name ?? "missing"}) has no mapped product pin.`;
      } else if (!wibPin) {
        verdict = isConfirmed ? "FAIL" : "REVIEW";
        ruleId = "PRODUCT_PIN_MISSING_ON_WIB";
        message = `Product ${mapping.product_connector}.${pair.product_pin} (${productPin.net_name}) is missing on WIB ${mapping.wib_connector}.${pair.wib_pin}.`;
      } else if ((productState && !productState.resolved) || (wibState && !wibState.resolved)) {
        verdict = "REVIEW";
        ruleId = "UNRESOLVED_SCHEMATIC_PATH";
        message = `Path evidence is unresolved: product ${productState?.summary ?? "structured mapping"}; WIB ${wibState?.summary ?? "structured mapping"}.`;
      } else if (!netsMatch(productPin.net_name, wibPin.net_name, aliases, options.caseSensitive ?? false)) {
        verdict = isConfirmed ? "FAIL" : "REVIEW";
        ruleId = "NET_NAME_MISMATCH";
        message = `Product ${mapping.product_connector}.${pair.product_pin} is ${productPin.net_name}, but WIB ${mapping.wib_connector}.${pair.wib_pin} is ${wibPin.net_name}.`;
      } else if (!isConfirmed) {
        verdict = "REVIEW";
        ruleId = "UNCONFIRMED_MATCH";
        message = `Candidate match ${mapping.product_connector}.${pair.product_pin} ${productPin.net_name} ↔ ${mapping.wib_connector}.${pair.wib_pin} ${wibPin.net_name} requires confirmation.`;
      } else {
        verdict = "PASS";
        message = `${mapping.product_connector}.${pair.product_pin} ${productPin.net_name} matches ${mapping.wib_connector}.${pair.wib_pin} ${wibPin.net_name}.`;
      }
      connections.push({
        id,
        product_connector: mapping.product_connector,
        product_pin: pair.product_pin,
        product_net: productPin?.net_name ?? null,
        wib_connector: mapping.wib_connector,
        wib_pin: pair.wib_pin,
        wib_net: wibPin?.net_name ?? null,
        ...(productState ? { product_endpoint_refs: productState.endpointRefs, product_path_id: productState.path?.id ?? null } : {}),
        ...(wibState ? { wib_endpoint_refs: wibState.endpointRefs, wib_path_id: wibState.path?.id ?? null } : {}),
        ...(productState ? { product_path_component_refs: productState.componentRefs, product_path_component_kinds: productState.componentKinds } : {}),
        ...(wibState ? { wib_path_component_refs: wibState.componentRefs, wib_path_component_kinds: wibState.componentKinds } : {}),
        verdict,
        message
      });
      if (ruleId) {
        findings.push(makeFinding(analysisId, id, ruleId, verdict, message, productPin ?? null, wibPin ?? null, mapping, pair));
      }
    }
  }

  const passCount = connections.filter((connection) => connection.verdict === "PASS").length;
  const failCount = findings.filter((finding) => finding.verdict === "FAIL").length;
  const reviewCount = findings.filter((finding) => finding.verdict === "REVIEW").length;
  const verdict: WiringVerdict = failCount > 0 ? "FAIL" : reviewCount > 0 ? "REVIEW" : passCount > 0 ? "PASS" : "NOT_APPLICABLE";
  const evidenceDirectory = path.join(cacheDir, "evidence", safeSegment(analysisId));
  await mkdir(evidenceDirectory, { recursive: true });
  const reportPath = path.join(evidenceDirectory, "report.html");
  const analysis: WiringAnalysis = {
    schema_version: 1,
    kind: "WIRING_COMPARISON",
    id: analysisId,
    product_pinout_id: product.id,
    wib_pinout_id: wib.id,
    product,
    wib,
    connector_mappings: mappings,
    net_aliases: aliases,
    case_sensitive: options.caseSensitive ?? false,
    verdict,
    verification_mode: "DOCUMENT_BACKED",
    pass_count: passCount,
    fail_count: failCount,
    review_count: reviewCount,
    not_applicable_count: verdict === "NOT_APPLICABLE" ? 1 : 0,
    connections,
    net_name_review: netNameReview,
    violations: findings,
    diagnostics,
    report_uri: `circuit://analysis/${analysisId}/report`,
    report_path: reportPath,
    elapsed_ms: Math.round(performance.now() - started)
  };

  const overviewName = "wiring-overview.svg";
  await writeFile(path.join(evidenceDirectory, overviewName), renderWiringSvg(analysis, null), "utf8");
  for (const finding of analysis.violations) {
    const fileName = `${safeSegment(finding.id)}.svg`;
    finding.evidence_uris = [`circuit://analysis/${analysisId}/evidence/${fileName}`];
    await writeFile(path.join(evidenceDirectory, fileName), renderWiringSvg(analysis, finding.id), "utf8");
  }
  await writeFile(reportPath, renderWiringReport(analysis, overviewName), "utf8");
  await writeFile(path.join(evidenceDirectory, "analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
  return analysis;
}

export async function readWiringAnalysis(analysisId: string, cacheDir: string): Promise<WiringAnalysis | null> {
  const file = path.join(cacheDir, "evidence", safeSegment(analysisId), "analysis.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as WiringAnalysis;
    return parsed.kind === "WIRING_COMPARISON" ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readPinout(pinoutId: string, cacheDir: string): Promise<PinoutDocument> {
  const file = path.join(cacheDir, "pinouts", `${safeSegment(pinoutId)}.json`);
  return JSON.parse(await readFile(file, "utf8")) as PinoutDocument;
}

export async function readAnalysisPinout(id: string, cacheDir: string): Promise<PinoutDocument> {
  const schematic = await tryReadCurrentSchematic(id, cacheDir);
  return schematic ? projectSchematicPinout(schematic) : readPinout(id, cacheDir);
}

async function savePinout(document: PinoutDocument, cacheDir: string) {
  const directory = path.join(cacheDir, "pinouts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${safeSegment(document.id)}.json`), JSON.stringify(document, null, 2), "utf8");
}

function parseJsonPinout(text: string, evidenceBase: Pick<PinEvidence, "source_path" | "source_hash">): { pins: PinConnection[]; designMetrics: DesignMetric[]; revision: string | null } {
  const value = JSON.parse(text) as unknown;
  const rows: Array<{ connector: unknown; pin: unknown; net_name: unknown }> = [];
  if (Array.isArray(value)) {
    for (const row of value) rows.push(jsonRow(row));
  } else if (isRecord(value) && Array.isArray(value.connectors)) {
    for (const connector of value.connectors) {
      if (!isRecord(connector) || !Array.isArray(connector.pins)) throw new Error("Each JSON connector must contain a pins array");
      const reference = connector.reference ?? connector.refdes ?? connector.connector;
      for (const pin of connector.pins) {
        if (!isRecord(pin)) throw new Error("Each JSON pin must be an object");
        rows.push({ connector: reference, pin: pin.pin ?? pin.number ?? pin.name, net_name: pin.net_name ?? pin.net ?? pin.netName });
      }
    }
  } else if (isRecord(value) && Array.isArray(value.pins)) {
    for (const row of value.pins) rows.push(jsonRow(row));
  } else {
    throw new Error("JSON pinout must be an array, { pins: [...] }, or { connectors: [...] }");
  }
  const designMetrics = isRecord(value) && Array.isArray(value.design_metrics)
    ? value.design_metrics.map((metric, index) => {
        if (!isRecord(metric)) throw new Error("Each design_metrics row must be an object");
        return {
          id: normalizedIdentifier(metric.id ?? metric.metric_id, "design metric id"),
          value: normalizedMetricValue(metric.value),
          unit: typeof metric.unit === "string" && metric.unit.trim() ? metric.unit.trim() : null,
          confidence: "EXPLICIT" as const,
          evidence: { ...evidenceBase, page: null, line: index + 1, bbox: null, excerpt: JSON.stringify(metric).slice(0, 500) }
        };
      })
    : [];
  return {
    pins: rows.map((row, index) => explicitPin(row, index + 1, JSON.stringify(row), evidenceBase)),
    designMetrics: validateDesignMetrics(designMetrics),
    revision: isRecord(value) && typeof value.revision === "string" && value.revision.trim() ? value.revision.trim() : null
  };
}

function jsonRow(value: unknown) {
  if (!isRecord(value)) throw new Error("Each JSON pinout row must be an object");
  return {
    connector: value.connector ?? value.refdes ?? value.reference,
    pin: value.pin ?? value.number ?? value.pin_number,
    net_name: value.net_name ?? value.net ?? value.netName
  };
}

function parseDelimitedPinout(text: string, delimiter: string, evidenceBase: Pick<PinEvidence, "source_path" | "source_hash">): PinConnection[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Delimited pinout must contain a header and at least one data row");
  const headers = splitDelimitedLine(lines[0]!, delimiter).map((header) => header.trim().toLowerCase());
  const connectorIndex = findHeader(headers, ["connector", "refdes", "reference", "connector_ref"]);
  const pinIndex = findHeader(headers, ["pin", "pin_number", "number"]);
  const netIndex = findHeader(headers, ["net_name", "net", "netname"]);
  return lines.slice(1).map((line, index) => {
    const fields = splitDelimitedLine(line, delimiter);
    return explicitPin({ connector: fields[connectorIndex], pin: fields[pinIndex], net_name: fields[netIndex] }, index + 2, line, evidenceBase);
  });
}

function parseTextPinout(text: string, evidenceBase: Pick<PinEvidence, "source_path" | "source_hash">): PinConnection[] {
  const pins: PinConnection[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const fields = line.trim().split(/[\s,;]+/);
    if (fields.length < 3) continue;
    pins.push(explicitPin({ connector: fields[0], pin: fields[1], net_name: fields.slice(2).join("_") }, index + 1, line, evidenceBase));
  }
  return pins;
}

async function parsePdfPinout(bytes: Buffer, evidenceBase: Pick<PinEvidence, "source_path" | "source_hash">): Promise<PinConnection[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false }).promise;
  const pins: PinConnection[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .filter((item): item is typeof item & { str: string; transform: number[]; width: number; height: number } => "str" in item)
      .map((item) => ({ text: item.str.trim(), x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, width: item.width, height: item.height }))
      .filter((item) => item.text);
    const lines = groupPdfLines(items);
    for (const [lineIndex, line] of lines.entries()) {
      const match = line.text.match(/\b([A-Za-z]{1,6}\d+[A-Za-z0-9_-]*)\s+(?:PIN\s*)?([A-Za-z0-9]+)\s+(?:NET(?:\s*NAME)?\s*[:=]?\s*)?([A-Za-z_+/.#-][A-Za-z0-9_+/.#-]*)\b/i);
      if (!match) continue;
      pins.push({
        connector: normalizedIdentifier(match[1], "connector"),
        pin: normalizedIdentifier(match[2], "pin"),
        net_name: normalizedNet(match[3]),
        confidence: "INFERRED",
        evidence: {
          ...evidenceBase,
          page: pageNumber,
          line: lineIndex + 1,
          bbox: line.bbox,
          excerpt: line.text.slice(0, 500)
        }
      });
    }
  }
  return pins;
}

function groupPdfLines(items: Array<{ text: string; x: number; y: number; width: number; height: number }>) {
  const groups: Array<typeof items> = [];
  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    const group = groups.find((candidate) => Math.abs((candidate[0]?.y ?? item.y) - item.y) <= Math.max(2, item.height * 0.35));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups.map((group) => {
    group.sort((left, right) => left.x - right.x);
    const minX = Math.min(...group.map((item) => item.x));
    const minY = Math.min(...group.map((item) => item.y));
    const maxX = Math.max(...group.map((item) => item.x + item.width));
    const maxY = Math.max(...group.map((item) => item.y + item.height));
    return { text: group.map((item) => item.text).join(" "), bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
  });
}

function explicitPin(
  row: { connector: unknown; pin: unknown; net_name: unknown },
  line: number,
  excerpt: string,
  evidenceBase: Pick<PinEvidence, "source_path" | "source_hash">
): PinConnection {
  return {
    connector: normalizedIdentifier(row.connector, "connector"),
    pin: normalizedIdentifier(row.pin, "pin"),
    net_name: normalizedNet(row.net_name),
    confidence: "EXPLICIT",
    evidence: { ...evidenceBase, page: null, line, bbox: null, excerpt: excerpt.slice(0, 500) }
  };
}

function validateCandidatePins(pins: PinConnection[]) {
  const unique = new Map<string, PinConnection>();
  for (const pin of pins) {
    const key = `${normalizedKey(pin.connector)}\u0000${normalizedKey(pin.pin)}`;
    const previous = unique.get(key);
    if (previous && normalizedKey(previous.net_name) !== normalizedKey(pin.net_name)) {
      throw new Error(`Conflicting NET NAME values for ${pin.connector}.${pin.pin}: ${previous.net_name} and ${pin.net_name}`);
    }
    if (!previous) unique.set(key, pin);
  }
  return [...unique.values()];
}

function validateConfirmedPins(pins: PinConnection[]) {
  const seen = new Set<string>();
  for (const pin of pins) {
    const key = `${normalizedKey(pin.connector)}\u0000${normalizedKey(pin.pin)}`;
    if (seen.has(key)) throw new Error(`Duplicate confirmed pin ${pin.connector}.${pin.pin}`);
    seen.add(key);
  }
  return pins;
}

function resolveConnectorMappings(product: PinoutDocument, wib: PinoutDocument, requested?: ConnectorMapping[]) {
  const diagnostics: WiringAnalysis["diagnostics"] = [];
  if (requested?.length) {
    const mappings = requested.map(validateMapping);
    const seenProduct = new Set<string>();
    const seenWib = new Set<string>();
    for (const mapping of mappings) {
      const productKey = normalizedKey(mapping.product_connector);
      const wibKey = normalizedKey(mapping.wib_connector);
      if (seenProduct.has(productKey) || seenWib.has(wibKey)) throw new Error("Each connector may appear in only one connector mapping");
      seenProduct.add(productKey);
      seenWib.add(wibKey);
      if (!hasConnector(product, mapping.product_connector)) throw new Error(`Unknown product connector ${mapping.product_connector}`);
      if (!hasConnector(wib, mapping.wib_connector)) throw new Error(`Unknown WIB connector ${mapping.wib_connector}`);
    }
    const unmappedProduct = connectorNames(product).filter((connector) => !seenProduct.has(normalizedKey(connector)));
    const unmappedWib = connectorNames(wib).filter((connector) => !seenWib.has(normalizedKey(connector)));
    if (unmappedProduct.length || unmappedWib.length) {
      diagnostics.push({
        code: "INCOMPLETE_CONNECTOR_SCOPE",
        severity: "WARNING",
        message: `The explicit mapping does not cover every imported connector. Unmapped product: ${unmappedProduct.join(", ") || "-"}; WIB: ${unmappedWib.join(", ") || "-"}. Import only the intended interface scope or map every connector before PASS.`
      });
    }
    return { mappings, diagnostics };
  }
  const productConnectors = connectorNames(product);
  const wibConnectors = connectorNames(wib);
  if (productConnectors.length === 1 && wibConnectors.length === 1) {
    return { mappings: [{ product_connector: productConnectors[0]!, wib_connector: wibConnectors[0]! }], diagnostics };
  }
  const wibByKey = new Map(wibConnectors.map((connector) => [normalizedKey(connector), connector]));
  const mappings = productConnectors
    .filter((connector) => wibByKey.has(normalizedKey(connector)))
    .map((connector) => ({ product_connector: connector, wib_connector: wibByKey.get(normalizedKey(connector))! }));
  const mappedProduct = new Set(mappings.map((mapping) => normalizedKey(mapping.product_connector)));
  const mappedWib = new Set(mappings.map((mapping) => normalizedKey(mapping.wib_connector)));
  const unresolvedProduct = productConnectors.filter((connector) => !mappedProduct.has(normalizedKey(connector)));
  const unresolvedWib = wibConnectors.filter((connector) => !mappedWib.has(normalizedKey(connector)));
  if (unresolvedProduct.length || unresolvedWib.length) {
    diagnostics.push({
      code: "NET_NAME_REVIEW_ONLY",
      severity: "WARNING",
      message: `Exact pin correspondence is unresolved. NET NAME review remains available without mapping. Unmapped product connectors: ${unresolvedProduct.join(", ") || "-"}; WIB: ${unresolvedWib.join(", ") || "-"}.`
    });
  }
  return { mappings, diagnostics };
}

function resolvePinPairs(mapping: ConnectorMapping, productPins: Map<string, PinConnection>, wibPins: Map<string, PinConnection>) {
  if (mapping.pin_map?.length) {
    const pairs = mapping.pin_map.map((pair) => ({ product_pin: normalizedIdentifier(pair.product_pin, "product pin"), wib_pin: normalizedIdentifier(pair.wib_pin, "WIB pin") }));
    const mappedProduct = new Set(pairs.map((pair) => normalizedKey(pair.product_pin)));
    const mappedWib = new Set(pairs.map((pair) => normalizedKey(pair.wib_pin)));
    for (const pin of productPins.values()) {
      if (!mappedProduct.has(normalizedKey(pin.pin))) pairs.push({ product_pin: pin.pin, wib_pin: `(unmapped ${pin.pin})` });
    }
    for (const pin of wibPins.values()) {
      if (!mappedWib.has(normalizedKey(pin.pin))) pairs.push({ product_pin: `(unmapped ${pin.pin})`, wib_pin: pin.pin });
    }
    return pairs;
  }
  const names = new Set([...productPins.values()].map((pin) => pin.pin));
  for (const pin of wibPins.values()) names.add(pin.pin);
  return [...names].sort(naturalCompare).map((pin) => ({ product_pin: pin, wib_pin: pin }));
}

function validateMapping(mapping: ConnectorMapping): ConnectorMapping {
  const pinMap = mapping.pin_map?.map((pair) => ({
    product_pin: normalizedIdentifier(pair.product_pin, "product pin"),
    wib_pin: normalizedIdentifier(pair.wib_pin, "WIB pin")
  }));
  if (pinMap) {
    const productPins = new Set<string>();
    const wibPins = new Set<string>();
    for (const pair of pinMap) {
      if (productPins.has(normalizedKey(pair.product_pin)) || wibPins.has(normalizedKey(pair.wib_pin))) throw new Error("pin_map must be one-to-one");
      productPins.add(normalizedKey(pair.product_pin));
      wibPins.add(normalizedKey(pair.wib_pin));
    }
  }
  return {
    product_connector: normalizedIdentifier(mapping.product_connector, "product connector"),
    wib_connector: normalizedIdentifier(mapping.wib_connector, "WIB connector"),
    ...(pinMap ? { pin_map: pinMap } : {})
  };
}

function validateAliases(aliases: NetAlias[]) {
  const product = new Set<string>();
  const wib = new Set<string>();
  return aliases.map((alias) => {
    const normalized = { product_net: normalizedNet(alias.product_net), wib_net: normalizedNet(alias.wib_net) };
    if (product.has(normalizedKey(normalized.product_net)) || wib.has(normalizedKey(normalized.wib_net))) throw new Error("net_aliases must be one-to-one");
    product.add(normalizedKey(normalized.product_net));
    wib.add(normalizedKey(normalized.wib_net));
    return normalized;
  });
}

function netsMatch(productNet: string, wibNet: string, aliases: NetAlias[], caseSensitive: boolean) {
  const key = (value: string) => caseSensitive ? value.trim() : normalizedKey(value);
  if (key(productNet) === key(wibNet)) return true;
  return aliases.some((alias) => key(alias.product_net) === key(productNet) && key(alias.wib_net) === key(wibNet));
}

function hasExactPinScope(product: PinoutDocument, wib: PinoutDocument, mappings: ConnectorMapping[], diagnostics: WiringAnalysis["diagnostics"]) {
  if (diagnostics.some((diagnostic) => diagnostic.code === "NET_NAME_REVIEW_ONLY" || diagnostic.code === "INCOMPLETE_CONNECTOR_SCOPE")) return false;
  if (mappings.length === 0 || mappings.length !== connectorNames(product).length || mappings.length !== connectorNames(wib).length) return false;
  return mappings.every((mapping) => {
    if (mapping.pin_map?.length) return true;
    const productPins = [...pinsForConnector(product, mapping.product_connector).keys()].sort();
    const wibPins = [...pinsForConnector(wib, mapping.wib_connector).keys()].sort();
    return productPins.length === wibPins.length && productPins.every((pin, index) => pin === wibPins[index]);
  });
}

function compareNetNameInventory(product: PinoutDocument, wib: PinoutDocument, aliases: NetAlias[], caseSensitive: boolean): NetNameReviewRow[] {
  const locations = (pins: PinConnection[]) => pins.map((pin) => `${pin.connector}.${pin.pin}`);
  const productGroups = groupPinsByNet(product.pins, caseSensitive);
  const wibGroups = groupPinsByNet(wib.pins, caseSensitive);
  const consumedWib = new Set<string>();
  const rows: NetNameReviewRow[] = [];
  for (const group of productGroups.values()) {
    const matched = [...wibGroups.entries()].find(([key, candidate]) => !consumedWib.has(key) && netsMatch(group.name, candidate.name, aliases, caseSensitive));
    if (!matched) {
      rows.push({ net_name: group.name, product_locations: locations(group.pins), wib_locations: [], product_count: group.pins.length, wib_count: 0, status: "PRODUCT_ONLY", message: `${group.name} appears only in the product interface inventory.` });
      continue;
    }
    consumedWib.add(matched[0]);
    const candidate = matched[1];
    const status = group.pins.length === candidate.pins.length ? "MATCH_CANDIDATE" : "COUNT_MISMATCH";
    rows.push({ net_name: group.name, product_locations: locations(group.pins), wib_locations: locations(candidate.pins), product_count: group.pins.length, wib_count: candidate.pins.length, status, message: status === "MATCH_CANDIDATE" ? "NET NAME and occurrence count match; pin correspondence is not asserted." : "NET NAME exists on both sides, but occurrence counts differ." });
  }
  for (const [key, group] of wibGroups) {
    if (consumedWib.has(key)) continue;
    rows.push({ net_name: group.name, product_locations: [], wib_locations: locations(group.pins), product_count: 0, wib_count: group.pins.length, status: "WIB_ONLY", message: `${group.name} appears only in the WIB interface inventory.` });
  }
  return rows.sort((left, right) => naturalCompare(left.net_name, right.net_name));
}

function groupPinsByNet(pins: PinConnection[], caseSensitive: boolean) {
  const groups = new Map<string, { name: string; pins: PinConnection[] }>();
  for (const pin of pins) {
    const key = caseSensitive ? pin.net_name.trim() : normalizedKey(pin.net_name);
    const group = groups.get(key) ?? { name: pin.net_name, pins: [] };
    group.pins.push(pin);
    groups.set(key, group);
  }
  return groups;
}

function makeFinding(
  analysisId: string,
  id: string,
  ruleId: string,
  verdict: WiringVerdict,
  message: string,
  productPin: PinConnection | null,
  wibPin: PinConnection | null,
  mapping: ConnectorMapping,
  pair: { product_pin: string; wib_pin: string }
): WiringFinding {
  return {
    id: `finding-${id}`,
    analysis_id: analysisId,
    rule_id: ruleId,
    title: ruleId === "NET_NAME_MISMATCH" ? "NET NAME mismatch" : ruleId === "UNCONFIRMED_MATCH" ? "Pinout confirmation required" : "Pin mapping mismatch",
    severity: verdict === "FAIL" ? "ERROR" : "WARNING",
    verdict,
    verification_mode: "DOCUMENT_BACKED",
    net_names: [productPin?.net_name, wibPin?.net_name].filter((value): value is string => Boolean(value)),
    component_refs: [mapping.product_connector, mapping.wib_connector],
    layer_ids: [],
    x_nm: 0,
    y_nm: 0,
    measured_value_nm: null,
    threshold_nm: null,
    message,
    evidence_uris: [],
    product_connector: mapping.product_connector,
    product_pin: pair.product_pin,
    product_net: productPin?.net_name ?? null,
    wib_connector: mapping.wib_connector,
    wib_pin: pair.wib_pin,
    wib_net: wibPin?.net_name ?? null
  };
}

function makeScopeFinding(analysisId: string, message: string): WiringFinding {
  const id = `finding-scope-${sha256(message).slice(0, 10)}`;
  return {
    id,
    analysis_id: analysisId,
    rule_id: "NET_NAME_REVIEW_ONLY",
    title: "NET NAME inventory review only",
    severity: "WARNING",
    verdict: "REVIEW",
    verification_mode: "DOCUMENT_BACKED",
    net_names: [],
    component_refs: [],
    layer_ids: [],
    x_nm: 0,
    y_nm: 0,
    measured_value_nm: null,
    threshold_nm: null,
    message,
    evidence_uris: [],
    product_connector: null,
    product_pin: null,
    product_net: null,
    wib_connector: null,
    wib_pin: null,
    wib_net: null
  };
}

function renderWiringReport(analysis: WiringAnalysis, overviewName: string) {
  const rows = analysis.connections.map((connection) => `<tr class="${connection.verdict.toLowerCase()}"><td>${html(connection.verdict)}</td><td>${html(`${connection.product_connector}.${connection.product_pin}`)}</td><td>${html(connection.product_net ?? "-")}</td><td>${html(connection.product_endpoint_refs?.join(", ") || "-")}</td><td>${html(`${connection.wib_connector}.${connection.wib_pin}`)}</td><td>${html(connection.wib_net ?? "-")}</td><td>${html(connection.wib_endpoint_refs?.join(", ") || "-")}</td><td>${html(connection.message)}</td></tr>`).join("");
  const netRows = analysis.net_name_review.map((row) => `<tr><td>${html(row.status)}</td><td>${html(row.net_name)}</td><td>${html(row.product_locations.join(", ") || "-")}</td><td>${row.product_count}</td><td>${html(row.wib_locations.join(", ") || "-")}</td><td>${row.wib_count}</td><td>${html(row.message)}</td></tr>`).join("");
  const inputRows = [analysis.product, analysis.wib].map((document) => `<tr><td>${html(document.role)}</td><td>${html(document.source_path)}</td><td>${html(document.revision ?? "-")}</td><td>${html(document.status)}</td><td>${html(document.source_hash)}</td></tr>`).join("");
  const diagnostics = analysis.diagnostics.length
    ? `<ul>${analysis.diagnostics.map((diagnostic) => `<li><strong>${html(diagnostic.code)}</strong> — ${html(diagnostic.message)}</li>`).join("")}</ul>`
    : "<p>None.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>WIB wiring ${html(analysis.verdict)}</title><style>${reportCss()}</style></head><body><main><header><div><p class="eyebrow">CircuitInspector · DOCUMENT_BACKED</p><h1>Product ↔ WIB wiring comparison</h1><p class="muted">Analysis ${html(analysis.id)}</p></div><span class="verdict ${analysis.verdict.toLowerCase()}">${html(analysis.verdict)}</span></header><section class="metrics"><div><strong>${analysis.pass_count}</strong><span>PASS</span></div><div><strong>${analysis.fail_count}</strong><span>FAIL</span></div><div><strong>${analysis.review_count}</strong><span>REVIEW</span></div></section><section><h2>Inputs and evidence state</h2><table><thead><tr><th>Role</th><th>Source</th><th>Revision</th><th>Status</th><th>SHA-256</th></tr></thead><tbody>${inputRows}</tbody></table></section>${netRows ? `<section><h2>NET NAME inventory review</h2><p class="muted">No connector or pin correspondence is assumed. Matching NET NAME values are review candidates, not proof of wiring identity.</p><table><thead><tr><th>Status</th><th>NET NAME</th><th>Product locations</th><th>Count</th><th>WIB locations</th><th>Count</th><th>Details</th></tr></thead><tbody>${netRows}</tbody></table></section>` : `<section><h2>Annotated wiring</h2><img class="diagram" src="${html(overviewName)}" alt="Annotated product to WIB pin mapping"></section><section><h2>Pin-by-pin result</h2><table><thead><tr><th>Status</th><th>Product pin</th><th>Product NET</th><th>Product chip endpoint</th><th>WIB pin</th><th>WIB NET</th><th>WIB chip endpoint</th><th>Details</th></tr></thead><tbody>${rows || "<tr><td colspan=\"8\">No pins were evaluated.</td></tr>"}</tbody></table></section>`}<section><h2>Diagnostics and unresolved evidence</h2>${diagnostics}</section><footer>NET NAME-only review cannot prove pin identity or detect swaps. PASS applies only to confirmed exact connector paths; automatically traced chip endpoints describe graph connectivity, not functional intent unless an approved constraint names the expected endpoint.</footer></main></body></html>`;
}

function renderWiringSvg(analysis: WiringAnalysis, activeFindingId: string | null) {
  const rowHeight = 54;
  const headerHeight = 86;
  const width = 1200;
  const height = Math.max(320, headerHeight + analysis.connections.length * rowHeight + 46);
  const activeConnection = activeFindingId?.replace(/^finding-/, "");
  const rows = analysis.connections.map((connection, index) => {
    const y = headerHeight + index * rowHeight + rowHeight / 2;
    const color = connection.verdict === "PASS" ? "#7fa06d" : connection.verdict === "FAIL" ? "#e0644d" : "#c9a052";
    const active = activeConnection === connection.id;
    return `<g data-connection="${html(connection.id)}"><rect x="24" y="${y - 22}" width="1152" height="44" rx="8" fill="${active ? "#3b2a24" : index % 2 ? "#181c1f" : "#141719"}" stroke="${active ? color : "#282d30"}"/><text x="48" y="${y - 4}" fill="#f0efeb" font-size="14" font-family="ui-monospace,monospace">${html(`${connection.product_connector}.${connection.product_pin}`)}</text><text x="48" y="${y + 14}" fill="#8f9695" font-size="12" font-family="ui-monospace,monospace">${html(connection.product_net ?? "MISSING")}</text><line x1="348" y1="${y}" x2="852" y2="${y}" stroke="${color}" stroke-width="${active ? 5 : 3}" stroke-dasharray="${connection.verdict === "PASS" ? "none" : "10 7"}"/><circle cx="348" cy="${y}" r="6" fill="${color}"/><circle cx="852" cy="${y}" r="6" fill="${color}"/><text x="600" y="${y - 8}" text-anchor="middle" fill="${color}" font-size="12" font-weight="700" font-family="ui-monospace,monospace">${html(connection.verdict)}</text><text x="1152" y="${y - 4}" text-anchor="end" fill="#f0efeb" font-size="14" font-family="ui-monospace,monospace">${html(`${connection.wib_connector}.${connection.wib_pin}`)}</text><text x="1152" y="${y + 14}" text-anchor="end" fill="#8f9695" font-size="12" font-family="ui-monospace,monospace">${html(connection.wib_net ?? "MISSING")}</text></g>`;
  }).join("");
  const empty = analysis.connections.length ? "" : `<text x="600" y="190" text-anchor="middle" fill="#8f9695" font-size="18">NET NAME review only — no pin correspondence asserted</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#111416"/><text x="48" y="38" fill="#f0efeb" font-size="20" font-weight="700" font-family="ui-sans-serif,sans-serif">PRODUCT SCHEMATIC</text><text x="1152" y="38" text-anchor="end" fill="#f0efeb" font-size="20" font-weight="700" font-family="ui-sans-serif,sans-serif">WIB SCHEMATIC</text><text x="48" y="62" fill="#737a79" font-size="12" font-family="ui-monospace,monospace">${html(analysis.product.source_path)}</text><text x="1152" y="62" text-anchor="end" fill="#737a79" font-size="12" font-family="ui-monospace,monospace">${html(analysis.wib.source_path)}</text>${rows}${empty}</svg>`;
}

function reportCss() {
  return `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#111416;color:#ecebe7}body{margin:0}main{max-width:1320px;margin:auto;padding:38px}header{display:flex;justify-content:space-between;gap:24px;align-items:start;border-bottom:1px solid #2b3032;padding-bottom:24px}h1{margin:.15rem 0;font-size:30px}h2{font-size:16px;margin:0 0 14px}.eyebrow,.muted,footer{color:#858b89}.eyebrow{font:11px ui-monospace;letter-spacing:.12em}.verdict{padding:10px 18px;border-radius:999px;font:700 14px ui-monospace}.pass{color:#a9c994}.fail{color:#f09884}.review{color:#e1bb73}.verdict.pass{background:#263423}.verdict.fail{background:#422720}.verdict.review{background:#3b321f}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metrics div{background:#171b1d;border:1px solid #2a3032;border-radius:12px;padding:18px}.metrics strong{display:block;font-size:26px}.metrics span{font:10px ui-monospace;color:#7d8381}section{margin-top:28px}.diagram{display:block;width:100%;border:1px solid #2a3032;border-radius:12px;background:#111416}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:11px 12px;text-align:left;border-bottom:1px solid #292e30;vertical-align:top}th{font:10px ui-monospace;color:#8f9694;text-transform:uppercase}td:nth-child(-n+5){font-family:ui-monospace,monospace}tr.fail{background:#2b1d1a}tr.review{background:#292418}ul{line-height:1.7}footer{margin-top:34px;padding-top:20px;border-top:1px solid #2b3032;font-size:11px;line-height:1.6;word-break:break-word}`;
}

interface ComparisonInputs {
  product: PinoutDocument;
  wib: PinoutDocument;
  productDocument: SchematicDocument | null;
  wibDocument: SchematicDocument | null;
}

async function loadComparisonInputs(productId: string, wibId: string, cacheDir: string): Promise<ComparisonInputs> {
  const [currentProduct, currentWib] = await Promise.all([
    tryReadCurrentSchematic(productId, cacheDir),
    tryReadCurrentSchematic(wibId, cacheDir)
  ]);
  if (!currentProduct && !currentWib) {
    const [product, wib] = await Promise.all([readPinout(productId, cacheDir), readPinout(wibId, cacheDir)]);
    return { product, wib, productDocument: null, wibDocument: null };
  }
  const { readSchematicDocument } = await import("./schematic.js");
  const [productDocument, wibDocument] = await Promise.all([
    currentProduct ?? readSchematicDocument(productId, cacheDir),
    currentWib ?? readSchematicDocument(wibId, cacheDir)
  ]);
  return {
    product: projectSchematicPinout(productDocument),
    wib: projectSchematicPinout(wibDocument),
    productDocument,
    wibDocument
  };
}

async function tryReadCurrentSchematic(id: string, cacheDir: string): Promise<SchematicDocument | null> {
  const file = path.join(cacheDir, "schematics", safeSegment(id), "document.json");
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as SchematicDocument;
    return value.schema_version === 2 ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function projectSchematicPinout(document: SchematicDocument): PinoutDocument {
  return {
    schema_version: 1,
    id: document.id,
    role: document.role,
    source_path: document.source_path,
    source_hash: document.source_hash,
    source_format: document.source_format,
    revision: document.revision,
    status: document.source_format !== "PDF" && document.status === "CONFIRMED" ? "CONFIRMED" : "DRAFT",
    pins: document.pins.map((pin) => ({
      connector: pin.connector,
      pin: pin.pin,
      net_name: pin.net_name,
      confidence: pin.confidence,
      evidence: {
        source_path: pin.evidence?.source_path ?? document.source_path,
        source_hash: pin.evidence?.source_hash ?? document.source_hash,
        page: pin.evidence?.page ?? null,
        line: pin.evidence?.line ?? null,
        bbox: null,
        excerpt: pin.evidence?.excerpt ?? `${pin.connector} ${pin.pin} ${pin.net_name}`
      }
    })),
    design_metrics: document.design_metrics.map((metric, index) => {
      const evidence = (metric as DesignMetric).evidence;
      return {
        id: metric.id,
        value: metric.value,
        unit: metric.unit,
        confidence: metric.confidence,
        evidence: evidence ?? {
          source_path: document.source_path,
          source_hash: document.source_hash,
          page: null,
          line: index + 1,
          bbox: null,
          excerpt: `${metric.id}=${metric.value}`
        }
      };
    }),
    diagnostics: document.diagnostics,
    confirmation: document.confirmation
  };
}

function schematicIdentity(document: SchematicDocument) {
  return {
    source_hash: document.source_hash,
    parser_version: document.parser_version,
    confirmations: document.confirmed_scopes.map((scope) => scope.content_hash).sort(),
    corrections: document.corrections.map((correction) => correction.content_hash).sort()
  };
}

function schematicPinState(document: SchematicDocument, connector: string, number: string) {
  const component = document.components.find((item) => normalizedKey(item.refdes) === normalizedKey(connector));
  const pin = component
    ? document.graph_pins.find((item) => item.component_id === component.id && normalizedKey(item.number) === normalizedKey(number))
    : undefined;
  const pathResult = pin ? document.paths.find((item) => item.anchor_pin_id === pin.id) : undefined;
  const endpointRefs = pathResult ? schematicEndpointRefs(document, pathResult) : [];
  const pathComponents = pathResult?.component_ids.flatMap((id) => {
    const item = document.components.find((component) => component.id === id);
    return item ? [item] : [];
  }) ?? [];
  if (document.source_format !== "PDF") {
    return {
      path: pathResult,
      endpointRefs,
      componentRefs: pathComponents.map((item) => item.refdes),
      componentKinds: pathComponents.map((item) => item.kind),
      confirmed: document.status === "CONFIRMED",
      resolved: true,
      summary: document.status === "CONFIRMED" ? "confirmed structured mapping" : "unconfirmed structured mapping"
    };
  }
  const confirmed = Boolean(pathResult && document.confirmed_scopes.some((scope) => scope.path_ids.includes(pathResult.id)));
  const resolved = pathResult?.status === "RESOLVED" && pathResult.endpoint_pin_ids.length === 1;
  return {
    path: pathResult,
    endpointRefs,
    componentRefs: pathComponents.map((item) => item.refdes),
    componentKinds: pathComponents.map((item) => item.kind),
    confirmed,
    resolved,
    summary: pathResult ? `${pathResult.status}, ${endpointRefs.length} chip endpoint(s), ${confirmed ? "confirmed" : "unconfirmed"}` : "missing traced path"
  };
}

function interfaceFullyConfirmed(document: SchematicDocument, connector: string) {
  if (document.source_format !== "PDF") return document.status === "CONFIRMED";
  const component = document.components.find((item) => normalizedKey(item.refdes) === normalizedKey(connector));
  if (!component?.pin_ids.length) return false;
  return component.pin_ids.every((pinId) => {
    const pathResult = document.paths.find((item) => item.anchor_pin_id === pinId);
    return pathResult?.status === "RESOLVED"
      && pathResult.endpoint_pin_ids.length === 1
      && document.confirmed_scopes.some((scope) => scope.path_ids.includes(pathResult.id));
  });
}

function schematicEndpointRefs(document: SchematicDocument, pathResult: SchematicPath) {
  const components = new Map(document.components.map((component) => [component.id, component]));
  const pins = new Map(document.graph_pins.map((pin) => [pin.id, pin]));
  return pathResult.endpoint_pin_ids.flatMap((id) => {
    const pin = pins.get(id);
    const component = pin ? components.get(pin.component_id) : undefined;
    return pin && component ? [`${component.refdes}.${pin.number}`] : [];
  });
}

function connectorNames(document: PinoutDocument) {
  return [...new Set(document.pins.map((pin) => pin.connector))].sort(naturalCompare);
}

function hasConnector(document: PinoutDocument, connector: string) {
  return document.pins.some((pin) => normalizedKey(pin.connector) === normalizedKey(connector));
}

function pinsForConnector(document: PinoutDocument, connector: string) {
  return new Map(document.pins.filter((pin) => normalizedKey(pin.connector) === normalizedKey(connector)).map((pin) => [normalizedKey(pin.pin), pin]));
}

function comparablePins(pins: PinConnection[]) {
  return pins.map(({ connector, pin, net_name }) => ({ connector, pin, net_name }));
}

function comparableMetrics(metrics: DesignMetric[]) {
  return metrics.map(({ id, value, unit }) => ({ id, value, unit })).sort((left, right) => naturalCompare(left.id, right.id));
}

function validateDesignMetrics(metrics: DesignMetric[], requireUnits = false) {
  const seen = new Set<string>();
  for (const metric of metrics) {
    const key = normalizedKey(metric.id);
    if (seen.has(key)) throw new Error(`Duplicate design metric ${metric.id}`);
    seen.add(key);
    if (requireUnits && !metric.unit?.trim()) throw new Error(`Design metric ${metric.id} requires a unit before confirmation`);
  }
  return [...metrics].sort((left, right) => naturalCompare(left.id, right.id));
}

function normalizedMetricValue(value: unknown): string | number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Design metric value must be finite");
    return value;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error("Design metric value must be a finite number or non-empty string");
}

function connectionId(mapping: ConnectorMapping, productPin: string, wibPin: string) {
  return `${safeSegment(mapping.product_connector)}-${safeSegment(productPin)}--${safeSegment(mapping.wib_connector)}-${safeSegment(wibPin)}`;
}

function normalizedIdentifier(value: unknown, field: string) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${field} is required`);
  const text = String(value).trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > 128) throw new Error(`${field} is too long`);
  return text;
}

function normalizedNet(value: unknown) {
  return normalizedIdentifier(value, "net_name");
}

function normalizedKey(value: string) {
  return value.trim().toLocaleUpperCase("en-US");
}

function safeSegment(value: string) {
  const segment = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!segment || segment.length > 160) throw new Error("Invalid CircuitInspector identifier");
  return segment;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function sortPins(pins: PinConnection[]) {
  return [...pins].sort((left, right) => naturalCompare(left.connector, right.connector) || naturalCompare(left.pin, right.pin));
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function findHeader(headers: string[], candidates: string[]) {
  const index = headers.findIndex((header) => candidates.includes(header));
  if (index < 0) throw new Error(`Missing required column: ${candidates[0]}`);
  return index;
}

function splitDelimitedLine(line: string, delimiter: string) {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Unterminated quoted field in pinout row");
  fields.push(field.trim());
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function html(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
