import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactCatalog, ArtifactSummary, Diagnostic, WibWorkflowDraft } from "@circuit-inspector/contracts";

export async function listWorkflowArtifacts(cacheDir: string): Promise<ArtifactCatalog> {
  const diagnostics: Diagnostic[] = [];
  const groups = await Promise.all([
    scanJsonDirectory(path.join(cacheDir, "rules"), diagnostics, ruleArtifact),
    scanJsonDirectory(path.join(cacheDir, "pinouts"), diagnostics, pinoutArtifact),
    scanSchematicDirectory(path.join(cacheDir, "schematics"), diagnostics),
    scanJsonDirectory(path.join(cacheDir, "wib-constraints"), diagnostics, constraintArtifact),
    scanJsonDirectory(path.join(cacheDir, "wib-interface-contracts"), diagnostics, interfaceContractArtifact),
    scanJsonDirectory(path.join(cacheDir, "layout-baselines"), diagnostics, layoutBaselineArtifact),
    scanBrdCatalogDirectory(path.join(cacheDir, "brd-catalogs"), diagnostics),
    scanJsonDirectory(path.join(cacheDir, "test-point-selections"), diagnostics, testPointSelectionArtifact),
    scanJsonDirectory(path.join(cacheDir, "test-point-alignments"), diagnostics, testPointAlignmentArtifact),
    scanJsonDirectory(path.join(cacheDir, "selected-analyses"), diagnostics, analysisArtifact),
    scanAnalysisDirectory(path.join(cacheDir, "evidence"), diagnostics),
    scanJsonDirectory(path.join(cacheDir, "workflow-drafts"), diagnostics, draftArtifact)
  ]);
  return {
    artifacts: groups.flat().sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
    diagnostics
  };
}

async function scanBrdCatalogDirectory(directory: string, diagnostics: Diagnostic[]): Promise<ArtifactSummary[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const artifacts: ArtifactSummary[] = [];
  for (const name of names) {
    const file = path.join(directory, name, "catalog.json");
    try {
      const [value, metadata] = await Promise.all([
        readFile(file, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>),
        stat(file)
      ]);
      const artifact = brdCatalogArtifact(value, metadata.mtime.toISOString());
      if (artifact) artifacts.push(artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ code: "INVALID_BRD_TP_CATALOG", severity: "WARNING", message: String(error), source: file });
    }
  }
  return artifacts;
}

async function scanSchematicDirectory(directory: string, diagnostics: Diagnostic[]): Promise<ArtifactSummary[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const artifacts: ArtifactSummary[] = [];
  for (const name of names) {
    const file = path.join(directory, name, "document.json");
    try {
      const [value, metadata] = await Promise.all([
        readFile(file, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>),
        stat(file)
      ]);
      const artifact = schematicArtifact(value, metadata.mtime.toISOString());
      if (artifact) artifacts.push(artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ code: "INVALID_CACHED_SCHEMATIC", severity: "WARNING", message: String(error), source: file });
    }
  }
  return artifacts;
}

export async function saveWibWorkflowDraft(cacheDir: string, draft: WibWorkflowDraft): Promise<WibWorkflowDraft> {
  const id = safeSegment(draft.id || `wib-draft-${Date.now().toString(36)}`);
  const saved: WibWorkflowDraft = { ...draft, schema_version: 1, id, updated_at: new Date().toISOString() };
  const directory = path.join(cacheDir, "workflow-drafts");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `.${id}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(saved, null, 2), "utf8");
  await rename(temporary, target);
  return saved;
}

export async function readWibWorkflowDraft(cacheDir: string, id: string): Promise<WibWorkflowDraft> {
  return JSON.parse(await readFile(path.join(cacheDir, "workflow-drafts", `${safeSegment(id)}.json`), "utf8")) as WibWorkflowDraft;
}

async function scanJsonDirectory(
  directory: string,
  diagnostics: Diagnostic[],
  convert: (value: Record<string, unknown>, updatedAt: string) => ArtifactSummary | null
): Promise<ArtifactSummary[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const artifacts: ArtifactSummary[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const [value, metadata] = await Promise.all([
        readFile(file, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>),
        stat(file)
      ]);
      const artifact = convert(value, metadata.mtime.toISOString());
      if (artifact) artifacts.push(artifact);
    } catch (error) {
      diagnostics.push({ code: "INVALID_CACHED_ARTIFACT", severity: "WARNING", message: String(error), source: file });
    }
  }
  return artifacts;
}

async function scanAnalysisDirectory(directory: string, diagnostics: Diagnostic[]): Promise<ArtifactSummary[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const artifacts: ArtifactSummary[] = [];
  for (const name of names) {
    const file = path.join(directory, name, "analysis.json");
    try {
      const [value, metadata] = await Promise.all([
        readFile(file, "utf8").then((content) => JSON.parse(content) as Record<string, unknown>),
        stat(file)
      ]);
      const artifact = analysisArtifact(value, metadata.mtime.toISOString());
      if (artifact) artifacts.push(artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({ code: "INVALID_CACHED_ANALYSIS", severity: "WARNING", message: String(error), source: file });
      }
    }
  }
  return artifacts;
}

function pinoutArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (typeof value.id !== "string" || (value.role !== "PRODUCT" && value.role !== "WIB")) return null;
  const sourcePath = typeof value.source_path === "string" ? value.source_path : null;
  return {
    id: value.id,
    kind: "PINOUT",
    title: `${value.role} · ${sourcePath ? path.basename(sourcePath) : value.id}`,
    subtitle: `${String(value.source_format ?? "DOCUMENT")} · ${Array.isArray(value.pins) ? value.pins.length : 0} pin(s)`,
    status: typeof value.status === "string" ? value.status : null,
    verdict: null,
    analysis_kind: null,
    source_path: sourcePath,
    updated_at: updatedAt
  };
}

function schematicArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (value.schema_version !== 2 || typeof value.id !== "string" || (value.role !== "PRODUCT" && value.role !== "WIB")) return null;
  const sourcePath = typeof value.source_path === "string" ? value.source_path : null;
  return {
    id: value.id,
    kind: "SCHEMATIC",
    title: `${value.role} schematic · ${sourcePath ? path.basename(sourcePath) : value.id}`,
    subtitle: `${String(value.source_format ?? "DOCUMENT")} · ${Array.isArray(value.pages) ? value.pages.length : 0} page(s) · ${Array.isArray(value.paths) ? value.paths.length : 0} traced path(s)`,
    status: typeof value.status === "string" ? value.status : null,
    verdict: null,
    analysis_kind: null,
    source_path: sourcePath,
    updated_at: updatedAt
  };
}

function ruleArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (typeof value.id !== "string" || !Array.isArray(value.rules) || typeof value.status !== "string") return null;
  return {
    id: value.id,
    kind: "RULE_PACK",
    title: typeof value.title === "string" ? value.title : value.id,
    subtitle: `${String(value.version ?? "-")} · ${value.rules.length} rule(s)`,
    status: value.status,
    verdict: null,
    analysis_kind: null,
    source_path: null,
    updated_at: updatedAt
  };
}

function constraintArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (typeof value.id !== "string" || !Array.isArray(value.constraints)) return null;
  return {
    id: value.id,
    kind: "CONSTRAINT_SET",
    title: typeof value.title === "string" ? value.title : value.id,
    subtitle: `${String(value.revision ?? "-")} · ${value.constraints.length} constraint(s)`,
    status: typeof value.status === "string" ? value.status : null,
    verdict: null,
    analysis_kind: null,
    source_path: null,
    updated_at: updatedAt
  };
}

function interfaceContractArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (value.schema_version !== 1 || typeof value.id !== "string" || value.status !== "APPROVED" || !Array.isArray(value.connector_mappings)) return null;
  const pinCount = value.connector_mappings.reduce((count, mapping) => {
    if (!mapping || typeof mapping !== "object") return count;
    const pinMap = (mapping as { pin_map?: unknown }).pin_map;
    return count + (Array.isArray(pinMap) ? pinMap.length : 0);
  }, 0);
  return {
    id: value.id,
    kind: "INTERFACE_CONTRACT",
    title: typeof value.title === "string" ? value.title : value.id,
    subtitle: `${String(value.revision ?? "-")} · ${pinCount} explicit pin mapping(s)`,
    status: "APPROVED",
    verdict: null,
    analysis_kind: null,
    source_path: null,
    updated_at: updatedAtValue(value.approved_at, updatedAt)
  };
}

function layoutBaselineArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (value.schema_version !== 1 || typeof value.id !== "string" || value.status !== "APPROVED" || typeof value.design_id !== "string") return null;
  return {
    id: value.id,
    kind: "LAYOUT_BASELINE",
    title: `Controlled Layout baseline · ${value.design_id}`,
    subtitle: `${String(value.product_revision ?? "-")} · ${String(value.variant ?? "N/A")} · ${String(value.panel ?? "N/A")}`,
    status: "APPROVED",
    verdict: null,
    analysis_kind: null,
    source_path: null,
    updated_at: updatedAtValue(value.approved_at, updatedAt)
  };
}

function brdCatalogArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (value.schema_version !== 1 || value.kind !== "BRD_TEST_POINT_CATALOG" || typeof value.id !== "string") return null;
  const sourcePath = typeof value.source_path === "string" ? value.source_path : null;
  return {
    id: value.id,
    kind: "BRD_TP_CATALOG",
    title: `BRD TP catalog · ${sourcePath ? path.basename(sourcePath) : value.id}`,
    subtitle: `${Array.isArray(value.candidates) ? value.candidates.length : 0} candidate(s) · ${String((value.converter as { version?: unknown } | undefined)?.version ?? "KiCad 10")}`,
    status: "GENERATED",
    verdict: null,
    analysis_kind: null,
    source_path: sourcePath,
    updated_at: updatedAt
  };
}

function testPointSelectionArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (value.schema_version !== 1 || value.kind !== "TEST_POINT_SELECTION" || typeof value.id !== "string") return null;
  const decisions = Array.isArray(value.decisions) ? value.decisions : [];
  const required = decisions.filter((decision) => (decision as { decision?: unknown }).decision === "REQUIRED").length;
  return {
    id: value.id,
    kind: "TP_SELECTION",
    title: "Human-reviewed BRD TP selection",
    subtitle: `${required} REQUIRED · ${String(value.catalog_id ?? "-")}`,
    status: typeof value.lifecycle_status === "string" ? value.lifecycle_status : null,
    verdict: null,
    analysis_kind: null,
    source_path: null,
    updated_at: updatedAt
  };
}

function testPointAlignmentArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (value.schema_version !== 1 || value.kind !== "TEST_POINT_ALIGNMENT" || typeof value.id !== "string") return null;
  const score = value.selected as { unique_matches?: unknown; ambiguous_matches?: unknown; unmatched?: unknown } | undefined;
  return {
    id: value.id,
    kind: "TP_ALIGNMENT",
    title: "BRD ↔ Gerber TP alignment",
    subtitle: `${String(score?.unique_matches ?? 0)} unique · ${String(score?.ambiguous_matches ?? 0)} ambiguous · ${String(score?.unmatched ?? 0)} unmatched`,
    status: typeof value.lifecycle_status === "string" ? value.lifecycle_status : null,
    verdict: null,
    analysis_kind: null,
    source_path: null,
    updated_at: updatedAt
  };
}

function analysisArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  const kind = String(value.kind ?? "");
  if (typeof value.id !== "string" || !["WIRING_COMPARISON", "MANUFACTURING_TEST_RECOMMENDATIONS", "LAYOUT_TEST_ACCESS_ANALYSIS", "WIB_DESIGN_QUALIFICATION", "SELECTED_TEST_POINT_ANALYSIS"].includes(kind)) return null;
  const titles: Record<string, string> = {
    WIRING_COMPARISON: "Product ↔ WIB wiring comparison",
    MANUFACTURING_TEST_RECOMMENDATIONS: "Controlled manufacturing test plan",
    LAYOUT_TEST_ACCESS_ANALYSIS: "Layout DFT test-access qualification",
    WIB_DESIGN_QUALIFICATION: "Final WIB design qualification",
    SELECTED_TEST_POINT_ANALYSIS: "Selected BRD TP Gerber DFT analysis"
  };
  const verdict = ["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"].includes(String(value.verdict))
    ? value.verdict as ArtifactSummary["verdict"]
    : null;
  const stale = value.stale && typeof value.stale === "object" && (value.stale as { is_stale?: unknown }).is_stale === true;
  return {
    id: value.id,
    kind: "ANALYSIS",
    title: titles[kind] ?? value.id,
    subtitle: value.id,
    status: stale ? "STALE" : kind === "MANUFACTURING_TEST_RECOMMENDATIONS" && typeof value.lifecycle_status === "string" ? value.lifecycle_status : verdict,
    verdict,
    analysis_kind: kind as NonNullable<ArtifactSummary["analysis_kind"]>,
    source_path: typeof value.report_path === "string" ? value.report_path : null,
    updated_at: updatedAt
  };
}

function updatedAtValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function draftArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  if (value.schema_version !== 1 || typeof value.id !== "string") return null;
  return {
    id: value.id,
    kind: "WORKFLOW_DRAFT",
    title: typeof value.title === "string" ? value.title : "WIB workflow draft",
    subtitle: `STEP ${String(value.step ?? 1)} · ${value.id}`,
    status: "DRAFT",
    verdict: null,
    analysis_kind: null,
    source_path: null,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : updatedAt
  };
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid CircuitInspector artifact identifier");
  return value;
}
