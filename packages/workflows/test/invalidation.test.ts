import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkflowArtifacts } from "../src/artifacts.js";
import { invalidateDependentAnalyses } from "../src/invalidation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controlled-input invalidation", () => {
  it("marks dependent JSON and HTML reports stale and exposes STALE in the artifact catalog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-invalidation-"));
    roots.push(root);
    const evidence = path.join(root, "evidence", "layout-analysis");
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, "analysis.json"), JSON.stringify({ schema_version: 1, kind: "LAYOUT_TEST_ACCESS_ANALYSIS", id: "layout-analysis", design_id: "design-a", test_plan_id: "plan-a", verdict: "PASS", report_path: path.join(evidence, "report.html") }), "utf8");
    await writeFile(path.join(evidence, "report.html"), "<!doctype html><html><body><main>Original report</main></body></html>", "utf8");

    const ids = await invalidateDependentAnalyses(root, (analysis) => analysis.test_plan_id === "plan-a", "ECO changed the approved DFT baseline");

    expect(ids).toEqual(["layout-analysis"]);
    const analysis = JSON.parse(await readFile(path.join(evidence, "analysis.json"), "utf8")) as { stale?: { is_stale: boolean; reason: string } };
    expect(analysis.stale).toMatchObject({ is_stale: true, reason: "ECO changed the approved DFT baseline" });
    expect(await readFile(path.join(evidence, "report.html"), "utf8")).toContain("data-circuitinspector-stale=\"true\"");
    expect((await listWorkflowArtifacts(root)).artifacts[0]?.status).toBe("STALE");
  });
});
