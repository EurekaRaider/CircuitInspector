import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recommendManufacturingTests } from "../src/test-recommendations.js";
import { confirmSchematicPinout, importSchematicPinout } from "../src/wiring.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("manufacturing test and WIB design recommendations", () => {
  it("derives test groups and WIB guidance without inventing factory numeric limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-test-plan-"));
    temporaryDirectories.push(root);
    const cache = path.join(root, "cache");
    const source = path.join(root, "product.json");
    await writeFile(source, JSON.stringify({
      connectors: [{
        reference: "J1",
        pins: [
          { number: "1", net: "GND" },
          { number: "2", net: "VDD_3V3" },
          { number: "3", net: "SWDIO" },
          { number: "4", net: "SWCLK" },
          { number: "5", net: "I2C_SCL" },
          { number: "6", net: "I2C_SDA" },
          { number: "7", net: "ADC_TEMP_SENSE" },
          { number: "8", net: "RESET_N" }
        ]
      }]
    }), "utf8");
    const product = await importSchematicPinout(source, "PRODUCT", cache, "A1");
    await confirmSchematicPinout(product.id, "hardware-owner", cache);

    const plan = await recommendManufacturingTests(product.id, cache);

    expect(plan.verdict).toBe("REVIEW");
    expect(plan.recommendations.map((item) => item.category)).toEqual(expect.arrayContaining([
      "GROUND", "POWER", "PROGRAMMING_DEBUG", "RESET_BOOT", "DIGITAL_INTERFACE", "ANALOG_SENSOR"
    ]));
    expect(plan.wib_design_recommendations.map((item) => item.category)).toEqual(expect.arrayContaining(["POWER", "PROGRAMMING_DEBUG", "ANALOG_SENSOR"]));
    expect(plan.wib_constraints.filter((constraint) => constraint.area === "CONNECTIVITY").every((constraint) => constraint.required_value !== null)).toBe(true);
    const implementationConstraints = plan.wib_constraints.filter((constraint) => constraint.verification_mode === "MANUAL_IMPLEMENTATION_CONFIRMATION");
    expect(implementationConstraints.length).toBeGreaterThan(0);
    expect(implementationConstraints.every((constraint) => constraint.required_value === null && constraint.status === "REVIEW")).toBe(true);
    const probe = plan.wib_constraints.find((constraint) => constraint.id === "WIB-PROBE-001");
    expect(probe?.requirement).toContain("define and approve the probe family/type");
    expect(probe?.owner).toContain("requirement owner");
    const report = await readFile(plan.report_path, "utf8");
    expect(report).toContain("Corresponding WIB design recommendations");
    expect(report).toContain("WIB constraints and hard metrics");
    expect(report).toContain("TBD by authority");
  });
});
