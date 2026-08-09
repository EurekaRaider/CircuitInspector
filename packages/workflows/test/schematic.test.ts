import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SchematicDocument } from "@circuit-inspector/contracts";
import {
  applySchematicCorrections,
  confirmSchematicPaths,
  importSchematicDocument,
  traceSchematicInterface
} from "../src/schematic.js";
import { traceInterfacePaths } from "../src/schematic-graph.js";
import { compareFixtureWiring } from "../src/wiring.js";
import { createWibConstraintSet, qualifyWibDesign } from "../src/wib-qualification.js";

const roots: string[] = [];
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/schematic");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("schematic document v2", () => {
  it("imports a multi-page vector PDF, traces through a passive, and confirms only selected paths", async () => {
    const cacheDir = await temporaryCache();
    const imported = await importSchematicDocument(
      path.join(fixtureRoot, "product-schematic-vector.pdf"),
      "PRODUCT",
      cacheDir,
      "fixture-a"
    );

    expect(imported).toMatchObject({ schema_version: 2, source_format: "PDF", status: "DRAFT" });
    expect(imported.pages).toHaveLength(2);
    expect(imported.components.map((component) => component.refdes)).toEqual(expect.arrayContaining(["J1", "R104", "U7"]));
    expect(imported.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("CONFLICTING_NET_LABELS");
    expect(imported.graph_pins.find((pin) => pin.id === "pin-U7-36")).toMatchObject({ page: 2 });
    const candidate = imported.interface_candidates.find((item) => imported.components.find((component) => component.id === item.component_id)?.refdes === "J1");
    expect(candidate).toBeDefined();

    const traced = await traceSchematicInterface(imported.id, candidate!.id, cacheDir);
    const pinById = new Map(traced.graph_pins.map((pin) => [pin.id, pin]));
    const componentById = new Map(traced.components.map((component) => [component.id, component]));
    const sclPath = traced.paths.find((item) => pinById.get(item.anchor_pin_id)?.number === "1");
    expect(sclPath).toMatchObject({ status: "RESOLVED" });
    expect(sclPath?.component_ids.map((id) => componentById.get(id)?.refdes)).toEqual(expect.arrayContaining(["J1", "R104", "U7"]));
    expect(sclPath?.endpoint_pin_ids.map((id) => `${componentById.get(pinById.get(id)!.component_id)!.refdes}.${pinById.get(id)!.number}`)).toEqual(["U7.36"]);

    const confirmed = await confirmSchematicPaths(imported.id, candidate!.id, [sclPath!.id], "fixture-reviewer", cacheDir);
    expect(confirmed.status).toBe("PARTIALLY_CONFIRMED");
    expect(confirmed.confirmed_scopes).toHaveLength(1);
    expect(confirmed.confirmed_scopes[0]?.path_ids).toEqual([sclPath!.id]);
    expect(confirmed.pins.find((pin) => pin.pin === "1")?.confidence).toBe("EXPLICIT");
    expect(confirmed.pins.find((pin) => pin.pin === "2")?.confidence).toBe("INFERRED");
  });

  it("keeps multiple IC endpoints in REVIEW instead of choosing one", async () => {
    const cacheDir = await temporaryCache();
    const imported = await importSchematicDocument(path.join(fixtureRoot, "product-schematic-vector.pdf"), "PRODUCT", cacheDir);
    const candidate = imported.interface_candidates.find((item) => imported.components.find((component) => component.id === item.component_id)?.refdes === "J1")!;
    const ambiguous = structuredClone(imported) as SchematicDocument;
    const net = ambiguous.nets.find((item) => item.name === "MCU_SCL")!;
    const evidence = net.evidence[0]!;
    ambiguous.components.push({
      id: "component-u8",
      refdes: "U8",
      value: "alternate-endpoint",
      kind: "IC",
      page: 2,
      bbox: null,
      pin_ids: ["pin-u8-9"],
      passthrough_pin_pairs: [],
      evidence: [evidence]
    });
    ambiguous.graph_pins.push({ id: "pin-u8-9", component_id: "component-u8", number: "9", name: null, net_id: net.id, page: 2, x: null, y: null, evidence: [evidence] });
    net.pin_ids.push("pin-u8-9");

    const pathResult = traceInterfacePaths(ambiguous, candidate.id).find((item) => ambiguous.graph_pins.find((pin) => pin.id === item.anchor_pin_id)?.number === "1");
    expect(pathResult).toMatchObject({ status: "REVIEW" });
    expect(pathResult?.endpoint_pin_ids).toHaveLength(2);
    expect(pathResult?.diagnostics.map((diagnostic) => diagnostic.code)).toContain("AMBIGUOUS_CHIP_ENDPOINT");
  });

  it("records audited before/after corrections and invalidates prior confirmation", async () => {
    const cacheDir = await temporaryCache();
    const imported = await importSchematicDocument(path.join(fixtureRoot, "product-schematic-vector.pdf"), "PRODUCT", cacheDir);
    const candidate = imported.interface_candidates[0]!;
    const traced = await traceSchematicInterface(imported.id, candidate.id, cacheDir);
    await confirmSchematicPaths(imported.id, candidate.id, [traced.paths[0]!.id], "first-reviewer", cacheDir);
    const resistor = imported.components.find((component) => component.refdes === "R104")!;
    const corrected = await applySchematicCorrections(imported.id, [{ operation: "UPDATE", entity_kind: "COMPONENT", entity_id: resistor.id, after: { value: "33R" } }], "graph-editor", cacheDir, candidate.id);

    expect(corrected.status).toBe("DRAFT");
    expect(corrected.confirmed_scopes).toEqual([]);
    expect(corrected.confirmation).toBeNull();
    expect(corrected.components.find((component) => component.id === resistor.id)?.value).toBe("33R");
    expect(corrected.corrections[0]).toMatchObject({ corrected_by: "graph-editor", operation: "UPDATE", before: { value: null }, after: { value: "33R" } });
    expect(corrected.corrections[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces PASS only after every compared PDF path is resolved and confirmed", async () => {
    const cacheDir = await temporaryCache();
    const [product, wib] = await Promise.all([
      importSchematicDocument(path.join(fixtureRoot, "product-schematic-vector.pdf"), "PRODUCT", cacheDir),
      importSchematicDocument(path.join(fixtureRoot, "wib-schematic-vector.pdf"), "WIB", cacheDir)
    ]);
    const productCandidate = product.interface_candidates[0]!;
    const wibCandidate = wib.interface_candidates[0]!;
    const [tracedProduct, tracedWib] = await Promise.all([
      traceSchematicInterface(product.id, productCandidate.id, cacheDir),
      traceSchematicInterface(wib.id, wibCandidate.id, cacheDir)
    ]);

    const unconfirmed = await compareFixtureWiring(product.id, wib.id, cacheDir);
    expect(unconfirmed.verdict).toBe("REVIEW");

    await Promise.all([
      confirmSchematicPaths(product.id, productCandidate.id, tracedProduct.paths.map((item) => item.id), "fixture-reviewer", cacheDir),
      confirmSchematicPaths(wib.id, wibCandidate.id, tracedWib.paths.map((item) => item.id), "fixture-reviewer", cacheDir)
    ]);
    const confirmed = await compareFixtureWiring(product.id, wib.id, cacheDir);
    expect(confirmed.verdict).toBe("PASS");
    expect(confirmed.connections.every((connection) => connection.verdict === "PASS")).toBe(true);
    expect(confirmed.connections.find((connection) => connection.product_pin === "1")).toMatchObject({
      product_endpoint_refs: ["U7.36"],
      wib_endpoint_refs: ["U2.5"]
    });

    const constraintSet = await createWibConstraintSet({
      title: "fixture endpoint constraints",
      revision: "A",
      approvedBy: "fixture-approver",
      constraints: [
        { id: "ENDPOINT-UNIQUE", area: "CONNECTIVITY", requirement: "Every interface path has one chip endpoint", check: "ENDPOINT_UNIQUENESS", metric_id: null, comparator: "ALL", required_value: "PASS", unit: null, verification_mode: "DOCUMENT_BACKED", source_authority: "fixture golden schematic" },
        { id: "WIB-ENDPOINTS", area: "CONNECTIVITY", requirement: "WIB terminates at the specified controller pins", check: "ENDPOINT_PIN_MATCH", metric_id: null, comparator: "EXACT", required_value: "U2.5,U2.8", unit: null, verification_mode: "DOCUMENT_BACKED", source_authority: "fixture golden schematic", expected_endpoint_refs: ["U2.5", "U2.8"] }
      ]
    }, cacheDir);
    const qualification = await qualifyWibDesign(product.id, wib.id, constraintSet.id, cacheDir);
    expect(qualification.verdict).toBe("PASS");
    expect(qualification.constraint_results.map((item) => item.status)).toEqual(["PASS", "PASS", "PASS"]);
  });

  it("uses the offline OCR path for an equivalent scanned PDF", async () => {
    const cacheDir = await temporaryCache();
    const imported = await importSchematicDocument(
      path.join(fixtureRoot, "product-schematic-scanned.pdf"),
      "PRODUCT",
      cacheDir
    );

    expect(imported.pages).toHaveLength(2);
    expect(imported.pages.every((page) => page.extraction === "OCR")).toBe(true);
    expect(imported.components.map((component) => component.refdes)).toEqual(expect.arrayContaining(["J1", "R104", "U7"]));
    expect(imported.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SCANNED_PDF_OCR");
  }, 120_000);

  it("keeps JSON/CSV WIB pin mappings compatible with a traced product PDF", async () => {
    for (const file of ["wib-pinout.json", "wib-pinout.csv"]) {
      const cacheDir = await temporaryCache();
      const [product, wib] = await Promise.all([
        importSchematicDocument(path.join(fixtureRoot, "product-schematic-vector.pdf"), "PRODUCT", cacheDir),
        importSchematicDocument(path.join(fixtureRoot, file), "WIB", cacheDir)
      ]);
      const productTraced = await traceSchematicInterface(product.id, product.interface_candidates[0]!.id, cacheDir);
      const wibTraced = await traceSchematicInterface(wib.id, wib.interface_candidates[0]!.id, cacheDir);
      await Promise.all([
        confirmSchematicPaths(product.id, product.interface_candidates[0]!.id, productTraced.paths.map((item) => item.id), "fixture-reviewer", cacheDir),
        confirmSchematicPaths(wib.id, wib.interface_candidates[0]!.id, wibTraced.paths.map((item) => item.id), "fixture-reviewer", cacheDir)
      ]);
      const comparison = await compareFixtureWiring(product.id, wib.id, cacheDir);
      expect(comparison.verdict, file).toBe("PASS");
    }
  });

  it("does not silently prioritize conflicting PDF and structured WIB sources at the same revision", async () => {
    const cacheDir = await temporaryCache();
    await importSchematicDocument(path.join(fixtureRoot, "wib-schematic-vector.pdf"), "WIB", cacheDir, "same-revision");
    const conflictingFile = path.join(cacheDir, "conflicting-wib.json");
    await writeFile(conflictingFile, JSON.stringify({ revision: "same-revision", pins: [{ connector: "P1", pin: "1", net_name: "WRONG_NET" }, { connector: "P1", pin: "2", net_name: "GND" }] }), "utf8");
    const conflicting = await importSchematicDocument(conflictingFile, "WIB", cacheDir, "same-revision");
    expect(conflicting.diagnostics.map((item) => item.code)).toContain("SCHEMATIC_SOURCE_CONFLICT");
    const candidate = conflicting.interface_candidates[0]!;
    const traced = await traceSchematicInterface(conflicting.id, candidate.id, cacheDir);
    await expect(confirmSchematicPaths(conflicting.id, candidate.id, traced.paths.map((item) => item.id), "reviewer", cacheDir)).rejects.toThrow(/source conflict/i);

    const wrongNet = conflicting.nets.find((net) => net.name === "WRONG_NET")!;
    const corrected = await applySchematicCorrections(conflicting.id, [{ operation: "UPDATE", entity_kind: "NET", entity_id: wrongNet.id, after: { name: "WIB_SCL" } }], "reviewer", cacheDir, candidate.id);
    expect(corrected.diagnostics.map((item) => item.code)).not.toContain("SCHEMATIC_SOURCE_CONFLICT");
    expect(corrected.corrections).toHaveLength(1);
  });
});

async function temporaryCache() {
  const root = await mkdtemp(path.join(os.tmpdir(), "circuit-schematic-v2-"));
  roots.push(root);
  return root;
}
