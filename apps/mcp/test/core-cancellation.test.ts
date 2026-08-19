import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "../src/core-client.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("core cancellation", () => {
  it.runIf(process.platform !== "win32")("kills the active process group and restarts cleanly for the next request", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "circuit-core-cancel-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "fake core");
    await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "slow") setTimeout(() => process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\\n"), 5000);
  else process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\\n");
});
`, "utf8");
    await chmod(executable, 0o755);
    const client = new CoreClient(executable);
    const controller = new AbortController();
    const pending = client.request("slow", {}, controller.signal);
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.request<{ ok: boolean }>("ping", {})).resolves.toEqual({ ok: true });
    client.close();
  });
});
