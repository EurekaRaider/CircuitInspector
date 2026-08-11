import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchRuleCatalog } from "../src/main/rule-catalog-watcher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("rule catalog watcher", () => {
  it("reports a rule pack written by another process", async () => {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "circuit-rule-catalog-"));
    temporaryDirectories.push(cacheDirectory);
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("rule catalog change was not reported")), 2_000);
      resolveChange = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    const dispose = await watchRuleCatalog(cacheDirectory, resolveChange, { debounceMs: 5, pollIntervalMs: 10 });

    try {
      const temporaryPath = path.join(cacheDirectory, "rules", ".rules-new.json.tmp");
      await writeFile(temporaryPath, "{}", "utf8");
      await rename(temporaryPath, path.join(cacheDirectory, "rules", "rules-new.json"));
      await changed;
    } finally {
      dispose();
    }
  });
});
