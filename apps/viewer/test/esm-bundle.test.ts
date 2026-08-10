import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Node ESM bundle globals", () => {
  it("loads bundled Tesseract CommonJS defaults without an unbound __dirname", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-esm-bundle-"));
    temporaryDirectories.push(directory);
    const outfile = path.join(directory, "tesseract-smoke.mjs");
    const { nodeEsmBanner } = await import("../../../scripts/esbuild-node-esm-banner.mjs") as { nodeEsmBanner: string };

    await build({
      stdin: {
        contents: "export const bundleDirectory = __dirname; export async function loadTesseract() { return import('tesseract.js'); }",
        resolveDir: path.resolve(".")
      },
      outfile,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      banner: { js: nodeEsmBanner }
    });

    const bundled = await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`) as {
      bundleDirectory: string;
      loadTesseract(): Promise<unknown>;
    };
    expect(path.resolve(bundled.bundleDirectory)).toBe(path.resolve(directory));
    await expect(bundled.loadTesseract()).resolves.toBeDefined();
  });
});
