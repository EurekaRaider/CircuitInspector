export const nodeEsmBanner = [
  "import { createRequire as __circuitInspectorCreateRequire } from 'node:module';",
  "import { fileURLToPath as __circuitInspectorFileURLToPath } from 'node:url';",
  "const require = __circuitInspectorCreateRequire(import.meta.url);",
  "const __filename = __circuitInspectorFileURLToPath(import.meta.url);",
  "const __dirname = __circuitInspectorFileURLToPath(new URL('.', import.meta.url));"
].join("\n");

export const nodeEsmCliBanner = `#!/usr/bin/env node\n${nodeEsmBanner}`;
