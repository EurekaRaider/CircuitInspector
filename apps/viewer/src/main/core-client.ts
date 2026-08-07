import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}
export class CoreClient {
  readonly #binary: string;
  #child: ChildProcessWithoutNullStreams | undefined;
  #id = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(binary = coreBinary()) {
    this.#binary = binary;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const child = this.#start();
    const id = this.#id++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    this.#child?.stdin.end(`${JSON.stringify({ id: this.#id++, method: "shutdown", params: {} })}\n`);
    this.#child = undefined;
  }

  #start(): ChildProcessWithoutNullStreams {
    if (this.#child && !this.#child.killed) return this.#child;
    if (!existsSync(this.#binary)) throw new Error(`Native core not found at ${this.#binary}`);
    const child = spawn(this.#binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const response = JSON.parse(line) as { id: number; result?: unknown; error?: { code: string; message: string } };
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
      else pending.resolve(response.result);
    });
    child.once("exit", (code) => {
      const error = new Error(`Native core exited with code ${String(code)}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#child = undefined;
    });
    this.#child = child;
    return child;
  }
}

function coreBinary(): string {
  const executable = process.platform === "win32" ? "circuit-inspector-core.exe" : "circuit-inspector-core";
  const configured = process.env.CIRCUIT_INSPECTOR_CORE;
  if (configured) return path.resolve(configured);
  const candidates = [
    path.join(process.resourcesPath, "bin", executable),
    path.resolve(process.cwd(), "target/release", executable),
    path.resolve(process.cwd(), "target/debug", executable),
    path.resolve(import.meta.dirname, "../../../../target/release", executable)
  ];
  return candidates.find(existsSync) ?? candidates[1]!;
}
