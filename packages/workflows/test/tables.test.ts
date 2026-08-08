import { describe, expect, it } from "vitest";
import { parseTable, serializeTable } from "../src/tables.js";

describe("workbench table import and export", () => {
  it("round-trips quoted pinout CSV without losing NET NAME values", () => {
    const imported = parseTable("PINOUT", 'connector,pin,net_name\nJ1,1,"I2C,SCL"\nJ1,2,GND\n', "CSV");
    expect(imported.errors).toEqual([]);
    expect(imported.rows[0]).toEqual({ connector: "J1", pin: "1", net_name: "I2C,SCL" });

    const exported = serializeTable("PINOUT", imported.rows, "JSON");
    expect(JSON.parse(exported)).toMatchObject({ schema_version: 1, kind: "PINOUT", rows: imported.rows });
  });

  it("requires the versioned shared JSON table envelope", () => {
    const invalid = parseTable("PINOUT", JSON.stringify([{ connector: "J1", pin: "1", net_name: "GND" }]), "JSON");
    const wrongKind = parseTable("PINOUT", JSON.stringify({ schema_version: 1, kind: "NET_ALIAS", rows: [] }), "JSON");

    expect(invalid.errors[0]?.message).toContain("schema_version 1");
    expect(wrongKind.errors[0]?.message).toContain("kind PINOUT");
  });

  it("rejects duplicate pins and half-defined explicit pin mappings", () => {
    const pinout = parseTable("PINOUT", "connector,pin,net_name\nJ1,1,VDD\nJ1,1,GND\n", "CSV");
    const mappings = parseTable("CONNECTOR_MAPPING", "product_connector,wib_connector,product_pin,wib_pin\nJ1,P1,1,\n", "CSV");

    expect(pinout.errors.some((error) => error.message.includes("Duplicate"))).toBe(true);
    expect(mappings.errors.some((error) => error.message.includes("must both be present"))).toBe(true);
  });

  it("requires a valid numeric range and metric id for metric constraints", () => {
    const result = parseTable("CONSTRAINT", "id,area,requirement,check,metric_id,comparator,required_value,required_min,required_max,unit,verification_mode,source_authority\nWIB-1,ELECTRICAL,Limit leakage,DESIGN_METRIC,,RANGE,,5,2,mA,DOCUMENT_BACKED,Approved station spec\n", "CSV");

    expect(result.errors.some((error) => error.field === "metric_id")).toBe(true);
    expect(result.errors.some((error) => error.message.includes("RANGE"))).toBe(true);
  });

  it("reports missing units and non-unique aliases", () => {
    const metrics = parseTable("DESIGN_METRIC", "id,value,unit\nMAX_VOLTAGE,5,\n", "CSV");
    const aliases = parseTable("NET_ALIAS", "product_net,wib_net\nSCL,I2C_CLK\nCLK,I2C_CLK\n", "CSV");

    expect(metrics.errors.some((error) => error.field === "unit")).toBe(true);
    expect(aliases.errors.some((error) => error.field === "wib_net")).toBe(true);
  });

  it("round-trips range constraints through CSV columns", () => {
    const source = [{
      id: "WIB-1", area: "ELECTRICAL", requirement: "Current window", check: "DESIGN_METRIC",
      metric_id: "leakage", comparator: "RANGE", required_value: { min: 2, max: 5 }, unit: "mA",
      verification_mode: "DOCUMENT_BACKED", source_authority: "Approved station spec"
    }];

    const csv = serializeTable("CONSTRAINT", source, "CSV");
    const imported = parseTable("CONSTRAINT", csv, "CSV");

    expect(imported.errors).toEqual([]);
    expect(imported.rows[0]?.required_value).toEqual({ min: 2, max: 5 });
  });
});
