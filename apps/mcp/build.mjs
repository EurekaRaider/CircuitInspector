import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { nodeEsmCliBanner } from "../../scripts/esbuild-node-esm-banner.mjs";

await Promise.all([
  build({
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    loader: { ".node": "copy" },
    banner: {
      js: nodeEsmCliBanner
    },
    external: ["@napi-rs/canvas", "@napi-rs/canvas-*"]
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
