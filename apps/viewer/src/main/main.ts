import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreClient } from "./core-client.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.resolve(directory, "../assets/icon.png");
const cacheDir = path.resolve(
  process.env.CIRCUIT_INSPECTOR_CACHE_DIR ?? path.join(os.homedir(), ".circuit-inspector", "cache")
);
const core = new CoreClient();
let window: BrowserWindow | undefined;
let pendingDeepLink = process.argv.find((argument) => argument.startsWith("circuitinspector://"));

app.setName("CircuitInspector");
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient("circuitinspector", process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("circuitinspector");
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();

app.on("second-instance", (_event, argv) => {
  pendingDeepLink = argv.find((argument) => argument.startsWith("circuitinspector://"));
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
  if (pendingDeepLink) window.webContents.send("deep-link", pendingDeepLink);
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  pendingDeepLink = url;
  window?.webContents.send("deep-link", url);
});

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => core.close());

function createWindow() {
  window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#121416",
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: false,
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("file://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.once("ready-to-show", () => {
    window?.show();
    if (pendingDeepLink) window?.webContents.send("deep-link", pendingDeepLink);
  });
  window.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) window?.webContents.send("deep-link", pendingDeepLink);
    const screenshot = process.env.CIRCUIT_INSPECTOR_SMOKE_SCREENSHOT;
    if (!screenshot) return;
    setTimeout(async () => {
      const image = await window?.webContents.capturePage();
      if (image) await writeFile(path.resolve(screenshot), image.toPNG());
      app.quit();
    }, 1500);
  });
  const devUrl = process.env.CIRCUIT_INSPECTOR_VIEWER_DEV_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(path.join(directory, "renderer/index.html"));
}

ipcMain.handle("design:choose", async (_event, locale: "zh-CN" | "en-US") => {
  const chinese = locale === "zh-CN";
  const result = await dialog.showOpenDialog(window!, {
    title: chinese ? "选择 ODB++ 或 Gerber 制造数据" : "Choose ODB++ or Gerber manufacturing data",
    properties: ["openFile", "openDirectory"],
    filters: [
      { name: chinese ? "PCB 制造数据" : "PCB manufacturing data", extensions: ["zip", "tgz", "gz", "gbr", "ger", "gtl", "gbl"] },
      { name: chinese ? "所有文件" : "All files", extensions: ["*"] }
    ]
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("design:import", async (_event, sourcePath: string) => {
  window?.webContents.send("core-progress", { phase: "IMPORT", progress: 0, message: "正在校验并解析制造数据" });
  const summary = await core.request("import_design", { path: path.resolve(sourcePath), cache_dir: cacheDir });
  window?.webContents.send("core-progress", { phase: "IMPORT", progress: 100, message: "设计已建立索引" });
  return summary;
});

ipcMain.handle("design:summary", (_event, designId: string) =>
  core.request("get_design_summary", { design_id: designId, cache_dir: cacheDir })
);

ipcMain.handle("design:tile", async (_event, input: Record<string, unknown>) => {
  const descriptor = await core.request<{ path: string; feature_count: number; bounds: unknown; lod: number }>("get_tile", {
    ...input,
    cache_dir: cacheDir
  });
  const bytes = await readFile(descriptor.path);
  return {
    ...descriptor,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
});

ipcMain.handle("design:search", (_event, input: Record<string, unknown>) =>
  core.request("search_design", { ...input, cache_dir: cacheDir })
);
ipcMain.handle("design:pick", (_event, input: Record<string, unknown>) =>
  core.request("pick_design", { ...input, cache_dir: cacheDir })
);

ipcMain.handle("rules:list", () => core.request("list_rule_packs", { cache_dir: cacheDir }));
ipcMain.handle("rules:approve", (_event, rulePackId: string, approvedBy: string) =>
  core.request("approve_rule_pack", { cache_dir: cacheDir, rule_pack_id: rulePackId, approved_by: approvedBy })
);
ipcMain.handle("analysis:run", (_event, designId: string, rulePackId: string) =>
  core.request("analyze_design", { cache_dir: cacheDir, design_id: designId, rule_pack_id: rulePackId })
);
ipcMain.handle("analysis:read", async (_event, analysisId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(analysisId)) throw new Error("Invalid analysis identifier");
  const localAnalysis = path.join(cacheDir, "evidence", analysisId, "analysis.json");
  try {
    const parsed = JSON.parse(await readFile(localAnalysis, "utf8")) as { kind?: string };
    if (["WIRING_COMPARISON", "MANUFACTURING_TEST_RECOMMENDATIONS", "WIB_DESIGN_QUALIFICATION"].includes(parsed.kind ?? "")) return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  return core.request("read_analysis", { cache_dir: cacheDir, analysis_id: analysisId });
});
ipcMain.handle("evidence:open", async (_event, filePath: string) => {
  const evidenceRoot = path.resolve(cacheDir, "evidence");
  const resolved = path.resolve(filePath);
  const relative = path.relative(evidenceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("只能打开 CircuitInspector 本地证据目录中的文件");
  }
  const result = await shell.openPath(resolved);
  return { ok: result.length === 0, error: result || null };
});
