import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ArtifactCatalog,
  ArtifactSummary,
  ConnectorMapping,
  TableFormat,
  TableKind,
  WibConstraintDefinition,
  WibWorkflowDraft
} from "@circuit-inspector/contracts";
import {
  compareFixtureWiring,
  applySchematicCorrections,
  confirmSchematicPaths,
  confirmSchematicPinout,
  createWibConstraintSet,
  extractRulePack,
  importSchematicDocument,
  listWorkflowArtifacts,
  parseTable,
  qualifyWibDesign,
  readSchematicDocument,
  readSchematicPage,
  readSchematicThumbnail,
  readPinout,
  readWibConstraintSet,
  readWibWorkflowDraft,
  recommendManufacturingTests,
  saveWibWorkflowDraft,
  serializeTable,
  traceSchematicInterface
} from "@circuit-inspector/workflows";
import { CoreClient } from "./core-client.js";
import { assertArtifactId, assertGrantedPath, assertOneOf, assertPathInside, withArtifactId } from "./security.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.resolve(directory, "../assets/icon.png");
const cacheDir = path.resolve(
  process.env.CIRCUIT_INSPECTOR_CACHE_DIR ?? path.join(os.homedir(), ".circuit-inspector", "cache")
);
if (app.isPackaged) {
  process.env.CIRCUIT_INSPECTOR_OCR_DIR = path.join(process.resourcesPath, "ocr");
  process.env.CIRCUIT_INSPECTOR_PDF_ASSET_DIR = path.join(process.resourcesPath, "pdfjs");
}
const core = new CoreClient();
const grantedInputPaths = new Set<string>();
let window: BrowserWindow | undefined;
let pendingDeepLink = process.argv.find((argument) => argument.startsWith("circuitinspector://"));

app.setName("CircuitInspector");
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient("circuitinspector", process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("circuitinspector");
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();

app.on("second-instance", (_event, argv) => {
  pendingDeepLink = argv.find((argument) => argument.startsWith("circuitinspector://"));
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
  if (pendingDeepLink) window.webContents.send("deep-link", pendingDeepLink);
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  pendingDeepLink = url;
  window?.webContents.send("deep-link", url);
});

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => core.close());

function createWindow() {
  window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#121416",
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("file://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.once("ready-to-show", () => {
    window?.show();
    if (pendingDeepLink) window?.webContents.send("deep-link", pendingDeepLink);
  });
  window.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) window?.webContents.send("deep-link", pendingDeepLink);
    const screenshot = process.env.CIRCUIT_INSPECTOR_SMOKE_SCREENSHOT;
    if (!screenshot) return;
    setTimeout(async () => {
      const image = await window?.webContents.capturePage();
      if (image) await writeFile(path.resolve(screenshot), image.toPNG());
      app.quit();
    }, 1500);
  });
  const devUrl = process.env.CIRCUIT_INSPECTOR_VIEWER_DEV_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(directory, "renderer/index.html"));
}

ipcMain.handle("design:choose", async (_event, locale: "zh-CN" | "en-US") => {
  const chinese = locale === "zh-CN";
  const result = await dialog.showOpenDialog(window!, {
    title: chinese ? "选择 ODB++ 或 Gerber 制造数据" : "Choose ODB++ or Gerber manufacturing data",
    properties: ["openFile", "openDirectory"],
    filters: [
      { name: chinese ? "PCB 制造数据" : "PCB manufacturing data", extensions: ["zip", "tgz", "gz", "gbr", "ger", "gtl", "gbl"] },
      { name: chinese ? "所有文件" : "All files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = path.resolve(result.filePaths[0]);
  grantedInputPaths.add(selected);
  return selected;
});

ipcMain.handle("workbench:choose-input", async (_event, kind: "RULE_DOCUMENT" | "SCHEMATIC" | "TABLE", multiple: boolean, locale: "zh-CN" | "en-US") => {
  kind = assertOneOf(kind, ["RULE_DOCUMENT", "SCHEMATIC", "TABLE"] as const, "workbench input kind");
  const chinese = locale === "zh-CN";
  const configuration = kind === "RULE_DOCUMENT"
    ? {
        title: chinese ? "选择规则文档" : "Choose rule documents",
        filters: [{ name: chinese ? "规则文档" : "Rule documents", extensions: ["pdf", "docx", "md", "markdown", "txt"] }]
      }
    : kind === "SCHEMATIC"
      ? {
          title: chinese ? "选择原理图引脚文件" : "Choose schematic pinout",
          filters: [{ name: chinese ? "引脚与原理图文件" : "Pinout and schematic files", extensions: ["json", "csv", "tsv", "txt", "net", "pinout", "pdf"] }]
        }
      : {
          title: chinese ? "选择表格数据" : "Choose table data",
          filters: [{ name: chinese ? "CSV 或 JSON 表格" : "CSV or JSON table", extensions: ["csv", "json"] }]
        };
  const result = await dialog.showOpenDialog(window!, {
    title: configuration.title,
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters: [...configuration.filters, { name: chinese ? "所有文件" : "All files", extensions: ["*"] }]
  });
  if (result.canceled) return [];
  const selected = result.filePaths.map((file) => path.resolve(file));
  selected.forEach((file) => grantedInputPaths.add(file));
  return selected;
});

ipcMain.handle("workbench:artifacts", async (): Promise<ArtifactCatalog> => {
  const [designsResult, analysesResult, workflowCatalog] = await Promise.all([
    core.request<{ designs: Array<{ summary: Record<string, unknown>; updated_at_unix_ms: number }>; diagnostics: ArtifactCatalog["diagnostics"] }>("list_designs", { cache_dir: cacheDir }),
    core.request<{ analyses: Array<{ summary: Record<string, unknown>; updated_at_unix_ms: number }>; diagnostics: ArtifactCatalog["diagnostics"] }>("list_analyses", { cache_dir: cacheDir }),
    listWorkflowArtifacts(cacheDir)
  ]);
  const coreArtifacts: ArtifactSummary[] = [
    ...designsResult.designs.map(({ summary, updated_at_unix_ms }) => ({
      id: String(summary.id),
      kind: "DESIGN" as const,
      title: path.basename(String(summary.source_path)),
      subtitle: `${String(summary.format)} · ${Array.isArray(summary.layers) ? summary.layers.length : 0} layer(s)`,
      status: null,
      verdict: null,
      analysis_kind: null,
      source_path: String(summary.source_path),
      updated_at: new Date(updated_at_unix_ms).toISOString()
    })),
    ...analysesResult.analyses.map(({ summary, updated_at_unix_ms }) => ({
      id: String(summary.id),
      kind: "ANALYSIS" as const,
      title: "PCB geometry analysis",
      subtitle: `${String(summary.rule_pack_id)} · ${String(summary.id)}`,
      status: String(summary.verdict),
      verdict: summary.verdict as ArtifactSummary["verdict"],
      analysis_kind: "GEOMETRY" as const,
      source_path: null,
      updated_at: new Date(updated_at_unix_ms).toISOString()
    }))
  ];
  return {
    artifacts: [...coreArtifacts, ...workflowCatalog.artifacts].sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
    diagnostics: [...designsResult.diagnostics, ...analysesResult.diagnostics, ...workflowCatalog.diagnostics]
  };
});

ipcMain.handle("workbench:extract-rules", async (_event, input: { paths: string[]; title?: string }) => {
  if (!Array.isArray(input.paths) || input.paths.length === 0) throw new Error("At least one rule document is required");
  input.paths.forEach((file) => assertGrantedPath(grantedInputPaths, file));
  sendWorkbenchProgress("RULE_EXTRACTION", 8, "Extracting local rule evidence");
  const extracted = await extractRulePack(input.paths, cacheDir, input.title);
  await core.request("save_rule_pack", { cache_dir: cacheDir, rule_pack: extracted.rulePack });
  sendWorkbenchProgress("RULE_EXTRACTION", 100, "Draft rule pack is ready for review");
  return {
    rule_pack: extracted.rulePack,
    passage_count: extracted.passageCount,
    rule_count: extracted.ruleCount,
    rag_index_path: extracted.ragIndexPath
  };
});

ipcMain.handle("workbench:import-schematic", async (_event, input: { path: string; role: "PRODUCT" | "WIB"; revision?: string }) => {
  const sourcePath = assertGrantedPath(grantedInputPaths, input.path);
  const role = assertOneOf(input.role, ["PRODUCT", "WIB"] as const, "schematic role");
  const document = await importSchematicDocument(sourcePath, role, cacheDir, input.revision, (progress, message) => sendWorkbenchProgress("SCHEMATIC_IMPORT", progress, message));
  return document;
});
ipcMain.handle("workbench:read-schematic", (_event, id: string) => readSchematicDocument(assertArtifactId(id), cacheDir));
ipcMain.handle("workbench:trace-schematic", (_event, input: { schematic_id: string; candidate_id: string }) =>
  traceSchematicInterface(assertArtifactId(input.schematic_id), assertArtifactId(input.candidate_id), cacheDir));
ipcMain.handle("workbench:correct-schematic", (_event, input: {
  schematic_id: string;
  corrected_by: string;
  candidate_id?: string;
  corrections: Array<{ operation: "UPDATE" | "ADD" | "DELETE" | "MERGE_NETS" | "SPLIT_NET" | "SET_JUNCTION" | "SET_OFF_PAGE" | "SET_PASSTHROUGH"; entity_kind: "COMPONENT" | "PIN" | "NET" | "WIRE" | "JUNCTION" | "LABEL"; entity_id: string; after?: Record<string, unknown> | null }>;
}) => applySchematicCorrections(assertArtifactId(input.schematic_id), input.corrections, input.corrected_by, cacheDir, input.candidate_id));
ipcMain.handle("workbench:confirm-schematic-paths", (_event, input: { schematic_id: string; candidate_id: string; path_ids: string[]; confirmed_by: string }) =>
  confirmSchematicPaths(assertArtifactId(input.schematic_id), assertArtifactId(input.candidate_id), input.path_ids.map(assertArtifactId), input.confirmed_by, cacheDir));
ipcMain.handle("workbench:schematic-page", async (_event, input: { schematic_id: string; page: number }) => {
  if (!Number.isSafeInteger(input.page) || input.page < 1) throw new Error("Invalid schematic page number");
  const result = await readSchematicPage(assertArtifactId(input.schematic_id), input.page, cacheDir);
  return {
    ...result,
    bytes: result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength),
    thumbnailBytes: result.thumbnailBytes.buffer.slice(result.thumbnailBytes.byteOffset, result.thumbnailBytes.byteOffset + result.thumbnailBytes.byteLength)
  };
});
ipcMain.handle("workbench:schematic-thumbnail", async (_event, input: { schematic_id: string; page: number }) => {
  if (!Number.isSafeInteger(input.page) || input.page < 1) throw new Error("Invalid schematic page number");
  const result = await readSchematicThumbnail(assertArtifactId(input.schematic_id), input.page, cacheDir);
  return { page: result.page, bytes: result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) };
});
ipcMain.handle("workbench:read-pinout", (_event, id: string) => readPinout(assertArtifactId(id), cacheDir));
ipcMain.handle("workbench:confirm-pinout", (_event, input: {
  pinout_id: string;
  confirmed_by: string;
  revision?: string;
  pins: Array<{ connector: string; pin: string; net_name: string }>;
  design_metrics: Array<{ id: string; value: string | number; unit?: string | null }>;
}) => confirmSchematicPinout(assertArtifactId(input.pinout_id), input.confirmed_by, cacheDir, input.pins, input.revision, input.design_metrics));

ipcMain.handle("workbench:compare-wiring", async (_event, input: {
  product_pinout_id: string;
  wib_pinout_id: string;
  connector_mappings: ConnectorMapping[];
  net_aliases: Array<{ product_net: string; wib_net: string }>;
  case_sensitive: boolean;
}) => {
  sendWorkbenchProgress("WIRING_COMPARISON", 10, "Comparing product and WIB pin mappings");
  const analysis = await compareFixtureWiring(assertArtifactId(input.product_pinout_id), assertArtifactId(input.wib_pinout_id), cacheDir, {
    connectorMappings: input.connector_mappings,
    netAliases: input.net_aliases,
    caseSensitive: input.case_sensitive
  });
  sendWorkbenchProgress("WIRING_COMPARISON", 100, "Wiring report is ready");
  return analysis;
});

ipcMain.handle("workbench:recommend-tests", async (_event, productPinoutId: string) => {
  sendWorkbenchProgress("TEST_RECOMMENDATIONS", 10, "Building manufacturing-test recommendations");
  const plan = await recommendManufacturingTests(assertArtifactId(productPinoutId), cacheDir);
  sendWorkbenchProgress("TEST_RECOMMENDATIONS", 100, "Test and WIB recommendations are ready");
  return plan;
});

ipcMain.handle("workbench:create-constraint-set", (_event, input: {
  title: string;
  revision: string;
  approved_by: string;
  constraints: WibConstraintDefinition[];
}) => createWibConstraintSet({ title: input.title, revision: input.revision, approvedBy: input.approved_by, constraints: input.constraints }, cacheDir));
ipcMain.handle("workbench:read-constraint-set", (_event, id: string) => readWibConstraintSet(assertArtifactId(id), cacheDir));

ipcMain.handle("workbench:qualify-wib", async (_event, input: {
  product_pinout_id: string;
  wib_pinout_id: string;
  constraint_set_id: string;
  connector_mappings: ConnectorMapping[];
  net_aliases: Array<{ product_net: string; wib_net: string }>;
  case_sensitive: boolean;
}) => {
  sendWorkbenchProgress("WIB_QUALIFICATION", 10, "Running closed-loop WIB qualification");
  const qualification = await qualifyWibDesign(
    assertArtifactId(input.product_pinout_id),
    assertArtifactId(input.wib_pinout_id),
    assertArtifactId(input.constraint_set_id),
    cacheDir,
    { connectorMappings: input.connector_mappings, netAliases: input.net_aliases, caseSensitive: input.case_sensitive }
  );
  sendWorkbenchProgress("WIB_QUALIFICATION", 100, "Final WIB qualification is ready");
  return qualification;
});

ipcMain.handle("workbench:save-draft", (_event, draft: WibWorkflowDraft) => saveWibWorkflowDraft(cacheDir, draft));
ipcMain.handle("workbench:read-draft", (_event, id: string) => readWibWorkflowDraft(cacheDir, assertArtifactId(id)));

ipcMain.handle("workbench:import-table", async (_event, kind: TableKind, filePath: string) => {
  kind = assertOneOf(kind, ["PINOUT", "DESIGN_METRIC", "CONNECTOR_MAPPING", "NET_ALIAS", "CONSTRAINT"] as const, "table kind");
  filePath = assertGrantedPath(grantedInputPaths, filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".csv" && extension !== ".json") throw new Error("Table imports must be CSV or JSON");
  return parseTable(kind, await readFile(filePath, "utf8"), extension === ".json" ? "JSON" : "CSV");
});
ipcMain.handle("workbench:parse-table-text", (_event, kind: TableKind, text: string) => {
  kind = assertOneOf(kind, ["PINOUT", "DESIGN_METRIC", "CONNECTOR_MAPPING", "NET_ALIAS", "CONSTRAINT"] as const, "table kind");
  if (typeof text !== "string") throw new Error("Table text must be a string");
  return parseTable(kind, text.replaceAll("\t", ","), "CSV");
});
ipcMain.handle("workbench:export-table", async (_event, kind: TableKind, rows: Array<Record<string, unknown>>, format: TableFormat, locale: "zh-CN" | "en-US") => {
  kind = assertOneOf(kind, ["PINOUT", "DESIGN_METRIC", "CONNECTOR_MAPPING", "NET_ALIAS", "CONSTRAINT"] as const, "table kind");
  format = assertOneOf(format, ["CSV", "JSON"] as const, "table format");
  if (!Array.isArray(rows)) throw new Error("Table rows must be an array");
  const extension = format === "JSON" ? "json" : "csv";
  const result = await dialog.showSaveDialog(window!, {
    title: locale === "zh-CN" ? "导出表格" : "Export table",
    defaultPath: `${kind.toLowerCase().replaceAll("_", "-")}.${extension}`,
    filters: [{ name: format, extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, path: null };
  await writeFile(result.filePath, serializeTable(kind, rows, format), "utf8");
  return { ok: true, path: result.filePath };
});

ipcMain.handle("design:import", async (_event, sourcePath: string) => {
  sourcePath = assertGrantedPath(grantedInputPaths, sourcePath);
  window?.webContents.send("core-progress", { phase: "IMPORT", progress: 0, message: "正在校验并解析制造数据" });
  const summary = await core.request("import_design", { path: path.resolve(sourcePath), cache_dir: cacheDir });
  window?.webContents.send("core-progress", { phase: "IMPORT", progress: 100, message: "设计已建立索引" });
  return summary;
});

ipcMain.handle("design:summary", (_event, designId: string) =>
  core.request("get_design_summary", { design_id: assertArtifactId(designId), cache_dir: cacheDir })
);

ipcMain.handle("design:tile", async (_event, input: Record<string, unknown>) => {
  const descriptor = await core.request<{ path: string; feature_count: number; bounds: unknown; lod: number }>("get_tile", {
    ...withArtifactId(input, "design_id"),
    cache_dir: cacheDir
  });
  const bytes = await readFile(descriptor.path);
  return {
    ...descriptor,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
});

ipcMain.handle("design:search", (_event, input: Record<string, unknown>) =>
  core.request("search_design", { ...withArtifactId(input, "design_id"), cache_dir: cacheDir })
);
ipcMain.handle("design:pick", (_event, input: Record<string, unknown>) =>
  core.request("pick_design", { ...withArtifactId(input, "design_id"), cache_dir: cacheDir })
);

ipcMain.handle("rules:list", () => core.request("list_rule_packs", { cache_dir: cacheDir }));
ipcMain.handle("rules:approve", (_event, rulePackId: string, approvedBy: string) =>
  core.request("approve_rule_pack", { cache_dir: cacheDir, rule_pack_id: assertArtifactId(rulePackId), approved_by: approvedBy })
);
ipcMain.handle("analysis:run", (_event, designId: string, rulePackId: string) =>
  core.request("analyze_design", { cache_dir: cacheDir, design_id: assertArtifactId(designId), rule_pack_id: assertArtifactId(rulePackId) })
);
ipcMain.handle("analysis:query", (_event, input: Record<string, unknown>) =>
  core.request("query_violations", { cache_dir: cacheDir, ...withArtifactId(input, "analysis_id") })
);
ipcMain.handle("evidence:render", (_event, input: Record<string, unknown>) =>
  core.request("render_evidence", { cache_dir: cacheDir, ...withArtifactId(input, "analysis_id") })
);
ipcMain.handle("analysis:read", async (_event, analysisId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(analysisId)) throw new Error("Invalid analysis identifier");
  const localAnalysis = path.join(cacheDir, "evidence", analysisId, "analysis.json");
  try {
    const parsed = JSON.parse(await readFile(localAnalysis, "utf8")) as { kind?: string };
    if (["WIRING_COMPARISON", "MANUFACTURING_TEST_RECOMMENDATIONS", "WIB_DESIGN_QUALIFICATION"].includes(parsed.kind ?? "")) return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const geometry = await core.request<Record<string, unknown>>("read_analysis", { cache_dir: cacheDir, analysis_id: analysisId });
  return { ...geometry, report_path: path.join(cacheDir, "evidence", analysisId, "report.html") };
});
ipcMain.handle("evidence:open", async (_event, filePath: string) => {
  const evidenceRoot = path.resolve(cacheDir, "evidence");
  const resolved = assertPathInside(evidenceRoot, filePath);
  const result = await shell.openPath(resolved);
  return { ok: result.length === 0, error: result || null };
});

function sendWorkbenchProgress(phase: string, progress: number, message: string): void {
  window?.webContents.send("core-progress", { phase, progress, message });
}
