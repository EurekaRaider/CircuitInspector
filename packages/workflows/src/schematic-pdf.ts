import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type {
  Diagnostic,
  SchematicBox,
  SchematicComponent,
  SchematicDocument,
  SchematicEvidence,
  SchematicGraphPin,
  SchematicJunction,
  SchematicLabel,
  SchematicNet,
  SchematicPage,
  SchematicWire
} from "@circuit-inspector/contracts";
import { classifySchematicComponent } from "./schematic-graph.js";

const PAGE_RENDER_MAX_EDGE = 4096;
const TEXT_TOKEN_MINIMUM = 4;
const REF_DESIGNATOR = /^(?:U|IC|MCU|FPGA|J|P|CN|X|CONN|R|C|L|FB|F|FL|NTC|PTC|D|TVS|ESD|Q)\d+[A-Z0-9_-]*$/i;
const EXPLICIT_PIN_ROW = /\b((?:U|IC|MCU|FPGA|J|P|CN|X|CONN|R|C|L|FB|F|FL|NTC|PTC|D|TVS|ESD|Q)\d+[A-Z0-9_-]*)\s+(?:PIN\s*)?([A-Z0-9]+)\s+(?:NET(?:\s*NAME)?\s*[:=]?\s*)?([A-Z_+/.#-][A-Z0-9_+/.#-]*)\b/i;
const COMPACT_EXPLICIT_PIN_ROW = /^((?:U|IC|MCU|FPGA|J|P|CN|X|CONN|R|C|L|FB|F|FL|NTC|PTC|D|TVS|ESD|Q)\d+[A-Z0-9_-]*?)_?PIN([A-Z0-9]+)NET(?:NAME)?[:=]?([A-Z_+/.#-][A-Z0-9_+/.#-]*)$/i;
const NET_LABEL = /^[A-Z_+/.#-][A-Z0-9_+/.#-]{1,63}$/i;
const IGNORED_LABELS = new Set(["PIN", "NET", "NAME", "SHEET", "PAGE", "TITLE", "REV", "REVISION", "PRODUCT", "WIB", "CIRCUITINSPECTOR"]);

interface TextToken {
  text: string;
  box: SchematicBox;
  confidence: number;
  method: "PDF_TEXT" | "OCR";
}

interface PdfParseInput {
  bytes: Buffer;
  sourcePath: string;
  sourceHash: string;
  id: string;
  role: "PRODUCT" | "WIB";
  revision: string | null;
  directory: string;
  onProgress?: ((progress: number, message: string) => void) | undefined;
}

export async function parseSchematicPdf(input: PdfParseInput): Promise<SchematicDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfAssets = resolvePdfAssetPaths();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(input.bytes),
    useWorkerFetch: false,
    standardFontDataUrl: directoryUrl(pdfAssets.standardFonts),
    cMapUrl: directoryUrl(pdfAssets.cMaps),
    cMapPacked: true,
    wasmUrl: directoryUrl(pdfAssets.wasm)
  });
  const pdf = await loadingTask.promise;
  if (pdf.numPages > 500) throw new Error(`Schematic PDF has ${pdf.numPages} pages; the safety limit is 500 pages.`);
  const pagesDirectory = path.join(input.directory, "pages");
  await mkdir(pagesDirectory, { recursive: true });

  const pages: SchematicPage[] = [];
  const pageTokens = new Map<number, TextToken[]>();
  const wires: SchematicWire[] = [];
  const junctions: SchematicJunction[] = [];
  const diagnostics: Diagnostic[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    input.onProgress?.(Math.round((pageNumber - 1) / Math.max(1, pdf.numPages) * 72), `Rendering schematic page ${pageNumber}/${pdf.numPages}`);
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, PAGE_RENDER_MAX_EDGE / Math.max(baseViewport.width, baseViewport.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    const png = canvas.toBuffer("image/png");
    const renderPath = path.join(pagesDirectory, `page-${pageNumber}.png`);
    await writeFile(renderPath, png);

    const thumbnail = createCanvas(Math.max(1, Math.round(canvas.width * 0.2)), Math.max(1, Math.round(canvas.height * 0.2)));
    thumbnail.getContext("2d").drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
    const thumbnailPath = path.join(pagesDirectory, `page-${pageNumber}-thumb.png`);
    await writeFile(thumbnailPath, thumbnail.toBuffer("image/png"));

    const extractedTokens = await pdfTextTokens(page, scale, canvas.height);
    const useOcr = meaningfulTokenCount(extractedTokens) < TEXT_TOKEN_MINIMUM;
    const tokens = useOcr ? await recognizePage(png, input.onProgress, pageNumber, pdf.numPages) : extractedTokens;
    pageTokens.set(pageNumber, tokens);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const detectedWires = detectOrthogonalWires(imageData.data, canvas.width, canvas.height, tokens, pageNumber, input);
    wires.push(...detectedWires);
    junctions.push(...detectJunctions(imageData.data, canvas.width, canvas.height, detectedWires, pageNumber, input));
    pages.push({
      number: pageNumber,
      width: canvas.width,
      height: canvas.height,
      render_path: renderPath,
      thumbnail_path: thumbnailPath,
      extraction: useOcr ? "OCR" : "VECTOR_TEXT"
    });
    if (useOcr) diagnostics.push({ code: "SCANNED_PDF_OCR", severity: "WARNING", message: `Page ${pageNumber} used local OCR; extracted connectivity remains REVIEW until relevant paths are confirmed.` });
  }
  await loadingTask.destroy();

  input.onProgress?.(76, "Building schematic connectivity graph");
  const semantic = buildSemanticGraph(input, pageTokens, wires, junctions, diagnostics);
  const semanticWireIds = new Set(semantic.wires.map((wire) => wire.id));
  const semanticJunctions = junctions
    .map((junction) => ({ ...junction, connected_wire_ids: junction.connected_wire_ids.filter((id) => semanticWireIds.has(id)) }))
    .filter((junction) => junction.connected_wire_ids.length >= 2);
  return {
    schema_version: 2,
    parser_version: "schematic-v2.0.1",
    id: input.id,
    role: input.role,
    source_path: input.sourcePath,
    source_hash: input.sourceHash,
    source_format: "PDF",
    revision: input.revision,
    status: "DRAFT",
    pages,
    components: semantic.components,
    graph_pins: semantic.pins,
    nets: semantic.nets,
    wires: semantic.wires,
    junctions: semanticJunctions,
    labels: semantic.labels,
    edges: [],
    interface_candidates: [],
    paths: [],
    corrections: [],
    confirmed_scopes: [],
    pins: semantic.legacyPins,
    design_metrics: [],
    diagnostics,
    confirmation: null
  };
}

async function pdfTextTokens(page: { getTextContent(): Promise<{ items: unknown[] }> }, scale: number, pageHeight: number): Promise<TextToken[]> {
  const content = await page.getTextContent();
  const tokens: TextToken[] = [];
  for (const value of content.items) {
    if (!isTextItem(value)) continue;
    const text = value.str.trim();
    if (!text) continue;
    const width = Math.max(1, value.width * scale);
    const height = Math.max(1, value.height * scale);
    tokens.push({
      text,
      box: {
        x: (value.transform[4] ?? 0) * scale,
        y: pageHeight - (value.transform[5] ?? 0) * scale - height,
        width,
        height
      },
      confidence: 0.96,
      method: "PDF_TEXT"
    });
  }
  return tokens;
}

async function recognizePage(png: Buffer, onProgress: PdfParseInput["onProgress"], pageNumber: number, pageCount: number): Promise<TextToken[]> {
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  const paths = resolveOcrPaths();
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: paths.workerPath,
    corePath: paths.corePath,
    langPath: paths.langPath,
    cacheMethod: "none",
    gzip: true,
    logger: (message) => {
      const pageBase = 5 + (pageNumber - 1) / Math.max(1, pageCount) * 65;
      const pageShare = message.progress / Math.max(1, pageCount) * 65;
      onProgress?.(Math.min(70, Math.round(pageBase + pageShare)), `OCR page ${pageNumber}/${pageCount}: ${message.status}`);
    }
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+-/.#:=()[]",
      preserve_interword_spaces: "1",
      user_defined_dpi: "144"
    });
    const result = await worker.recognize(png, {}, { blocks: true, text: true });
    const tokens: TextToken[] = [];
    for (const block of result.data.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          for (const word of line.words ?? []) {
            const text = word.text.trim();
            if (!text) continue;
            tokens.push({
              text,
              box: { x: word.bbox.x0, y: word.bbox.y0, width: word.bbox.x1 - word.bbox.x0, height: word.bbox.y1 - word.bbox.y0 },
              confidence: Math.max(0, Math.min(1, word.confidence / 100)),
              method: "OCR"
            });
          }
        }
      }
    }
    return tokens;
  } finally {
    await worker.terminate();
  }
}

function resolveOcrPaths() {
  const configured = process.env.CIRCUIT_INSPECTOR_OCR_DIR;
  if (configured) {
    return {
      workerPath: process.env.CIRCUIT_INSPECTOR_OCR_WORKER ?? path.join(configured, "ocr-worker.cjs"),
      corePath: configured,
      langPath: path.join(configured, "lang")
    };
  }
  const root = path.resolve(process.cwd(), "node_modules");
  return {
    workerPath: path.join(root, "tesseract.js", "src", "worker-script", "node", "index.js"),
    corePath: path.join(root, "tesseract.js-core"),
    langPath: path.join(root, "@tesseract.js-data", "eng", "4.0.0_best_int")
  };
}

function resolvePdfAssetPaths() {
  const root = process.env.CIRCUIT_INSPECTOR_PDF_ASSET_DIR ?? path.resolve(process.cwd(), "node_modules", "pdfjs-dist");
  return {
    standardFonts: path.join(root, "standard_fonts"),
    cMaps: path.join(root, "cmaps"),
    wasm: path.join(root, "wasm")
  };
}

function directoryUrl(value: string) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function buildSemanticGraph(
  input: PdfParseInput,
  pageTokens: Map<number, TextToken[]>,
  sourceWires: SchematicWire[],
  junctions: SchematicJunction[],
  diagnostics: Diagnostic[]
) {
  const components = new Map<string, SchematicComponent>();
  const pins = new Map<string, SchematicGraphPin>();
  const nets = new Map<string, SchematicNet>();
  const labels: SchematicLabel[] = [];
  const legacyPins: SchematicDocument["pins"] = [];
  let wires = sourceWires;
  const lineGroups = groupTokensByLine(pageTokens);

  for (const line of lineGroups) {
    const match = line.text.match(EXPLICIT_PIN_ROW) ?? line.text.replace(/\s+/g, "").match(COMPACT_EXPLICIT_PIN_ROW);
    if (!match) continue;
    const [refdes, pinNumber, netName] = [match[1]!, match[2]!, match[3]!];
    const evidence = evidenceFor(input, line.page, line.box, line.text, line.tokens.some((token) => token.method === "OCR") ? "OCR" : "PDF_TEXT", minimumTokenConfidence(line.tokens));
    const component = ensureComponent(components, refdes, line.page, line.box, evidence);
    const net = ensureNet(nets, netName, evidence);
    const pin = ensurePin(pins, component, pinNumber, net.id, line.page, centerX(line.box), centerY(line.box), evidence);
    addUnique(component.pin_ids, pin.id);
    addUnique(net.pin_ids, pin.id);
    legacyPins.push({ connector: refdes, pin: pinNumber, net_name: netName, confidence: evidence.method === "OCR" ? "INFERRED" : "EXPLICIT", evidence: { source_path: input.sourcePath, source_hash: input.sourceHash, page: line.page, line: null, excerpt: line.text } });
  }

  for (const [page, tokens] of pageTokens) {
    const refdesTokens = tokens.filter((token) => REF_DESIGNATOR.test(token.text) && !/(?:PIN|NET)/i.test(token.text));
    for (const token of refdesTokens) {
      const evidence = evidenceFor(input, page, token.box, token.text, token.method, token.confidence);
      const enclosure = enclosingRectangle(token.box, sourceWires.filter((wire) => wire.page === page));
      const component = ensureComponent(components, token.text, page, enclosure ?? expandBox(token.box, 42, 26), evidence);
      if (enclosure) {
        component.bbox = enclosure;
        component.page = page;
      }
    }
  }

  const boundaryWireIds = componentBoundaryWireIds([...components.values()], sourceWires);
  wires = connectWireNetworks(sourceWires.filter((wire) => !boundaryWireIds.has(wire.id)), junctions);
  for (const [page, tokens] of pageTokens) {
    for (const token of tokens) {
      const normalized = token.text.replace(/[,:;]$/, "");
      if (!isNetLabel(normalized)) continue;
      const nearestWire = findNearestWire(centerX(token.box), centerY(token.box), wires.filter((wire) => wire.page === page), 32);
      if (!nearestWire) continue;
      const evidence = evidenceFor(input, page, token.box, normalized, token.method, token.confidence);
      const label: SchematicLabel = {
        id: `label-${page}-${labels.length + 1}`,
        page,
        text: normalized,
        kind: /^(?:TO_|FROM_|OFFPAGE_)/i.test(normalized) ? "OFF_PAGE" : "NET",
        x: centerX(token.box),
        y: centerY(token.box),
        net_id: null,
        evidence
      };
      const net = ensureNet(nets, normalized, evidence);
      label.net_id = net.id;
      nearestWire.net_id = net.id;
      addUnique(net.wire_ids, nearestWire.id);
      addUnique(net.label_ids, label.id);
      addUnique(net.page_numbers, page);
      labels.push(label);
    }
  }

  inferSpatialPins(input, components, pins, nets, wires, pageTokens, legacyPins);
  propagateWireNetNames(wires, nets, diagnostics);
  for (const pin of pins.values()) {
    const component = components.get(pin.component_id);
    if (component) addUnique(component.pin_ids, pin.id);
    if (pin.net_id) {
      const net = nets.get(pin.net_id);
      if (net) addUnique(net.pin_ids, pin.id);
    }
  }
  for (const component of components.values()) {
    if ((component.kind === "PASSIVE" || component.kind === "PROTECTION") && component.pin_ids.length === 2) component.passthrough_pin_pairs = [[component.pin_ids[0]!, component.pin_ids[1]!]];
  }
  if (![...components.values()].some((component) => component.kind === "CONNECTOR")) diagnostics.push({ code: "NO_INTERFACE_CONNECTOR", severity: "ERROR", message: "No connector candidate could be identified in the schematic PDF." });
  if (![...components.values()].some((component) => component.kind === "IC")) diagnostics.push({ code: "NO_IC_COMPONENT", severity: "WARNING", message: "No IC reference designator could be identified; WIB-to-chip endpoint tracing remains REVIEW." });
  if ([...pins.values()].length === 0) diagnostics.push({ code: "NO_SCHEMATIC_PINS", severity: "ERROR", message: "No component pin evidence could be extracted from the schematic PDF." });
  return { components: [...components.values()], pins: [...pins.values()], nets: [...nets.values()], wires, labels, legacyPins: dedupeLegacyPins(legacyPins) };
}

function detectOrthogonalWires(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tokens: TextToken[],
  page: number,
  input: PdfParseInput
): SchematicWire[] {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const gray = ((rgba[offset] ?? 255) * 30 + (rgba[offset + 1] ?? 255) * 59 + (rgba[offset + 2] ?? 255) * 11) / 100;
      mask[y * width + x] = gray < 115 ? 1 : 0;
    }
  }
  for (const token of tokens) {
    const left = Math.max(0, Math.floor(token.box.x - 2));
    const top = Math.max(0, Math.floor(token.box.y - 2));
    const right = Math.min(width - 1, Math.ceil(token.box.x + token.box.width + 2));
    const bottom = Math.min(height - 1, Math.ceil(token.box.y + token.box.height + 2));
    for (let y = top; y <= bottom; y += 1) mask.fill(0, y * width + left, y * width + right + 1);
  }
  const minimum = Math.max(20, Math.round(Math.min(width, height) * 0.012));
  const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let y = 0; y < height; y += 2) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const black = x < width && mask[y * width + x] === 1;
      if (black && start < 0) start = x;
      if (!black && start >= 0) {
        if (x - start >= minimum) segments.push({ x1: start, y1: y, x2: x - 1, y2: y });
        start = -1;
      }
    }
  }
  for (let x = 0; x < width; x += 2) {
    let start = -1;
    for (let y = 0; y <= height; y += 1) {
      const black = y < height && mask[y * width + x] === 1;
      if (black && start < 0) start = y;
      if (!black && start >= 0) {
        if (y - start >= minimum) segments.push({ x1: x, y1: start, x2: x, y2: y - 1 });
        start = -1;
      }
    }
  }
  return mergeCollinearSegments(segments).map((segment, index) => ({
    id: `wire-${page}-${index + 1}`,
    page,
    ...segment,
    net_id: null,
    evidence: evidenceFor(input, page, lineBox(segment), "Detected schematic line", "PDF_VECTOR", 0.72)
  }));
}

function detectJunctions(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  wires: SchematicWire[],
  page: number,
  input: PdfParseInput
): SchematicJunction[] {
  const horizontal = wires.filter((wire) => wire.y1 === wire.y2);
  const vertical = wires.filter((wire) => wire.x1 === wire.x2);
  const junctions: SchematicJunction[] = [];
  for (const h of horizontal) {
    for (const v of vertical) {
      const x = v.x1;
      const y = h.y1;
      if (x < Math.min(h.x1, h.x2) || x > Math.max(h.x1, h.x2) || y < Math.min(v.y1, v.y2) || y > Math.max(v.y1, v.y2)) continue;
      const endpointTouch = nearPoint(x, y, h.x1, h.y1, 4) || nearPoint(x, y, h.x2, h.y2, 4) || nearPoint(x, y, v.x1, v.y1, 4) || nearPoint(x, y, v.x2, v.y2, 4);
      const dark = darkPixelCount(rgba, width, height, x, y, 5);
      if (!endpointTouch && dark < 42) continue;
      const connected = [h.id, v.id];
      junctions.push({
        id: `junction-${page}-${Math.round(x)}-${Math.round(y)}`,
        page,
        x,
        y,
        connected_wire_ids: connected,
        evidence: evidenceFor(input, page, { x: x - 5, y: y - 5, width: 10, height: 10 }, endpointTouch ? "Wire endpoint junction" : "Detected junction dot", "PDF_VECTOR", endpointTouch ? 0.82 : 0.68)
      });
    }
  }
  return [...new Map(junctions.map((junction) => [junction.id, junction])).values()];
}

function connectWireNetworks(wires: SchematicWire[], junctions: SchematicJunction[]) {
  const parent = new Map(wires.map((wire) => [wire.id, wire.id]));
  const knownWireIds = new Set(parent.keys());
  const find = (id: string): string => {
    const known = parent.get(id) ?? id;
    if (known === id) return id;
    const root = find(known);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => parent.set(find(left), find(right));
  for (const junction of junctions) {
    const [first, ...rest] = junction.connected_wire_ids.filter((id) => knownWireIds.has(id));
    if (first) rest.forEach((id) => union(first, id));
  }
  for (let leftIndex = 0; leftIndex < wires.length; leftIndex += 1) {
    const left = wires[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < wires.length; rightIndex += 1) {
      const right = wires[rightIndex]!;
      if (left.page !== right.page) continue;
      if (wireEndpointsTouch(left, right, 5)) union(left.id, right.id);
    }
  }
  for (const wire of wires) (wire as SchematicWire & { group?: string }).group = find(wire.id);
  return wires;
}

function propagateWireNetNames(wires: SchematicWire[], nets: Map<string, SchematicNet>, diagnostics: Diagnostic[]) {
  const groups = new Map<string, SchematicWire[]>();
  for (const wire of wires) {
    const group = (wire as SchematicWire & { group?: string }).group ?? wire.id;
    const current = groups.get(group) ?? [];
    current.push(wire);
    groups.set(group, current);
  }
  for (const group of groups.values()) {
    const assigned = [...new Set(group.map((wire) => wire.net_id).filter((id): id is string => Boolean(id)))];
    if (assigned.length > 1) {
      const names = assigned.map((id) => nets.get(id)?.name ?? id);
      diagnostics.push({ code: "CONFLICTING_NET_LABELS", severity: "WARNING", message: `One detected wire group carries conflicting labels: ${names.join(", ")}.` });
      continue;
    }
    const netId = assigned[0];
    if (!netId) continue;
    const net = nets.get(netId);
    for (const wire of group) {
      wire.net_id = netId;
      if (net) {
        addUnique(net.wire_ids, wire.id);
        addUnique(net.page_numbers, wire.page);
      }
    }
  }
}

function inferSpatialPins(
  input: PdfParseInput,
  components: Map<string, SchematicComponent>,
  pins: Map<string, SchematicGraphPin>,
  nets: Map<string, SchematicNet>,
  wires: SchematicWire[],
  pageTokens: Map<number, TextToken[]>,
  legacyPins: SchematicDocument["pins"]
) {
  for (const component of components.values()) {
    if (!component.bbox || component.page == null) continue;
    const tokens = pageTokens.get(component.page) ?? [];
    const nearbyNumbers = tokens.filter((token) => /^[A-Z]?\d{1,4}$/i.test(token.text) && distanceToBox(centerX(token.box), centerY(token.box), component.bbox!) <= 28);
    for (const token of nearbyNumbers) {
      const x = centerX(token.box);
      const y = centerY(token.box);
      const wire = findNearestWire(x, y, wires.filter((candidate) => candidate.page === component.page), 38);
      const net = wire?.net_id ? nets.get(wire.net_id) : undefined;
      const evidence = evidenceFor(input, component.page, token.box, `${component.refdes} pin ${token.text}${net?.name ? ` ${net.name}` : ""}`, token.method, token.confidence * 0.82);
      const pin = ensurePin(pins, component, token.text, net?.id ?? null, component.page, x, y, evidence);
      if (pin.x == null || pin.y == null || distanceToBox(pin.x, pin.y, component.bbox) > 80) {
        pin.x = x;
        pin.y = y;
        pin.page = component.page;
      }
      if (net) {
        addUnique(net.pin_ids, pin.id);
        legacyPins.push({ connector: component.refdes, pin: pin.number, net_name: net.name ?? net.id, confidence: "INFERRED", evidence: { source_path: input.sourcePath, source_hash: input.sourceHash, page: component.page, line: null, excerpt: evidence.excerpt } });
      }
    }
  }
}

function ensureComponent(components: Map<string, SchematicComponent>, rawRefdes: string, page: number | null, box: SchematicBox | null, evidence: SchematicEvidence) {
  const refdes = rawRefdes.toLocaleUpperCase("en-US");
  const key = refdes.toLocaleUpperCase("en-US");
  let component = components.get(key);
  if (!component) {
    component = { id: `component-${safeId(refdes)}`, refdes, value: null, kind: classifySchematicComponent(refdes), page, bbox: box, pin_ids: [], passthrough_pin_pairs: [], evidence: [evidence] };
    components.set(key, component);
  } else {
    component.evidence.push(evidence);
    component.bbox ??= box;
    component.page ??= page;
  }
  return component;
}

function ensurePin(pins: Map<string, SchematicGraphPin>, component: SchematicComponent, number: string, netId: string | null, page: number | null, x: number | null, y: number | null, evidence: SchematicEvidence) {
  const id = `pin-${safeId(component.refdes)}-${safeId(number)}`;
  let pin = pins.get(id);
  if (!pin) {
    pin = { id, component_id: component.id, number, name: null, net_id: netId, page, x, y, evidence: [evidence] };
    pins.set(id, pin);
  } else {
    pin.evidence.push(evidence);
    pin.net_id ??= netId;
    pin.page ??= page;
    pin.x ??= x;
    pin.y ??= y;
  }
  return pin;
}

function ensureNet(nets: Map<string, SchematicNet>, rawName: string, evidence: SchematicEvidence) {
  const name = rawName.trim();
  const id = `net-${safeId(name.toLocaleUpperCase("en-US"))}`;
  let net = nets.get(id);
  if (!net) {
    net = { id, name, pin_ids: [], wire_ids: [], label_ids: [], page_numbers: evidence.page == null ? [] : [evidence.page], confidence: evidence.confidence, evidence: [evidence] };
    nets.set(id, net);
  } else {
    net.evidence.push(evidence);
    net.confidence = Math.min(net.confidence, evidence.confidence);
    if (evidence.page != null) addUnique(net.page_numbers, evidence.page);
  }
  return net;
}

function evidenceFor(input: PdfParseInput, page: number | null, bbox: SchematicBox | null, excerpt: string, method: SchematicEvidence["method"], confidence: number): SchematicEvidence {
  return { source_path: input.sourcePath, source_hash: input.sourceHash, page, bbox, excerpt: excerpt.slice(0, 500), method, confidence: Math.max(0, Math.min(1, confidence)) };
}

function groupTokensByLine(pageTokens: Map<number, TextToken[]>) {
  const lines: Array<{ page: number; text: string; box: SchematicBox; tokens: TextToken[] }> = [];
  for (const [page, tokens] of pageTokens) {
    const groups: TextToken[][] = [];
    for (const token of [...tokens].sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x)) {
      const group = groups.find((candidate) => Math.abs(centerY(candidate[0]!.box) - centerY(token.box)) <= Math.max(4, token.box.height * 0.55));
      if (group) group.push(token);
      else groups.push([token]);
    }
    for (const group of groups) {
      group.sort((left, right) => left.box.x - right.box.x);
      lines.push({ page, text: group.map((token) => token.text).join(" "), box: unionBoxes(group.map((token) => token.box)), tokens: group });
    }
  }
  return lines;
}

function mergeCollinearSegments(source: Array<{ x1: number; y1: number; x2: number; y2: number }>) {
  const result: typeof source = [];
  for (const segment of source.sort((left, right) => left.y1 - right.y1 || left.x1 - right.x1)) {
    const horizontal = segment.y1 === segment.y2;
    const found = result.find((known) => horizontal === (known.y1 === known.y2)
      && (horizontal ? Math.abs(known.y1 - segment.y1) <= 3 : Math.abs(known.x1 - segment.x1) <= 3)
      && rangesTouch(horizontal ? known.x1 : known.y1, horizontal ? known.x2 : known.y2, horizontal ? segment.x1 : segment.y1, horizontal ? segment.x2 : segment.y2, 6));
    if (!found) {
      result.push({ ...segment });
      continue;
    }
    if (horizontal) {
      found.x1 = Math.min(found.x1, segment.x1);
      found.x2 = Math.max(found.x2, segment.x2);
      found.y1 = found.y2 = Math.round((found.y1 + segment.y1) / 2);
    } else {
      found.y1 = Math.min(found.y1, segment.y1);
      found.y2 = Math.max(found.y2, segment.y2);
      found.x1 = found.x2 = Math.round((found.x1 + segment.x1) / 2);
    }
  }
  return result;
}

function enclosingRectangle(box: SchematicBox, wires: SchematicWire[]) {
  const center = { x: centerX(box), y: centerY(box) };
  const verticals = wires.filter((wire) => wire.x1 === wire.x2 && wire.y1 <= center.y && wire.y2 >= center.y);
  const left = verticals.filter((wire) => wire.x1 < center.x).sort((a, b) => b.x1 - a.x1)[0];
  const right = verticals.filter((wire) => wire.x1 > center.x).sort((a, b) => a.x1 - b.x1)[0];
  if (!left || !right) return null;
  const horizontals = wires.filter((wire) => wire.y1 === wire.y2
    && rangesTouch(wire.x1, wire.x2, left.x1, right.x1, 5)
    && (nearPoint(wire.x1, wire.y1, left.x1, wire.y1, 5)
      || nearPoint(wire.x2, wire.y2, left.x1, wire.y2, 5)
      || nearPoint(wire.x1, wire.y1, right.x1, wire.y1, 5)
      || nearPoint(wire.x2, wire.y2, right.x1, wire.y2, 5)));
  const top = horizontals.filter((wire) => wire.y1 < center.y).sort((a, b) => b.y1 - a.y1)[0];
  const bottom = horizontals.filter((wire) => wire.y1 > center.y).sort((a, b) => a.y1 - b.y1)[0];
  if (!top || !bottom || !left || !right) return null;
  if (right.x1 - left.x1 > 600 || bottom.y1 - top.y1 > 600) return null;
  return { x: left.x1, y: top.y1, width: right.x1 - left.x1, height: bottom.y1 - top.y1 };
}

function componentBoundaryWireIds(components: SchematicComponent[], wires: SchematicWire[]) {
  const ids = new Set<string>();
  for (const component of components) {
    if (!component.bbox || component.page == null) continue;
    const pageWires = wires.filter((wire) => wire.page === component.page);
    const top = pageWires.find((wire) => wire.y1 === wire.y2 && Math.abs(wire.y1 - component.bbox!.y) <= 5 && rangesTouch(wire.x1, wire.x2, component.bbox!.x, component.bbox!.x + component.bbox!.width, 5));
    const bottom = pageWires.find((wire) => wire.y1 === wire.y2 && Math.abs(wire.y1 - (component.bbox!.y + component.bbox!.height)) <= 5 && rangesTouch(wire.x1, wire.x2, component.bbox!.x, component.bbox!.x + component.bbox!.width, 5));
    const left = pageWires.find((wire) => wire.x1 === wire.x2 && Math.abs(wire.x1 - component.bbox!.x) <= 5 && rangesTouch(wire.y1, wire.y2, component.bbox!.y, component.bbox!.y + component.bbox!.height, 5));
    const right = pageWires.find((wire) => wire.x1 === wire.x2 && Math.abs(wire.x1 - (component.bbox!.x + component.bbox!.width)) <= 5 && rangesTouch(wire.y1, wire.y2, component.bbox!.y, component.bbox!.y + component.bbox!.height, 5));
    if (top && bottom && left && right) [top, bottom, left, right].forEach((wire) => ids.add(wire.id));
  }
  return ids;
}

function findNearestWire(x: number, y: number, wires: SchematicWire[], maximum: number) {
  let selected: SchematicWire | undefined;
  let distance = maximum;
  for (const wire of wires) {
    const current = pointToSegmentDistance(x, y, wire.x1, wire.y1, wire.x2, wire.y2);
    if (current < distance) {
      selected = wire;
      distance = current;
    }
  }
  return selected;
}

function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const amount = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + amount * dx), py - (y1 + amount * dy));
}

function darkPixelCount(rgba: Uint8ClampedArray, width: number, height: number, centerX: number, centerY: number, radius: number) {
  let count = 0;
  for (let y = Math.max(0, Math.floor(centerY - radius)); y <= Math.min(height - 1, Math.ceil(centerY + radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(centerX - radius)); x <= Math.min(width - 1, Math.ceil(centerX + radius)); x += 1) {
      const offset = (y * width + x) * 4;
      const gray = ((rgba[offset] ?? 255) + (rgba[offset + 1] ?? 255) + (rgba[offset + 2] ?? 255)) / 3;
      if (gray < 115) count += 1;
    }
  }
  return count;
}

function wireEndpointsTouch(left: SchematicWire, right: SchematicWire, tolerance: number) {
  return nearPoint(left.x1, left.y1, right.x1, right.y1, tolerance)
    || nearPoint(left.x1, left.y1, right.x2, right.y2, tolerance)
    || nearPoint(left.x2, left.y2, right.x1, right.y1, tolerance)
    || nearPoint(left.x2, left.y2, right.x2, right.y2, tolerance);
}

function isNetLabel(value: string) {
  const normalized = value.toLocaleUpperCase("en-US");
  return NET_LABEL.test(value) && !REF_DESIGNATOR.test(value) && !IGNORED_LABELS.has(normalized) && !/^\d+$/.test(value);
}

function meaningfulTokenCount(tokens: TextToken[]) {
  return tokens.filter((token) => /[A-Za-z0-9]/.test(token.text)).length;
}

function minimumTokenConfidence(tokens: TextToken[]) {
  return tokens.length ? Math.min(...tokens.map((token) => token.confidence)) : 0;
}

function isTextItem(value: unknown): value is { str: string; transform: number[]; width: number; height: number } {
  return Boolean(value && typeof value === "object" && "str" in value && typeof (value as { str?: unknown }).str === "string" && "transform" in value && Array.isArray((value as { transform?: unknown }).transform));
}

function dedupeLegacyPins(pins: SchematicDocument["pins"]) {
  return [...new Map(pins.map((pin) => [`${pin.connector.toLocaleUpperCase("en-US")}:${pin.pin.toLocaleUpperCase("en-US")}`, pin])).values()];
}

function unionBoxes(boxes: SchematicBox[]) {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function expandBox(box: SchematicBox, horizontal: number, vertical: number) {
  return { x: Math.max(0, box.x - horizontal), y: Math.max(0, box.y - vertical), width: box.width + horizontal * 2, height: box.height + vertical * 2 };
}

function lineBox(line: { x1: number; y1: number; x2: number; y2: number }) {
  return { x: Math.min(line.x1, line.x2), y: Math.min(line.y1, line.y2), width: Math.max(1, Math.abs(line.x2 - line.x1)), height: Math.max(1, Math.abs(line.y2 - line.y1)) };
}

function distanceToBox(x: number, y: number, box: SchematicBox) {
  const dx = Math.max(box.x - x, 0, x - (box.x + box.width));
  const dy = Math.max(box.y - y, 0, y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

function rangesTouch(a1: number, a2: number, b1: number, b2: number, tolerance: number) {
  const [leftA, rightA] = a1 <= a2 ? [a1, a2] : [a2, a1];
  const [leftB, rightB] = b1 <= b2 ? [b1, b2] : [b2, b1];
  return Math.max(leftA, leftB) <= Math.min(rightA, rightB) + tolerance;
}

function nearPoint(x1: number, y1: number, x2: number, y2: number, tolerance: number) {
  return Math.hypot(x1 - x2, y1 - y2) <= tolerance;
}

function centerX(box: SchematicBox) { return box.x + box.width / 2; }
function centerY(box: SchematicBox) { return box.y + box.height / 2; }
function safeId(value: string) { return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item"; }
function addUnique<T>(values: T[], value: T) { if (!values.includes(value)) values.push(value); }
