import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareNodeRuntime } from "./prepare-node-runtime.mjs";
import { verifyOcrResources } from "./verify-ocr-resources.mjs";

const [platform, arch] = process.argv.slice(2);
const host = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "";
if (!host || process.platform !== host || !["arm64", "x64"].includes(arch)) {
  throw new Error("MCP packages must be staged on the matching host: <mac|win> <arm64|x64>");
}
const version = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8"))).version;
const label = platform === "mac" ? "macOS" : "Windows";
const folder = path.resolve("release", `CircuitInspector-MCP-${label}-${arch}-${version}`);
const binaryName = platform === "win" ? "circuit-inspector-core.exe" : "circuit-inspector-core";
const nodeName = platform === "win" ? "node.exe" : "node";
const nodeRuntime = path.resolve(
  process.env.CIRCUIT_INSPECTOR_NODE_RUNTIME ?? await prepareNodeRuntime(platform, arch)
);
await Promise.all([
  mkdir(path.join(folder, "bin"), { recursive: true }),
  mkdir(path.join(folder, "mcp"), { recursive: true }),
  mkdir(path.join(folder, "runtime"), { recursive: true }),
  mkdir(path.join(folder, "ocr", "lang"), { recursive: true }),
  mkdir(path.join(folder, "pdfjs"), { recursive: true }),
  mkdir(path.join(folder, "mcp", "node_modules", "@napi-rs"), { recursive: true })
]);
const canvasPackages = (await readdir(path.resolve("node_modules/@napi-rs")))
  .filter((name) => name === "canvas" || name.startsWith("canvas-"));
await Promise.all([
  copyFile(path.resolve("target/release", binaryName), path.join(folder, "bin", binaryName)),
  copyFile(path.resolve("apps/mcp/dist/index.js"), path.join(folder, "mcp/index.js")),
  copyFile(path.resolve("apps/mcp/dist/pdf.worker.mjs"), path.join(folder, "mcp/pdf.worker.mjs")),
  copyFile(path.resolve("apps/mcp/dist/ocr-worker.cjs"), path.join(folder, "ocr/ocr-worker.cjs")),
  copyFile(nodeRuntime, path.join(folder, "runtime", nodeName)),
  copyFile(path.resolve("README.md"), path.join(folder, "README.md")),
  copyFile(path.resolve("release/sbom.spdx.json"), path.join(folder, "sbom.spdx.json")),
  copyFile(path.resolve("release/THIRD_PARTY_LICENSES.csv"), path.join(folder, "THIRD_PARTY_LICENSES.csv"))
]);
await Promise.all([
  ...canvasPackages.map((name) => cp(
    path.resolve("node_modules/@napi-rs", name),
    path.join(folder, "mcp", "node_modules", "@napi-rs", name),
    { recursive: true }
  )),
  cp(path.resolve("node_modules/tesseract.js-core"), path.join(folder, "ocr"), { recursive: true }),
  cp(path.resolve("node_modules/@tesseract.js-data/eng/4.0.0_best_int"), path.join(folder, "ocr/lang"), { recursive: true }),
  cp(path.resolve("node_modules/pdfjs-dist/standard_fonts"), path.join(folder, "pdfjs/standard_fonts"), { recursive: true }),
  cp(path.resolve("node_modules/pdfjs-dist/cmaps"), path.join(folder, "pdfjs/cmaps"), { recursive: true }),
  cp(path.resolve("node_modules/pdfjs-dist/wasm"), path.join(folder, "pdfjs/wasm"), { recursive: true })
]);
await verifyOcrResources(path.join(folder, "ocr"));
const nodeLicense = path.resolve(path.dirname(nodeRuntime), "..", "LICENSE");
if (existsSync(nodeLicense)) {
  await copyFile(nodeLicense, path.join(folder, "runtime", "NODE_LICENSE"));
}
if (platform === "win") {
  await writeFile(path.join(folder, "circuit-inspector-mcp.cmd"), "@echo off\r\nset CIRCUIT_INSPECTOR_CORE=%~dp0bin\\circuit-inspector-core.exe\r\nset CIRCUIT_INSPECTOR_OCR_DIR=%~dp0ocr\r\nset CIRCUIT_INSPECTOR_PDF_ASSET_DIR=%~dp0pdfjs\r\n\"%~dp0runtime\\node.exe\" \"%~dp0mcp\\index.js\"\r\n", "utf8");
} else {
  const launcher = path.join(folder, "circuit-inspector-mcp");
  await writeFile(launcher, "#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nCIRCUIT_INSPECTOR_CORE=\"$HERE/bin/circuit-inspector-core\" CIRCUIT_INSPECTOR_OCR_DIR=\"$HERE/ocr\" CIRCUIT_INSPECTOR_PDF_ASSET_DIR=\"$HERE/pdfjs\" exec \"$HERE/runtime/node\" \"$HERE/mcp/index.js\"\n", "utf8");
  await chmod(launcher, 0o755);
  await chmod(path.join(folder, "bin", binaryName), 0o755);
  await chmod(path.join(folder, "runtime", nodeName), 0o755);
}
const archive = `${folder}.zip`;
const archiveCommand = platform === "mac" ? "/usr/bin/ditto" : "tar.exe";
const archiveArguments = platform === "mac"
  ? ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(folder), path.basename(archive)]
  : ["-a", "-c", "-f", path.basename(archive), path.basename(folder)];
await new Promise((resolve, reject) => {
  const child = spawn(archiveCommand, archiveArguments, { cwd: path.dirname(folder), stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`archive command exited with ${code}`)));
});
process.stdout.write(`Staged self-contained MCP package at ${archive}\n`);
