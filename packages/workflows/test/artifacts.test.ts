import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkflowArtifacts, readWibWorkflowDraft, saveWibWorkflowDraft } from "../src/artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared local artifact catalog", () => {
  it("discovers legacy artifacts, reports corrupt entries, and saves resumable drafts separately", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-workbench-catalog-"));
    roots.push(root);
    const pinoutDir = path.join(root, "pinouts");
    const evidenceDir = path.join(root, "evidence", "wiring-abc");
    await Promise.all([mkdir(pinoutDir, { recursive: true }), mkdir(evidenceDir, { recursive: true })]);
    const pinoutPath = path.join(pinoutDir, "pinout-product.json");
    const pinout = { schema_version: 1, id: "pinout-product", role: "PRODUCT", source_path: "/inputs/product.json", source_format: "JSON", status: "DRAFT", pins: [{ connector: "J1", pin: "1", net_name: "VDD" }] };
    await writeFile(pinoutPath, JSON.stringify(pinout), "utf8");
    await writeFile(path.join(pinoutDir, "broken.json"), "{not-json", "utf8");
    await writeFile(path.join(evidenceDir, "analysis.json"), JSON.stringify({ schema_version: 1, kind: "WIRING_COMPARISON", id: "wiring-abc", verdict: "REVIEW", report_path: path.join(evidenceDir, "report.html") }), "utf8");

    const saved = await saveWibWorkflowDraft(root, {
      schema_version: 1,
      id: "wib-draft-a",
      title: "Fixture rev B",
      step: 3,
      product_pinout_id: "pinout-product",
      wib_pinout_id: null,
      product_edits: {
        pins: [{ connector: "J1", pin: "1", net_name: "VDD_EDITED" }],
        design_metrics: [{ id: "rail", value: 5, unit: "V" }],
        revision: "B"
      },
      connector_mappings: [],
      net_aliases: [],
      case_sensitive: true,
      constraint_set_id: null,
      constraint_title: "Fixture constraints",
      constraint_revision: "B",
      constraint_rows: [],
      updated_at: ""
    });
    const catalog = await listWorkflowArtifacts(root);

    expect(catalog.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(["PINOUT", "ANALYSIS", "WORKFLOW_DRAFT"]));
    expect(catalog.diagnostics.some((diagnostic) => diagnostic.code === "INVALID_CACHED_ARTIFACT")).toBe(true);
    expect(await readWibWorkflowDraft(root, saved.id)).toMatchObject({
      title: "Fixture rev B",
      step: 3,
      case_sensitive: true,
      product_edits: { revision: "B", pins: [{ net_name: "VDD_EDITED" }] }
    });
    expect(JSON.parse(await readFile(pinoutPath, "utf8"))).toEqual(pinout);
  });
});
