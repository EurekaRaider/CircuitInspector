import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

const count = Number(process.argv[2] ?? 20_000_000);
const output = path.resolve(process.argv[3] ?? "benchmarks/generated-20m");
if (!Number.isSafeInteger(count) || count < 1) throw new Error("Feature count must be a positive integer");
await mkdir(output, { recursive: true });
const file = await open(path.join(output, "top.gtl"), "w");
await file.write("%FSLAX66Y66*%\n%MOMM*%\n%TF.FileFunction,Copper,L1,Top*%\n%TF.FilePolarity,Positive*%\n%ADD10C,0.100*%\nD10*\n");
const columns = 10_000;
const chunkSize = 20_000;
for (let start = 0; start < count; start += chunkSize) {
  const end = Math.min(count, start + chunkSize);
  const lines = new Array(end - start);
  for (let index = start; index < end; index += 1) {
    const x = (index % columns) * 200_000;
    const y = Math.floor(index / columns) * 200_000;
    lines[index - start] = `X${String(x).padStart(12, "0")}Y${String(y).padStart(12, "0")}D03*\n`;
  }
  await file.write(lines.join(""));
}
await file.write("M02*\n");
await file.close();
await writeFile(path.join(output, "board.gbrjob"), JSON.stringify({ Header: { GenerationSoftware: { Vendor: "CircuitInspector", Application: "Benchmark Generator", Version: "0.1.0" } }, FilesAttributes: [{ Path: "top.gtl", FileFunction: "Copper,L1,Top" }] }, null, 2));
process.stdout.write(`Generated ${count.toLocaleString()} Gerber flashes in ${output}\n`);
