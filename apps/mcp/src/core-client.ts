import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

interface CoreResponse<T> {
  id: number;
  result?: T;
  error?: { code: string; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class CoreClient {
  readonly #binaryPath: string;
  #process: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();

  constructor(binaryPath = resolveCoreBinary()) {
    this.#binaryPath = binaryPath;
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const process = this.#ensureProcess();
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        reject(new DOMException("Core request cancelled", "AbortError"));
        this.#terminateProcessTree(new DOMException("Core process restarted after cancellation", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      process.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    if (!this.#process) return;
    this.#process.stdin.end(`${JSON.stringify({ id: this.#nextId++, method: "shutdown", params: {} })}\n`);
    this.#process = undefined;
  }

  #ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.#process && !this.#process.killed) return this.#process;
    if (!existsSync(this.#binaryPath)) {
      throw new Error(
        `CircuitInspector core binary not found at ${this.#binaryPath}. Build it with cargo build --release -p circuit-inspector-core or set CIRCUIT_INSPECTOR_CORE.`
      );
    }
    const child = spawn(this.#binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "1" }
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let response: CoreResponse<unknown>;
      try {
        response = JSON.parse(line) as CoreResponse<unknown>;
      } catch (error) {
        process.stderr.write(`Invalid core response: ${String(error)}\n`);
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
      } else {
        pending.resolve(response.result);
      }
    });
    child.once("exit", (code, signal) => {
      if (this.#process !== child) return;
      const error = new Error(`CircuitInspector core exited (code=${String(code)}, signal=${String(signal)})`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#process = undefined;
    });
    this.#process = child;
    return child;
  }

  #terminateProcessTree(error: Error): void {
    const child = this.#process;
    if (!child) return;
    this.#process = undefined;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.unref();
      return;
    }
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

export function resolveCoreBinary(): string {
  const configured = process.env.CIRCUIT_INSPECTOR_CORE;
  if (configured) return path.resolve(configured);
  const executable = process.platform === "win32" ? "circuit-inspector-core.exe" : "circuit-inspector-core";
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "";
  const candidates = [
    path.join(resourcesPath, "bin", executable),
    path.resolve(process.cwd(), "target", "release", executable),
    path.resolve(process.cwd(), "target", "debug", executable),
    path.resolve(import.meta.dirname, "../../../target/release", executable)
  ];
  return candidates.find(existsSync) ?? candidates[1]!;
}
