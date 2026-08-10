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

  it("extracts test-point diameter candidates without confusing pogo pitch and keeps conditional alternatives in review", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "factory-guidance.md");
    await writeFile(fixture, [
      "Keep a 1/2 diameter gap for test points smaller than 0.5 mm diameter.",
      "0.8 mm diameter test points are widely used where there is space.",
      "0.55 mm diameter test points have been validated with a 0.3 mm~0.35 mm pitch blade pogo module.",
      "Engineering test points can use either 0.4 mm diameter or 0.2 mm diameter depending on the product.",
      "An unrelated board outline example is 10 mm by 20 mm.",
      "Test point edge to board edge requires at least 1.2 mm clearance.",
      "Keep at least 2 mm from the test point edge to the tooling hole edge.",
      "Test point edge to panel tab edge requires 4 mm clearance."
    ].join("\n\n"), "utf8");

    const result = await extractRulePack([fixture], cache, "Factory guidance");

    expect(result.rulePack.rules.map((rule) => ({ kind: rule.kind, target: rule.target, threshold: rule.threshold_nm }))).toEqual([
      { kind: "MINIMUM_DIAMETER", target: null, threshold: 800_000 },
      { kind: "MINIMUM_DIAMETER", target: null, threshold: 550_000 },
      { kind: "MINIMUM_DISTANCE", target: "BOARD_EDGE", threshold: 1_200_000 },
      { kind: "MINIMUM_DISTANCE", target: "DRILL", threshold: 2_000_000 },
      { kind: "MINIMUM_DISTANCE", target: "PANEL_TAB", threshold: 4_000_000 }
    ]);
    expect(result.rulePack.rules.every((rule) => rule.severity === null)).toBe(true);
    expect(result.rulePack.review_items.map((item) => item.code)).toEqual([
      "RELATIVE_THRESHOLD",
      "AMBIGUOUS_THRESHOLD"
    ]);
    expect(result.rulePack.review_items.every((item) => item.acknowledged === false)).toBe(true);
  });

  it("extracts concrete keep-out baselines even when the prose repeats a value or names a specialized target", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-rules-"));
    temporaryDirectories.push(cache);
    const fixture = path.join(cache, "specific-clearances.md");
    await writeFile(fixture, [
      "Test point edge to board edge: make sure 1.2 mm keep-out; less than 1.2 mm is high risk.",
      "Test point edge to BGA and CSP outline requires 2.5 mm keep-out.",
      "Suggest having 0.6 mm keep-out between the test point and shielding fence outline.",
      "If UV dispensing is close to the test point, it requires a 0.5 mm gap from the test point edge to the UV glue edge."
    ].join("\n\n"), "utf8");

    const result = await extractRulePack([fixture], cache, "Specific clearances");

    expect(result.rulePack.rules.map((rule) => [rule.target, rule.threshold_nm])).toEqual([
      ["BOARD_EDGE", 1_200_000],
      ["BGA_CSP", 2_500_000],
      ["SHIELD_FENCE", 600_000],
      ["UV_GLUE", 500_000]
    ]);
    expect(result.rulePack.review_items).toEqual([]);
  });
});
