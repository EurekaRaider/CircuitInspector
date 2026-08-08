import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertArtifactId, assertGrantedPath, assertOneOf, assertPathInside, withArtifactId } from "../src/main/security.js";

describe("viewer IPC security boundaries", () => {
  it("accepts stable IDs and rejects traversal-like artifact identifiers", () => {
    expect(assertArtifactId("analysis_01-a")).toBe("analysis_01-a");
    expect(() => assertArtifactId("../analysis.json")).toThrow(/Invalid/);
    expect(() => withArtifactId({}, "analysis_id")).toThrow(/Invalid/);
  });

  it("only accepts exact paths granted by a file chooser", () => {
    const selected = path.resolve("/tmp/circuit-selected/input.csv");
    const grants = new Set([selected]);
    expect(assertGrantedPath(grants, selected)).toBe(selected);
    expect(() => assertGrantedPath(grants, "/tmp/circuit-selected/other.csv")).toThrow(/not selected/);
  });

  it("keeps evidence opening inside a concrete artifact directory", () => {
    const root = path.resolve("/tmp/circuit-cache/evidence");
    expect(assertPathInside(root, path.join(root, "analysis-a", "report.html"))).toBe(path.join(root, "analysis-a", "report.html"));
    expect(() => assertPathInside(root, root)).toThrow(/inside/);
    expect(() => assertPathInside(root, path.resolve("/tmp/circuit-cache/evidence-copy/report.html"))).toThrow(/inside/);
  });

  it("rejects unexpected enum values crossing IPC", () => {
    expect(assertOneOf("CSV", ["CSV", "JSON"] as const, "format")).toBe("CSV");
    expect(() => assertOneOf("HTML", ["CSV", "JSON"] as const, "format")).toThrow(/Invalid format/);
  });
});
