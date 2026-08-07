import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __circuitInspectorCreateRequire } from 'node:module';\nconst require = __circuitInspectorCreateRequire(import.meta.url);"
  }
});
