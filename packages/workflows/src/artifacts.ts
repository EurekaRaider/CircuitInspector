import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactCatalog, ArtifactSummary, Diagnostic, WibWorkflowDraft } from "@circuit-inspector/contracts";

export async function listWorkflowArtifacts(cacheDir: string): Promise<ArtifactCatalog> {
  const diagnostics: Diagnostic[] = [];
  const groups = await Promise.all([
    scanJsonDirectory(path.join(cacheDir, "rules"), diagnostics, ruleArtifact),
    scanJsonDirectory(path.join(cacheDir, "pinouts"), diagnostics, pinoutArtifact),
    scanJsonDirectory(path.join(cacheDir, "wib-constraints"), diagnostics, constraintArtifact),
    scanAnalysisDirectory(path.join(cacheDir, "evidence"), diagnostics),
    scanJsonDirectory(path.join(cacheDir, "workflow-drafts"), diagnostics, draftArtifact)
  ]);
  return {
    artifacts: groups.flat().sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
    diagnostics
  };
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

function analysisArtifact(value: Record<string, unknown>, updatedAt: string): ArtifactSummary | null {
  const kind = String(value.kind ?? "");
  if (typeof value.id !== "string" || !["WIRING_COMPARISON", "MANUFACTURING_TEST_RECOMMENDATIONS", "WIB_DESIGN_QUALIFICATION"].includes(kind)) return null;
  const titles: Record<string, string> = {
    WIRING_COMPARISON: "Product ↔ WIB wiring comparison",
    MANUFACTURING_TEST_RECOMMENDATIONS: "Manufacturing test recommendations",
    WIB_DESIGN_QUALIFICATION: "Final WIB design qualification"
  };
  const verdict = ["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"].includes(String(value.verdict))
    ? value.verdict as ArtifactSummary["verdict"]
    : null;
  return {
    id: value.id,
    kind: "ANALYSIS",
    title: titles[kind] ?? value.id,
    subtitle: value.id,
    status: verdict,
    verdict,
    analysis_kind: kind as NonNullable<ArtifactSummary["analysis_kind"]>,
    source_path: typeof value.report_path === "string" ? value.report_path : null,
    updated_at: updatedAt
  };
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
