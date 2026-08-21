import { contextBridge, ipcRenderer } from "electron";

const api = {
  platform: process.platform,
  chooseDesign: (locale: "zh-CN" | "en-US") => ipcRenderer.invoke("design:choose", locale) as Promise<string | null>,
  chooseBrd: (locale: "zh-CN" | "en-US") => ipcRenderer.invoke("brd:choose", locale),
  detectKiCad: () => ipcRenderer.invoke("brd:detect-kicad"),
  chooseTpReview: (locale: "zh-CN" | "en-US") => ipcRenderer.invoke("brd:choose-review", locale),
  importBrdTestPoints: (input: Record<string, unknown>) => ipcRenderer.invoke("brd:import-test-points", input),
  readBrdTestPointCatalog: (catalogId: string) => ipcRenderer.invoke("brd:read-catalog", catalogId),
  queryBrdTestPoints: (input: Record<string, unknown>) => ipcRenderer.invoke("brd:query-test-points", input),
  exportTpReview: (catalogId: string, locale: "zh-CN" | "en-US") => ipcRenderer.invoke("brd:export-review", catalogId, locale),
  importTpReview: (input: Record<string, unknown>) => ipcRenderer.invoke("brd:import-review", input),
  readTpSelection: (selectionId: string) => ipcRenderer.invoke("brd:read-selection", selectionId),
  approveTpSelection: (input: Record<string, unknown>) => ipcRenderer.invoke("brd:approve-selection", input),
  proposeTpAlignment: (input: Record<string, unknown>) => ipcRenderer.invoke("brd:propose-alignment", input),
  readTpAlignment: (alignmentId: string) => ipcRenderer.invoke("brd:read-alignment", alignmentId),
  approveTpAlignment: (input: Record<string, unknown>) => ipcRenderer.invoke("brd:approve-alignment", input),
  analyzeSelectedTestPoints: (input: Record<string, unknown>) => ipcRenderer.invoke("brd:analyze-selected", input),
  importDesign: (path: string) => ipcRenderer.invoke("design:import", path),
  getDesignSummary: (designId: string) => ipcRenderer.invoke("design:summary", designId),
  getTile: (input: Record<string, unknown>) => ipcRenderer.invoke("design:tile", input),
  searchDesign: (input: Record<string, unknown>) => ipcRenderer.invoke("design:search", input),
  pickDesign: (input: Record<string, unknown>) => ipcRenderer.invoke("design:pick", input),
  listTestPoints: (designId: string) => ipcRenderer.invoke("design:test-points", designId),
  reviewTestPoints: (input: Record<string, unknown>) => ipcRenderer.invoke("design:review-test-points", input),
  listRulePacks: () => ipcRenderer.invoke("rules:list"),
  updateRulePack: (input: Record<string, unknown>) => ipcRenderer.invoke("rules:update-draft", input),
  deleteRulePack: (rulePackId: string) => ipcRenderer.invoke("rules:delete", rulePackId),
  approveRulePack: (rulePackId: string, approvedBy: string) => ipcRenderer.invoke("rules:approve", rulePackId, approvedBy),
  runAnalysis: (designId: string, rulePackId: string) => ipcRenderer.invoke("analysis:run", designId, rulePackId),
  analyzeTestAccess: (input: Record<string, unknown>) => ipcRenderer.invoke("analysis:test-access", input),
  queryViolations: (input: Record<string, unknown>) => ipcRenderer.invoke("analysis:query", input),
  reviewViolation: (input: Record<string, unknown>) => ipcRenderer.invoke("analysis:review-violation", input),
  renderEvidence: (input: Record<string, unknown>) => ipcRenderer.invoke("evidence:render", input),
  readAnalysis: (analysisId: string) => ipcRenderer.invoke("analysis:read", analysisId),
  openEvidence: (filePath: string) => ipcRenderer.invoke("evidence:open", filePath),
  chooseWorkbenchInput: (kind: "RULE_DOCUMENT" | "SCHEMATIC" | "TABLE", multiple: boolean, locale: "zh-CN" | "en-US") => ipcRenderer.invoke("workbench:choose-input", kind, multiple, locale),
  listArtifacts: () => ipcRenderer.invoke("workbench:artifacts"),
  deleteArtifact: (kind: string, id: string) => ipcRenderer.invoke("workbench:delete-artifact", kind, id),
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
  readTestPlan: (id: string) => ipcRenderer.invoke("workbench:read-test-plan", id),
  updateTestPlan: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:update-test-plan", input),
  approveTestPlan: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:approve-test-plan", input),
  confirmLayoutBaseline: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:confirm-layout-baseline", input),
  readLayoutBaseline: (designId: string) => ipcRenderer.invoke("workbench:read-layout-baseline", designId),
  createConstraintSet: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:create-constraint-set", input),
  readConstraintSet: (id: string) => ipcRenderer.invoke("workbench:read-constraint-set", id),
  createInterfaceContract: (input: Record<string, unknown>) => ipcRenderer.invoke("workbench:create-interface-contract", input),
  readInterfaceContract: (id: string) => ipcRenderer.invoke("workbench:read-interface-contract", id),
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
  onRuleCatalogChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("rule-catalog-changed", listener);
    return () => ipcRenderer.removeListener("rule-catalog-changed", listener);
  },
  onDeepLink: (callback: (url: string) => void) => {
    const listener = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on("deep-link", listener);
    return () => ipcRenderer.removeListener("deep-link", listener);
  }
};

contextBridge.exposeInMainWorld("circuitInspector", api);
