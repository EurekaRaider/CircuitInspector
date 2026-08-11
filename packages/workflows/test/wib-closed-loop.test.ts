import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveManufacturingTestPlan, recommendManufacturingTests } from "../src/test-recommendations.js";
import { createWibConstraintSet, createWibInterfaceContract, qualifyWibClosedLoop } from "../src/wib-qualification.js";
import { confirmSchematicPinout, importSchematicPinout } from "../src/wiring.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("controlled WIB closed loop", () => {
  it("fails a confirmed pin swap against the approved interface contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-wib-closed-loop-"));
    temporaryDirectories.push(root);
    const cache = path.join(root, "cache");
    const productPath = path.join(root, "product.json");
    const wibPath = path.join(root, "wib.json");
    await writeFile(productPath, JSON.stringify({ connectors: [{ reference: "J1", pins: [{ number: "1", net: "SIGNAL_A" }, { number: "2", net: "SIGNAL_B" }] }] }), "utf8");
    await writeFile(wibPath, JSON.stringify({ connectors: [{ reference: "P1", pins: [{ number: "1", net: "SIGNAL_B" }, { number: "2", net: "SIGNAL_A" }] }] }), "utf8");
    const product = await importSchematicPinout(productPath, "PRODUCT", cache, "A");
    const wib = await importSchematicPinout(wibPath, "WIB", cache, "B");
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "wib-owner", cache);

    const draft = await recommendManufacturingTests(product.id, cache);
    const plan = await approveManufacturingTestPlan(draft.id, {
      approvedBy: "test-owner",
      factory: "Factory A",
      line: "Line 1",
      tester: "FCT-01",
      approvedRulePackId: "rules-factory-a"
    }, cache);
    const contract = await createWibInterfaceContract({
      title: "Product to WIB pin contract",
      revision: "1",
      approvedBy: "interface-owner",
      productPinoutId: product.id,
      wibPinoutId: wib.id,
      connectorMappings: [{
        product_connector: "J1",
        wib_connector: "P1",
        pin_map: [{ product_pin: "1", wib_pin: "1" }, { product_pin: "2", wib_pin: "2" }]
      }]
    }, cache);
    const constraints = await createWibConstraintSet({
      title: "WIB connectivity",
      revision: "1",
      approvedBy: "wib-owner",
      constraints: [{
        id: "WIB-NET-IDENTITY",
        area: "CONNECTIVITY",
        requirement: "Every exact pin mapping shall preserve the approved NET identity",
        check: "NET_IDENTITY",
        metric_id: null,
        comparator: "ALL",
        required_value: "PASS",
        unit: null,
        verification_mode: "DOCUMENT_BACKED",
        source_authority: "Approved product-to-WIB interface contract"
      }]
    }, cache);

    const qualification = await qualifyWibClosedLoop(product.id, wib.id, contract.id, plan.id, constraints.id, cache);

    expect(qualification.wiring_verdict).toBe("FAIL");
    expect(qualification.verdict).toBe("FAIL");
    expect(qualification.requirement_results?.some((result) => result.status === "FAIL")).toBe(true);
    expect(qualification.production_readiness_verdict).toBe("REVIEW");
    expect(qualification.factory_confirmation_items).toHaveLength(6);
  });

  it("rejects interface approval when explicit pin coverage is incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-wib-contract-"));
    temporaryDirectories.push(root);
    const cache = path.join(root, "cache");
    const productPath = path.join(root, "product.csv");
    const wibPath = path.join(root, "wib.csv");
    await writeFile(productPath, "connector,pin,net_name\nJ1,1,A\nJ1,2,B\n", "utf8");
    await writeFile(wibPath, "connector,pin,net_name\nP1,1,A\nP1,2,B\n", "utf8");
    const product = await importSchematicPinout(productPath, "PRODUCT", cache, "A");
    const wib = await importSchematicPinout(wibPath, "WIB", cache, "B");
    await confirmSchematicPinout(product.id, "product-owner", cache);
    await confirmSchematicPinout(wib.id, "wib-owner", cache);

    await expect(createWibInterfaceContract({
      title: "Incomplete contract",
      revision: "1",
      approvedBy: "interface-owner",
      productPinoutId: product.id,
      wibPinoutId: wib.id,
      connectorMappings: [{ product_connector: "J1", wib_connector: "P1", pin_map: [{ product_pin: "1", wib_pin: "1" }] }]
    }, cache)).rejects.toThrow(/cover every confirmed interface pin/);
  });
});
