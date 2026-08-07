import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    expect(result.rulePack.rules.every((rule) => rule.citation.source_hash.length === 64)).toBe(true);

    const index = JSON.parse(await readFile(result.ragIndexPath, "utf8")) as { passages: unknown[] };
    expect(index.passages.length).toBeGreaterThan(0);
  });
});
