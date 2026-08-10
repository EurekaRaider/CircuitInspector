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
  updateRulePack: (input: Record<string, unknown>) => ipcRenderer.invoke("rules:update-draft", input),
  deleteRulePack: (rulePackId: string) => ipcRenderer.invoke("rules:delete", rulePackId),
  approveRulePack: (rulePackId: string, approvedBy: string) => ipcRenderer.invoke("rules:approve", rulePackId, approvedBy),
  runAnalysis: (designId: string, rulePackId: string) => ipcRenderer.invoke("analysis:run", designId, rulePackId),
  queryViolations: (input: Record<string, unknown>) => ipcRenderer.invoke("analysis:query", input),
  renderEvidence: (input: Record<string, unknown>) => ipcRenderer.invoke("evidence:render", input),
  readAnalysis: (analysisId: string) => ipcRenderer.invoke("analysis:read", analysisId),
  openEvidence: (filePath: string) => ipcRenderer.invoke("evidence:open", filePath),
  chooseWorkbenchInput: (kind: "RULE_DOCUMENT" | "SCHEMATIC" | "TABLE", multiple: boolean, locale: "zh-CN" | "en-US") => ipcRenderer.invoke("workbench:choose-input", kind, multiple, locale),
  listArtifacts: () => ipcRenderer.invoke("workbench:artifacts"),
  extractRulePack: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:extract-rules", input),
  importSchematic: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:import-schematic", input),
  readSchematic: (id: string) => ipcRenderer.invoke("workbench:read-schematic", id),
  traceSchematic: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:trace-schematic", input),
  correctSchematic: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:correct-schematic", input),
  confirmSchematicPaths: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:confirm-schematic-paths", input),
  getSchematicPage: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:schematic-page", input),
  getSchematicThumbnail: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:schematic-thumbnail", input),
  readPinout: (id: string) => ipcRenderer.invoke("workbench:read-pinout", id),
  confirmPinout: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:confirm-pinout", input),
  compareWiring: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:compare-wiring", input),
  recommendTests: (productPinoutId: string) => ipcRenderer.invoke("workbench:recommend-tests", productPinoutId),
  createConstraintSet: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:create-constraint-set", input),
  readConstraintSet: (id: string) => ipcRenderer.invoke("workbench:read-constraint-set", id),
  qualifyWib: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:qualify-wib", input),
  saveWibDraft: (draft: Record<string, unknown>) => ipcRenderer.invoke("workbench:save-draft", draft),
  readWibDraft: (id: string) => ipcRenderer.invoke("workbench:read-draft", id),
  importTable: (kind: string, filePath: string) => ipcRenderer.invoke("workbench:import-table", kind, filePath),
  parseTableText: (kind: string, text: string) => ipcRenderer.invoke("workbench:parse-table-text", kind, text),
  exportTable: (kind: string, rows: Array<Record<string, unknown>>, format: string, locale: "zh-CN" | "en-US") => ipcRenderer.invoke("workbench:export-table", kind, rows, format, locale),
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
