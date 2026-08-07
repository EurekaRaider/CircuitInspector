import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const output = path.resolve(process.argv[2] ?? "release");
await mkdir(output, { recursive: true });
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const cargo = spawnSync("cargo", ["metadata", "--format-version", "1", "--locked", "--no-deps"], { encoding: "utf8" });
if (cargo.status !== 0) throw new Error(cargo.stderr || "cargo metadata failed");
const cargoMetadata = JSON.parse(cargo.stdout);
const cargoLock = await readFile("Cargo.lock", "utf8");

const npmPackages = Object.entries(lock.packages ?? {})
  .filter(([location, value]) => location.startsWith("node_modules/") && value.version)
  .map(([location, value]) => ({
    SPDXID: `SPDXRef-npm-${sanitize(location)}`,
    name: value.name ?? location.slice("node_modules/".length),
    versionInfo: value.version,
    downloadLocation: value.resolved ?? "NOASSERTION",
    licenseConcluded: normalizeLicense(value.license)
  }));
const workspaceCargoPackages = cargoMetadata.packages.map((value) => ({
  SPDXID: `SPDXRef-cargo-${sanitize(`${value.name}-${value.version}`)}`,
  name: value.name,
  versionInfo: value.version,
  downloadLocation: value.source ?? "NOASSERTION",
  licenseConcluded: normalizeLicense(value.license)
}));
const lockedCargoPackages = [...cargoLock.matchAll(/\[\[package\]\]\s+name = "([^"]+)"\s+version = "([^"]+)"(?:\s+source = "([^"]+)")?/g)]
  .map((match) => ({
    SPDXID: `SPDXRef-cargo-${sanitize(`${match[1]}-${match[2]}`)}`,
    name: match[1],
    versionInfo: match[2],
    downloadLocation: match[3] ?? "NOASSERTION",
    licenseConcluded: "NOASSERTION"
  }));
const runtimePackages = [{
  SPDXID: "SPDXRef-runtime-nodejs-22.23.1",
  name: "Node.js",
  versionInfo: "22.23.1",
  downloadLocation: "https://nodejs.org/dist/v22.23.1/",
  licenseConcluded: "MIT"
}];
const packages = dedupe([...npmPackages, ...lockedCargoPackages, ...workspaceCargoPackages, ...runtimePackages]);
const created = new Date().toISOString();
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "CircuitInspector-0.1.0",
  documentNamespace: `https://circuitinspector.local/sbom/${created}`,
  creationInfo: { created, creators: ["Tool: CircuitInspector write-sbom.mjs"] },
  packages
};
await writeFile(path.join(output, "sbom.spdx.json"), JSON.stringify(sbom, null, 2), "utf8");
const rows = ["ecosystem,name,version,license"];
for (const item of packages) {
  const ecosystem = item.SPDXID.includes("-npm-") ? "npm" : "cargo";
  rows.push([ecosystem, item.name, item.versionInfo, item.licenseConcluded].map(csv).join(","));
}
await writeFile(path.join(output, "THIRD_PARTY_LICENSES.csv"), `${rows.join("\n")}\n`, "utf8");
process.stdout.write(`Wrote SPDX SBOM and ${packages.length} third-party package records\n`);

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return "NOASSERTION";
}
function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9.-]/g, "-");
}
function dedupe(items) {
  return [...new Map(items.map((item) => [`${item.SPDXID}:${item.versionInfo}`, item])).values()];
}
function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
