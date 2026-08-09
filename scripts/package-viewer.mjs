import { spawn } from "node:child_process";
import path from "node:path";

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

await new Promise((resolve, reject) => {
  const child = spawn(builder, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, CIRCUIT_INSPECTOR_CORE_BINARY: executable }
  });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`electron-builder exited with ${code}`)));
});
