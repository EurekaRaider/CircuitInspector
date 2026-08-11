import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { verifyOcrResources } from "./verify-ocr-resources.mjs";

const [platform, arch] = process.argv.slice(2);
if (!(["mac", "win"].includes(platform) && ["arm64", "x64"].includes(arch))) {
  throw new Error("Usage: node scripts/package-viewer.mjs <mac|win> <arm64|x64>");
}
const expectedHost = platform === "mac" ? "darwin" : "win32";
if (process.platform !== expectedHost) {
  throw new Error(`Viewer ${platform}-${arch} packages must be produced on the matching real platform`);
}
const executable = platform === "win" ? "circuit-inspector-core.exe" : "circuit-inspector-core";
const builder = path.resolve("node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
const args = ["--config", "apps/viewer/electron-builder.yml", `--${platform}`, `--${arch}`, "--publish", "never"];

const embeddedMcpDirectory = path.resolve("apps/viewer/dist/mcp");
await mkdir(embeddedMcpDirectory, { recursive: true });
await Promise.all([
  copyFile(path.resolve("apps/mcp/dist/index.js"), path.join(embeddedMcpDirectory, "index.js")),
  copyFile(path.resolve("apps/mcp/dist/pdf.worker.mjs"), path.join(embeddedMcpDirectory, "pdf.worker.mjs"))
]);

await new Promise((resolve, reject) => {
  const child = spawn(builder, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CIRCUIT_INSPECTOR_CORE_BINARY: executable }
  });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`electron-builder exited with ${code}`)));
});

const resourcesDirectory = platform === "mac"
  ? path.resolve("release", `mac-${arch}`, "CircuitInspector.app", "Contents", "Resources", "ocr")
  : path.resolve("release", "win-unpacked", "resources", "ocr");
await verifyOcrResources(resourcesDirectory);
