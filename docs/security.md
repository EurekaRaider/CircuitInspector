# Local Security Model

- No network requests are made by default. Designs, specifications, caches, rules, and evidence remain in the local cache directory.
- Streaming extraction of `.zip` and `.tgz` archives rejects absolute paths, `..` traversal, and symbolic-link or hard-link escapes. Extraction is limited to 200,000 entries, 16 GiB of total expanded data, and 4 GiB per file.
- Cache IDs, analysis IDs, and evidence filenames are restricted to a single path segment. The Viewer may open files only from the local evidence root directory.
- Electron enables `contextIsolation` and the renderer sandbox while disabling `nodeIntegration`. The preload script exposes only a narrow IPC API.
- MCP stdout contains JSON-RPC messages only. Diagnostics from the native core are forwarded to stderr.
- Specification extraction creates DRAFT rule packs only. Approval records include the approver, timestamp, and SHA-256 hash of the rule content; the core refuses to execute unapproved rule packs.
- `SemanticCoverage` is part of every verdict. Missing or inferred semantics cannot be promoted to a formal FAIL or PASS result.

Internal builds are currently unsigned and not notarized. Deployments should use enterprise software distribution, file hashes, and the SBOM to verify artifact provenance.
