import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";

const SERVER_NAME = "circuit-inspector";

export interface CircuitInspectorMcpLaunch {
  command: string[];
  cwd?: string;
  environment: Record<string, string>;
}

interface OpenCodeIntegrationOptions {
  launch: CircuitInspectorMcpLaunch;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

export type OpenCodeIntegrationResult = "not-installed" | "configured" | "unchanged";

export function circuitInspectorMcpLaunch(options: {
  packaged: boolean;
  executablePath: string;
  resourcesPath: string;
  moduleDirectory: string;
  platform?: NodeJS.Platform;
}): CircuitInspectorMcpLaunch {
  const platform = options.platform ?? process.platform;
  const coreName = platform === "win32" ? "circuit-inspector-core.exe" : "circuit-inspector-core";
  if (options.packaged) {
    return {
      command: [options.executablePath, path.join(options.resourcesPath, "app.asar", "dist", "mcp", "index.js")],
      environment: {
        ELECTRON_RUN_AS_NODE: "1",
        CIRCUIT_INSPECTOR_CORE: path.join(options.resourcesPath, "bin", coreName),
        CIRCUIT_INSPECTOR_OCR_DIR: path.join(options.resourcesPath, "ocr"),
        CIRCUIT_INSPECTOR_PDF_ASSET_DIR: path.join(options.resourcesPath, "pdfjs")
      }
    };
  }

  const repositoryRoot = path.resolve(options.moduleDirectory, "../../..");
  return {
    command: [options.executablePath, path.join(repositoryRoot, "apps", "mcp", "dist", "index.js")],
    cwd: repositoryRoot,
    environment: { ELECTRON_RUN_AS_NODE: "1" }
  };
}

export async function configureOpenCodeMcp(
  options: OpenCodeIntegrationOptions
): Promise<OpenCodeIntegrationResult> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const configDirectory = path.resolve(
    environment.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config"),
    "opencode"
  );
  const configCandidates = ["opencode.jsonc", "opencode.json", "config.json"]
    .map((name) => path.join(configDirectory, name));

  if (!isOpenCodeInstalled(homeDirectory, platform, environment, configDirectory, configCandidates)) {
    return "not-installed";
  }

  const configPath = configCandidates.find(existsSync) ?? configCandidates[0]!;
  const existingText = existsSync(configPath) ? await readFile(configPath, "utf8") : "{}";
  const parsed: unknown = JSON5.parse(existingText);
  if (!isRecord(parsed)) throw new Error(`OpenCode config must contain an object: ${configPath}`);
  if (parsed.mcp !== undefined && !isRecord(parsed.mcp)) {
    throw new Error(`OpenCode config mcp field must contain an object: ${configPath}`);
  }

  const mcp = parsed.mcp ?? {};
  const entry = {
    type: "local",
    command: options.launch.command,
    ...(options.launch.cwd ? { cwd: options.launch.cwd } : {}),
    enabled: true,
    environment: options.launch.environment
  };
  if (isDeepStrictEqual(mcp[SERVER_NAME], entry)) return "unchanged";

  parsed.mcp = { ...mcp, [SERVER_NAME]: entry };
  await mkdir(configDirectory, { recursive: true });
  await atomicWrite(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return "configured";
}

function isOpenCodeInstalled(
  homeDirectory: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  configDirectory: string,
  configCandidates: string[]
): boolean {
  if (existsSync(configDirectory) || configCandidates.some(existsSync)) return true;

  const executableName = platform === "win32" ? "opencode.exe" : "opencode";
  const delimiter = platform === "win32" ? ";" : ":";
  const pathDirectories = (environment.PATH ?? environment.Path ?? "")
    .split(delimiter)
    .filter(Boolean);
  const candidates = pathDirectories.map((directory) => path.join(directory, executableName));

  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    candidates.push(
      path.join(homeDirectory, ".opencode", "bin", executableName),
      path.join(homeDirectory, ".local", "bin", executableName)
    );
    if (localAppData) candidates.push(path.join(localAppData, "opencode", "bin", executableName));
  } else {
    candidates.push(
      path.join(homeDirectory, ".opencode", "bin", executableName),
      path.join(homeDirectory, ".local", "bin", executableName),
      path.join(homeDirectory, "bin", executableName),
      "/opt/homebrew/bin/opencode",
      "/usr/local/bin/opencode"
    );
  }
  return candidates.some(existsSync);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
