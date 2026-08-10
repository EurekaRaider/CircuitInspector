import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterEach, describe, expect, it } from "vitest";
import {
  circuitInspectorMcpLaunch,
  configureOpenCodeMcp,
  type CircuitInspectorMcpLaunch
} from "../src/main/opencode-integration.js";

const temporaryDirectories: string[] = [];
const launch: CircuitInspectorMcpLaunch = {
  command: ["/Applications/CircuitInspector.app/Contents/MacOS/CircuitInspector", "/Applications/CircuitInspector.app/Contents/Resources/app.asar/dist/mcp/index.js"],
  environment: {
    ELECTRON_RUN_AS_NODE: "1",
    CIRCUIT_INSPECTOR_CORE: "/Applications/CircuitInspector.app/Contents/Resources/bin/circuit-inspector-core",
    CIRCUIT_INSPECTOR_OCR_DIR: "/Applications/CircuitInspector.app/Contents/Resources/ocr",
    CIRCUIT_INSPECTOR_PDF_ASSET_DIR: "/Applications/CircuitInspector.app/Contents/Resources/pdfjs"
  }
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenCode MCP integration", () => {
  it("does nothing when OpenCode is not installed", async () => {
    const homeDirectory = await temporaryHome();
    await expect(configureOpenCodeMcp({
      launch,
      homeDirectory,
      platform: "darwin",
      environment: { PATH: "" }
    })).resolves.toBe("not-installed");
    await expect(stat(path.join(homeDirectory, ".config", "opencode"))).rejects.toThrow();
  });

  it("creates the preferred global config when the OpenCode executable exists", async () => {
    const homeDirectory = await temporaryHome();
    const binDirectory = path.join(homeDirectory, "bin");
    await mkdir(binDirectory, { recursive: true });
    await writeFile(path.join(binDirectory, "opencode"), "");

    await expect(configureOpenCodeMcp({
      launch,
      homeDirectory,
      platform: "darwin",
      environment: { PATH: binDirectory }
    })).resolves.toBe("configured");

    const configPath = path.join(homeDirectory, ".config", "opencode", "opencode.jsonc");
    const config = JSON5.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({ mcp: { "circuit-inspector": { ...launch, type: "local", enabled: true } } });
  });

  it("merges only CircuitInspector into an existing JSONC config", async () => {
    const homeDirectory = await temporaryHome();
    const configDirectory = path.join(homeDirectory, ".config", "opencode");
    const configPath = path.join(configDirectory, "opencode.jsonc");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, `{
      // Existing user preferences must survive the merge.
      theme: 'system',
      mcp: {
        existing: { type: 'remote', url: 'https://example.test/mcp', enabled: false },
        'circuit-inspector': { type: 'local', command: ['stale'], enabled: false },
      },
    }`);

    await expect(configureOpenCodeMcp({
      launch,
      homeDirectory,
      platform: "darwin",
      environment: { PATH: "" }
    })).resolves.toBe("configured");

    const config = JSON5.parse(await readFile(configPath, "utf8")) as {
      theme: string;
      mcp: Record<string, unknown>;
    };
    expect(config.theme).toBe("system");
    expect(config.mcp.existing).toEqual({ type: "remote", url: "https://example.test/mcp", enabled: false });
    expect(config.mcp["circuit-inspector"]).toEqual({ type: "local", ...launch, enabled: true });
  });

  it("uses an existing opencode.json and avoids rewriting an unchanged entry", async () => {
    const homeDirectory = await temporaryHome();
    const configDirectory = path.join(homeDirectory, ".config", "opencode");
    const configPath = path.join(configDirectory, "opencode.json");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      mcp: { "circuit-inspector": { type: "local", ...launch, enabled: true } }
    }, null, 2)}\n`);
    const before = await stat(configPath);

    await expect(configureOpenCodeMcp({
      launch,
      homeDirectory,
      platform: "darwin",
      environment: { PATH: "" }
    })).resolves.toBe("unchanged");
    const after = await stat(configPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("does not overwrite malformed OpenCode configuration", async () => {
    const homeDirectory = await temporaryHome();
    const configDirectory = path.join(homeDirectory, ".config", "opencode");
    const configPath = path.join(configDirectory, "opencode.jsonc");
    const malformed = "{ mcp: { broken: } }";
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, malformed);

    await expect(configureOpenCodeMcp({
      launch,
      homeDirectory,
      platform: "darwin",
      environment: { PATH: "" }
    })).rejects.toThrow();
    await expect(readFile(configPath, "utf8")).resolves.toBe(malformed);
  });

  it("resolves packaged and development MCP launch paths", () => {
    expect(circuitInspectorMcpLaunch({
      packaged: true,
      executablePath: "/App/CircuitInspector",
      resourcesPath: "/App/Resources",
      moduleDirectory: "/repo/apps/viewer/dist",
      platform: "darwin"
    })).toEqual({
      command: ["/App/CircuitInspector", "/App/Resources/app.asar/dist/mcp/index.js"],
      environment: {
        ELECTRON_RUN_AS_NODE: "1",
        CIRCUIT_INSPECTOR_CORE: "/App/Resources/bin/circuit-inspector-core",
        CIRCUIT_INSPECTOR_OCR_DIR: "/App/Resources/ocr",
        CIRCUIT_INSPECTOR_PDF_ASSET_DIR: "/App/Resources/pdfjs"
      }
    });

    expect(circuitInspectorMcpLaunch({
      packaged: false,
      executablePath: "/repo/node_modules/electron/Electron",
      resourcesPath: "/unused",
      moduleDirectory: "/repo/apps/viewer/dist",
      platform: "darwin"
    })).toEqual({
      command: ["/repo/node_modules/electron/Electron", "/repo/apps/mcp/dist/index.js"],
      cwd: "/repo",
      environment: { ELECTRON_RUN_AS_NODE: "1" }
    });
  });
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "circuit-inspector-opencode-"));
  temporaryDirectories.push(directory);
  return directory;
}
