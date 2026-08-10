import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareFixtureWiring,
  confirmSchematicPinout,
  importSchematicPinout
} from "../src/wiring.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(productPins: unknown, wibPins: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-wiring-"));
  temporaryDirectories.push(root);
  const cache = path.join(root, "cache");
  const productPath = path.join(root, "product.json");
  const wibPath = path.join(root, "wib.json");
  await writeFile(productPath, JSON.stringify({ connectors: [{ reference: "J1", pins: productPins }] }), "utf8");
  await writeFile(wibPath, JSON.stringify({ connectors: [{ reference: "P3", pins: wibPins }] }), "utf8");
  const product = await importSchematicPinout(productPath, "PRODUCT", cache, "A");
  const wib = await importSchematicPinout(wibPath, "WIB", cache, "B");
  return { cache, product, wib };
}

describe("product to WIB schematic wiring comparison", () => {
  it("keeps unconfirmed schematic candidates in REVIEW", async () => {
    const { cache, product, wib } = await fixture(
      [{ number: "1", net: "VDD" }],
      [{ number: "1", net: "VDD" }]
    );

    const analysis = await compareFixtureWiring(product.id, wib.id, cache);

    expect(analysis.verdict).toBe("REVIEW");
    expect(analysis.fail_count).toBe(0);
    expect(analysis.review_count).toBe(1);
    expect(analysis.violations[0]?.verification_mode).toBe("DOCUMENT_BACKED");
  });

  it("returns PASS only when every confirmed mapped pin has the expected NET NAME", async () => {
    const { cache, product, wib } = await fixture(
      [{ number: "1", net: "VDD" }, { number: "2", net: "GND" }],
      [{ number: "1", net: "VDD" }, { number: "2", net: "GND" }]
    );
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "fixture-owner", cache);

    const analysis = await compareFixtureWiring(product.id, wib.id, cache);

    expect(analysis.verdict).toBe("PASS");
    expect(analysis.pass_count).toBe(2);
    expect(analysis.violations).toEqual([]);
    expect(await readFile(analysis.report_path, "utf8")).toContain("Product ↔ WIB wiring comparison");
    expect(await readFile(path.join(cache, "evidence", analysis.id, "wiring-overview.svg"), "utf8")).toContain("P3.2");
  });

  it("reports swapped NET NAME values as FAIL with viewer evidence", async () => {
    const { cache, product, wib } = await fixture(
      [{ number: "1", net: "SCL" }, { number: "2", net: "SDA" }],
      [{ number: "1", net: "SDA" }, { number: "2", net: "SCL" }]
    );
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "fixture-owner", cache);

    const analysis = await compareFixtureWiring(product.id, wib.id, cache);

    expect(analysis.verdict).toBe("FAIL");
    expect(analysis.fail_count).toBe(2);
    expect(analysis.violations.every((finding) => finding.rule_id === "NET_NAME_MISMATCH")).toBe(true);
    expect(analysis.violations.every((finding) => finding.evidence_uris[0]?.endsWith(".svg"))).toBe(true);
    const report = await readFile(analysis.report_path, "utf8");
    expect(report).toContain("J1.1");
    expect(report).toContain("P3.1");
    expect(report).toContain("SCL");
    expect(report).toContain("SDA");
  });

  it("offers NET NAME review without connector mapping and upgrades to PASS only with exact scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-wiring-map-"));
    temporaryDirectories.push(root);
    const cache = path.join(root, "cache");
    const productPath = path.join(root, "product.csv");
    const wibPath = path.join(root, "wib.csv");
    await writeFile(productPath, "connector,pin,net_name\nJ1,1,VDD\nJ2,1,GND\n", "utf8");
    await writeFile(wibPath, "connector,pin,net_name\nP1,1,VDD\nP2,1,GND\n", "utf8");
    const product = await importSchematicPinout(productPath, "PRODUCT", cache);
    const wib = await importSchematicPinout(wibPath, "WIB", cache);
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "fixture-owner", cache);

    const unresolved = await compareFixtureWiring(product.id, wib.id, cache);
    const resolved = await compareFixtureWiring(product.id, wib.id, cache, {
      connectorMappings: [
        { product_connector: "J1", wib_connector: "P1" },
        { product_connector: "J2", wib_connector: "P2" }
      ]
    });

    expect(unresolved.verdict).toBe("REVIEW");
    expect(unresolved.diagnostics.some((diagnostic) => diagnostic.code === "NET_NAME_REVIEW_ONLY")).toBe(true);
    expect(unresolved.net_name_review.map((row) => [row.net_name, row.status])).toEqual([
      ["GND", "MATCH_CANDIDATE"],
      ["VDD", "MATCH_CANDIDATE"]
    ]);
    expect(resolved.verdict).toBe("PASS");
  });

  it("does not require pin mapping for NET NAME review when pin identifiers differ", async () => {
    const { cache, product, wib } = await fixture(
      [{ number: "1", net: "VDD" }, { number: "2", net: "GND" }],
      [{ number: "A", net: "VDD" }, { number: "B", net: "GND" }]
    );
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "fixture-owner", cache);

    const review = await compareFixtureWiring(product.id, wib.id, cache);
    const exact = await compareFixtureWiring(product.id, wib.id, cache, {
      connectorMappings: [{
        product_connector: "J1",
        wib_connector: "P3",
        pin_map: [{ product_pin: "1", wib_pin: "A" }, { product_pin: "2", wib_pin: "B" }]
      }]
    });

    expect(review.verdict).toBe("REVIEW");
    expect(review.connections).toEqual([]);
    expect(review.net_name_review).toHaveLength(2);
    expect(exact.verdict).toBe("PASS");
  });

  it("does not let an incomplete explicit pin map hide imported pins", async () => {
    const { cache, product, wib } = await fixture(
      [{ number: "1", net: "VDD" }, { number: "2", net: "GND" }],
      [{ number: "A", net: "VDD" }, { number: "B", net: "GND" }]
    );
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "fixture-owner", cache);

    const analysis = await compareFixtureWiring(product.id, wib.id, cache, {
      connectorMappings: [{
        product_connector: "J1",
        wib_connector: "P3",
        pin_map: [{ product_pin: "1", wib_pin: "A" }]
      }]
    });

    expect(analysis.verdict).toBe("FAIL");
    expect(analysis.violations.some((finding) => finding.message.includes("unmapped"))).toBe(true);
  });

  it("does not confirm a design metric without an explicit unit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-metric-unit-"));
    temporaryDirectories.push(root);
    const cache = path.join(root, "cache");
    const source = path.join(root, "product.json");
    await writeFile(source, JSON.stringify({
      connectors: [{ reference: "J1", pins: [{ number: "1", net: "GND" }] }],
      design_metrics: [{ id: "MAX_VOLTAGE", value: 5 }]
    }), "utf8");
    const product = await importSchematicPinout(source, "PRODUCT", cache);

    await expect(confirmSchematicPinout(product.id, "owner", cache)).rejects.toThrow(/requires a unit/);
  });
});
