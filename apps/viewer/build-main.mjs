import { build } from "esbuild";
import { copyFile, rm } from "node:fs/promises";
import { nodeEsmBanner } from "../../scripts/esbuild-node-esm-banner.mjs";

await rm("dist/node_modules/@napi-rs", { recursive: true, force: true });

await Promise.all([
  build({
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    loader: { ".node": "copy" },
    banner: {
      js: nodeEsmBanner
    },
    external: ["electron", "@napi-rs/canvas", "@napi-rs/canvas-*"]
  }),
  build({
    entryPoints: ["src/main/preload.ts"],
    outfile: "dist/preload.cjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: true,
    external: ["electron"]
  }),
  build({
    entryPoints: ["../../node_modules/tesseract.js/src/worker-script/node/index.js"],
    outfile: "dist/ocr-worker.cjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: true
  })
]);
await copyFile("../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "dist/pdf.worker.mjs");
