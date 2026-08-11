import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AnalysisStaleState {
  is_stale: true;
  reason: string;
  invalidated_at: string;
}

export async function invalidateDependentAnalyses(
  cacheDir: string,
  matches: (analysis: Record<string, unknown>) => boolean,
  reason: string
): Promise<string[]> {
  const evidenceRoot = path.join(cacheDir, "evidence");
  let names: string[];
  try {
    names = await readdir(evidenceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const invalidated: string[] = [];
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    const analysisPath = path.join(evidenceRoot, name, "analysis.json");
    let analysis: Record<string, unknown>;
    try {
      analysis = JSON.parse(await readFile(analysisPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!matches(analysis)) continue;
    const stale: AnalysisStaleState = { is_stale: true, reason, invalidated_at: new Date().toISOString() };
    await writeFile(analysisPath, JSON.stringify({ ...analysis, stale }, null, 2), "utf8");
    await markReportStale(path.join(evidenceRoot, name, "report.html"), stale);
    invalidated.push(typeof analysis.id === "string" ? analysis.id : name);
  }
  return invalidated;
}

async function markReportStale(reportPath: string, stale: AnalysisStaleState) {
  let report: string;
  try {
    report = await readFile(reportPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const banner = `<aside data-circuitinspector-stale="true" style="position:sticky;top:0;z-index:9999;padding:14px 20px;border-bottom:1px solid #bd735f;background:#4a241dcc;color:#ffd7cb;font:600 12px/1.5 ui-monospace,monospace;backdrop-filter:blur(12px)">STALE / OUTDATED ANALYSIS · ${html(stale.reason)} · invalidated ${html(stale.invalidated_at)}. Re-run the closed loop before using this report.</aside>`;
  const withoutOldBanner = report.replace(/<aside data-circuitinspector-stale="true"[\s\S]*?<\/aside>/, "");
  await writeFile(reportPath, withoutOldBanner.replace(/<body([^>]*)>/i, `<body$1>${banner}`), "utf8");
}

function html(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
