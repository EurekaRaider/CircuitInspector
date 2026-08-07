import { contextBridge, ipcRenderer } from "electron";

const api = {
  platform: process.platform,
  chooseDesign: (locale: "zh-CN" | "en-US") => ipcRenderer.invoke("design:choose", locale) as Promise<string | null>,
  importDesign: (path: string) => ipcRenderer.invoke("design:import", path),
  getDesignSummary: (designId: string) => ipcRenderer.invoke("design:summary", designId),
  getTile: (input: Record<string, unknown>) => ipcRenderer.invoke("design:tile", input),
  searchDesign: (input: Record<string, unknown>) => ipcRenderer.invoke("design:search", input),
  pickDesign: (input: Record<string, unknown>) => ipcRenderer.invoke("design:pick", input),
  listRulePacks: () => ipcRenderer.invoke("rules:list"),
  approveRulePack: (rulePackId: string, approvedBy: string) => ipcRenderer.invoke("rules:approve", rulePackId, approvedBy),
  runAnalysis: (designId: string, rulePackId: string) => ipcRenderer.invoke("analysis:run", designId, rulePackId),
  readAnalysis: (analysisId: string) => ipcRenderer.invoke("analysis:read", analysisId),
  openEvidence: (filePath: string) => ipcRenderer.invoke("evidence:open", filePath),
  onProgress: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("core-progress", listener);
    return () => ipcRenderer.removeListener("core-progress", listener);
  },
  onDeepLink: (callback: (url: string) => void) => {
    const listener = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on("deep-link", listener);
    return () => ipcRenderer.removeListener("deep-link", listener);
  }
};

contextBridge.exposeInMainWorld("circuitInspector", api);
