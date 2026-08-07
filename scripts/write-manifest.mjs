import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "release");
const manifestPath = path.join(root, "SHA256SUMS");
const files = await walk(root);
const lines = [];
for (const file of files.filter((file) => path.resolve(file) !== manifestPath)) {
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  lines.push(`${digest}  ${path.relative(root, file).split(path.sep).join("/")}`);
}
await writeFile(manifestPath, `${lines.sort().join("\n")}\n`, "utf8");
process.stdout.write(`Wrote ${lines.length} SHA-256 entries to ${manifestPath}\n`);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile() && (await stat(target)).size >= 0) files.push(target);
  }
  return files;
}
