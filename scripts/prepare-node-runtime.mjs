import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NODE_VERSION = "22.23.1";
const specifications = {
  "mac-arm64": {
    file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953"
  },
  "win-x64": {
    file: "win-x64/node.exe",
    sha256: "f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed"
  }
};

export async function prepareNodeRuntime(platform, arch) {
  const key = `${platform}-${arch}`;
  const specification = specifications[key];
  if (!specification) throw new Error(`No pinned Node runtime for ${key}`);
  const directory = path.resolve(".cache", "node-runtime", `v${NODE_VERSION}-${key}`);
  const executable = path.join(directory, platform === "win" ? "node.exe" : "node");
  if (existsSync(executable)) return executable;
  await mkdir(directory, { recursive: true });
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${specification.file}`;
  process.stderr.write(`Downloading pinned Node runtime ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== specification.sha256) throw new Error(`Node runtime SHA-256 mismatch: ${digest}`);
  if (platform === "win") {
    await writeFile(executable, bytes);
  } else {
    const archive = path.join(directory, specification.file);
    await writeFile(archive, bytes);
    await run("tar", ["-xzf", archive, "-C", directory]);
    const extracted = path.join(directory, `node-v${NODE_VERSION}-darwin-arm64`);
    await copyFile(path.join(extracted, "bin", "node"), executable);
    await copyFile(path.join(extracted, "LICENSE"), path.join(directory, "LICENSE"));
    await chmod(executable, 0o755);
    await rm(archive);
    await rm(extracted, { recursive: true, force: true });
  }
  const verified = createHash("sha256").update(await readFile(executable)).digest("hex");
  await writeFile(path.join(directory, "SOURCE.json"), JSON.stringify({ version: NODE_VERSION, platform, arch, source: url, archive_sha256: digest, executable_sha256: verified }, null, 2));
  return executable;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [platform, arch] = process.argv.slice(2);
  process.stdout.write(`${await prepareNodeRuntime(platform, arch)}\n`);
}
