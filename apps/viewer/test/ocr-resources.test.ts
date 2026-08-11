import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requiredOcrResources, verifyOcrResources } from "../../../scripts/verify-ocr-resources.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("packaged OCR resources", () => {
  it("accepts a complete worker directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-ocr-"));
    temporaryDirectories.push(directory);
    await Promise.all(requiredOcrResources.map(async (relative) => {
      const target = path.join(directory, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "fixture");
    }));
    await expect(verifyOcrResources(directory)).resolves.toBeUndefined();
  });

  it("fails closed when a selectable core is missing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-ocr-"));
    temporaryDirectories.push(directory);
    await expect(verifyOcrResources(directory)).rejects.toThrow(/tesseract-core-relaxedsimd\.wasm/);
  });
});
