import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

interface RuleCatalogWatcherOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  onError?(error: Error): void;
}

export async function watchRuleCatalog(
  cacheDirectory: string,
  onChange: () => void,
  options: RuleCatalogWatcherOptions = {}
): Promise<() => void> {
  const rulesDirectory = path.join(cacheDirectory, "rules");
  await mkdir(rulesDirectory, { recursive: true });
  let signature = await ruleCatalogSignature(rulesDirectory);
  let closed = false;
  let watcher: FSWatcher | undefined;
  let pending: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let checking = false;
  let checkAgain = false;

  const notify = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(onChange, options.debounceMs ?? 50);
  };
  const detectChange = async () => {
    if (closed) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      const nextSignature = await ruleCatalogSignature(rulesDirectory);
      if (!closed && nextSignature !== signature) {
        signature = nextSignature;
        notify();
      }
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      checking = false;
      if (checkAgain) {
        checkAgain = false;
        void detectChange();
      }
    }
  };
  const startPolling = () => {
    if (pollTimer || closed) return;
    pollTimer = setInterval(() => void detectChange(), options.pollIntervalMs ?? 500);
  };

  try {
    watcher = watch(rulesDirectory, (_eventType, filename) => {
      const name = filename?.toString();
      if (name && (name.startsWith(".") || !name.endsWith(".json"))) return;
      void detectChange();
    });
    watcher.on("error", (error) => {
      options.onError?.(error);
      watcher?.close();
      watcher = undefined;
      startPolling();
    });
    void detectChange();
  } catch (error) {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
    startPolling();
  }

  return () => {
    if (closed) return;
    closed = true;
    if (pending) clearTimeout(pending);
    if (pollTimer) clearInterval(pollTimer);
    watcher?.close();
  };
}

async function ruleCatalogSignature(rulesDirectory: string): Promise<string> {
  const names = (await readdir(rulesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const entries = await Promise.all(names.map(async (name) => {
    const metadata = await stat(path.join(rulesDirectory, name));
    return `${name}:${metadata.size}:${metadata.mtimeMs}`;
  }));
  return entries.join("|");
}
