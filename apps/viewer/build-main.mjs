import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    banner: {
      js: "import { createRequire as __circuitInspectorCreateRequire } from 'node:module';\nconst require = __circuitInspectorCreateRequire(import.meta.url);"
    },
    external: ["electron"]
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
  })
]);
