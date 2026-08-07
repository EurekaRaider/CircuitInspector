import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

const source = path.resolve(process.argv[2] ?? "benchmarks/generated-20m");
const core = path.resolve(process.env.CIRCUIT_INSPECTOR_CORE ?? `target/release/circuit-inspector-core${process.platform === "win32" ? ".exe" : ""}`);
const cache = path.resolve(process.argv[3] ?? "benchmarks/cache");
const child = spawn(core, [], { stdio: ["pipe", "pipe", "inherit"] });
const started = performance.now();
const line = await new Promise((resolve, reject) => {
  readline.createInterface({ input: child.stdout }).once("line", resolve);
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`core exited before response: ${code}`)));
  child.stdin.write(`${JSON.stringify({ id: 1, method: "import_design", params: { path: source, cache_dir: cache } })}\n`);
});
const elapsedMs = performance.now() - started;
const response = JSON.parse(String(line));
child.stdin.end(`${JSON.stringify({ id: 2, method: "shutdown", params: {} })}\n`);
process.stdout.write(`${JSON.stringify({ elapsed_ms: Math.round(elapsedMs), cache_hit: response.result?.cache_hit, features: response.result?.layers?.reduce((sum, layer) => sum + layer.feature_count, 0), diagnostics: response.result?.diagnostics, error: response.error }, null, 2)}\n`);
if (response.error) process.exitCode = 1;
