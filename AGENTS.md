# Repository Guidelines

## Project Structure & Module Organization

CircuitInspector is a Rust/TypeScript workspace. `crates/circuit-core/` contains PCB parsing, analysis, evidence, and tiling. `packages/contracts/` defines shared types; `packages/workflows/` implements schematic and qualification workflows. `apps/mcp/` exposes MCP tools, and `apps/viewer/` is the Electron/React UI. Tests live under each layer’s `test/` or `tests/` directory. Controlled inputs are in `fixtures/`, documentation in `docs/`, icons in `apps/viewer/assets/`, and packaging utilities in `scripts/`. Treat `target/`, `node_modules/`, and `release/` as generated output.

## Build, Test, and Development Commands

- `npm install` — install workspace dependencies.
- `npm run dev:viewer` — start the Vite renderer; launch Electron separately with `npm start -w @circuit-inspector/viewer`.
- `npm run start:mcp` — run the local MCP server.
- `npm run typecheck` — type-check every TypeScript workspace.
- `npm test` — run Rust tests followed by Vitest suites.
- `npm run build` — build the release Rust core, MCP bundle, and Viewer.
- `npm run package:mac` / `npm run package:win` — package on the matching real OS and architecture.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript/TSX and standard `rustfmt` output in Rust. TypeScript is strict; avoid unchecked casts and handle optional values explicitly. Use `camelCase` for functions, `PascalCase` for components and types, and `SCREAMING_SNAKE_CASE` for constants. Name Vitest files `*.test.ts`; keep Rust integration tests in `crates/circuit-core/tests/`. Match nearby code and avoid unrelated refactors. Run `cargo fmt --check` and `git diff --check` before review.

## Testing Guidelines

Add fixtures and regression tests for parser, graph, security, or verdict changes. Exercise deterministic success and `REVIEW` paths; ambiguity, OCR uncertainty, missing semantics, and conflicts must not be guessed into `PASS` or `FAIL`. Coverage is not threshold-gated, so assert statuses, evidence locations, and compatibility directly. UI changes should include interaction tests and, when practical, a real Electron-window check.

## Commit & Pull Request Guidelines

History uses short imperative subjects, sometimes with prefixes such as `feat:` or `chore:`. Keep commits scoped. Pull requests should summarize behavior, list validation commands, link issues, and include screenshots for visible UI changes. State platform, signing, fixture, or network limitations explicitly. Changes require CODEOWNER review from `@williamjinj-eng`.

## Security & Local-First Constraints

Preserve authorized-input and cache-boundary checks in Viewer IPC and MCP paths. Do not add cloud OCR, external component lookup, or telemetry. Never commit customer designs, local caches, credentials, generated packages, or proprietary conformance fixtures.
