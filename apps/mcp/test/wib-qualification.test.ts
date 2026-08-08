import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmSchematicPinout, importSchematicPinout } from "../src/wiring.js";
import { createWibConstraintSet, qualifyWibDesign } from "../src/wib-qualification.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("closed-loop WIB qualification", () => {
  it("passes only when confirmed wiring and every approved document-backed hard metric pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-wib-qualification-"));
    temporaryDirectories.push(root);
    const cache = path.join(root, "cache");
    const productPath = path.join(root, "product.json");
    const wibPath = path.join(root, "wib.json");
    await writeFile(productPath, JSON.stringify({ connectors: [{ reference: "J1", pins: [{ number: "1", net: "VDD_3V3" }, { number: "2", net: "GND" }] }] }), "utf8");
    await writeFile(wibPath, JSON.stringify({
      connectors: [{ reference: "P1", pins: [{ number: "1", net: "VDD_3V3" }, { number: "2", net: "GND" }] }],
      design_metrics: [{ id: "CHANNEL_MAX_VOLTAGE", value: 5, unit: "V" }]
    }), "utf8");
    const product = await importSchematicPinout(productPath, "PRODUCT", cache, "A");
    const wib = await importSchematicPinout(wibPath, "WIB", cache, "B");
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "wib-owner", cache);
    const constraints = await createWibConstraintSet({
      title: "Line A WIB hard constraints",
      revision: "1",
      approvedBy: "test-engineering",
      constraints: [
        {
          id: "WIB-CONNECTIVITY",
          area: "CONNECTIVITY",
          requirement: "Product and WIB pinouts shall match",
          check: "NET_IDENTITY",
          metric_id: null,
          comparator: "ALL",
          required_value: "PASS",
          unit: null,
          verification_mode: "DOCUMENT_BACKED",
          source_authority: "Product requirement PRD-1 revision A"
        },
        {
          id: "WIB-CHANNEL-VOLTAGE",
          area: "ELECTRICAL",
          requirement: "Channel voltage rating shall be at least 3.6 V",
          check: "DESIGN_METRIC",
          metric_id: "CHANNEL_MAX_VOLTAGE",
          comparator: "MINIMUM",
          required_value: 3.6,
          unit: "V",
          verification_mode: "DOCUMENT_BACKED",
          source_authority: "Tester interface specification TIS-4 revision 2"
        }
      ]
    }, cache);

    const qualification = await qualifyWibDesign(product.id, wib.id, constraints.id, cache);

    expect(qualification.verdict).toBe("PASS");
    expect(qualification.pass_count).toBe(3);
    expect(qualification.fail_count).toBe(0);
  });

  it("keeps factory-dependent hard constraints in REVIEW even when schematics match", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-wib-factory-review-"));
    temporaryDirectories.push(root);
    const cache = path.join(root, "cache");
    const productPath = path.join(root, "product.csv");
    const wibPath = path.join(root, "wib.csv");
    await writeFile(productPath, "connector,pin,net_name\nJ1,1,GND\n", "utf8");
    await writeFile(wibPath, "connector,pin,net_name\nP1,1,GND\n", "utf8");
    const product = await importSchematicPinout(productPath, "PRODUCT", cache);
    const wib = await importSchematicPinout(wibPath, "WIB", cache);
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "wib-owner", cache);
    const constraints = await createWibConstraintSet({
      title: "Fixture constraints",
      revision: "1",
      approvedBy: "fixture-owner",
      constraints: [{
        id: "FIXTURE-REPEATABILITY",
        area: "MECHANICAL",
        requirement: "Fixture contact repeatability shall meet the approved limit",
        check: "DESIGN_METRIC",
        metric_id: "CONTACT_REPEATABILITY",
        comparator: "MAXIMUM",
        required_value: 0.1,
        unit: "ohm",
        verification_mode: "MANUAL_FACTORY_CONFIRMATION",
        source_authority: "Factory fixture specification revision 1"
      }]
    }, cache);

    const qualification = await qualifyWibDesign(product.id, wib.id, constraints.id, cache);

    expect(qualification.wiring_verdict).toBe("PASS");
    expect(qualification.verdict).toBe("REVIEW");
    expect(qualification.review_count).toBe(1);
  });

  it("rejects metric constraints without a unit before approval", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-wib-units-"));
    temporaryDirectories.push(root);

    await expect(createWibConstraintSet({
      title: "Invalid constraints",
      revision: "1",
      approvedBy: "test-engineering",
      constraints: [{
        id: "WIB-METRIC",
        area: "ELECTRICAL",
        requirement: "Voltage must stay below the controlled limit",
        check: "DESIGN_METRIC",
        metric_id: "MAX_VOLTAGE",
        comparator: "MAXIMUM",
        required_value: 5,
        unit: null,
        verification_mode: "DOCUMENT_BACKED",
        source_authority: "Approved tester specification"
      }]
    }, path.join(root, "cache"))).rejects.toThrow(/requires unit/);
  });
});
