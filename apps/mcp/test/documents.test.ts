import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractRulePack } from "../src/documents.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("rule document extraction", () => {
  it("creates an auditable draft and never silently approves it", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.resolve("docs/rules/fixture-rule.md");
    const result = await extractRulePack([fixture], cache, "Fixture rules");

    expect(result.rulePack.status).toBe("DRAFT");
    expect(result.rulePack.approval).toBeNull();
    expect(result.ruleCount).toBe(2);
    expect(result.rulePack.rules.map((rule) => rule.threshold_nm)).toEqual([500_000, 150_000]);
    expect(result.rulePack.rules.every((rule) => rule.severity === null)).toBe(true);
    expect(result.rulePack.rules.every((rule) => rule.citation.source_hash.length === 64)).toBe(true);

    const index = JSON.parse(await readFile(result.ragIndexPath, "utf8")) as { passages: unknown[] };
    expect(index.passages.length).toBeGreaterThan(0);
  });

  it("does not turn diameters, pogo pitch, formulas, or panel tabs into test-point spacing", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "factory-guidance.md");
    await writeFile(fixture, [
      "Keep a 1/2 diameter gap for test points smaller than 0.5 mm diameter.",
      "0.8 mm diameter test points are widely used where there is space.",
      "Test points using a 0.3 mm~0.35 mm pitch blade pogo module have been validated.",
      "An unrelated board outline example is 10 mm by 20 mm.",
      "Test point edge to board edge requires at least 1.2 mm clearance.",
      "Keep at least 2 mm from the test point edge to the tooling hole edge.",
      "Test point edge to panel tab edge requires 4 mm clearance."
    ].join("\n\n"), "utf8");

    const result = await extractRulePack([fixture], cache, "Factory guidance");

    expect(result.rulePack.rules.map((rule) => ({ target: rule.target, threshold: rule.threshold_nm }))).toEqual([
      { target: "BOARD_EDGE", threshold: 1_200_000 },
      { target: "DRILL", threshold: 2_000_000 }
    ]);
    expect(result.rulePack.rules.every((rule) => rule.severity === null)).toBe(true);
    expect(result.rulePack.review_items.map((item) => item.code)).toEqual([
      "RELATIVE_THRESHOLD",
      "NON_EXECUTABLE_GUIDANCE",
      "AMBIGUOUS_THRESHOLD",
      "UNSUPPORTED_TARGET"
    ]);
    expect(result.rulePack.review_items.every((item) => item.acknowledged === false)).toBe(true);
  });
});
