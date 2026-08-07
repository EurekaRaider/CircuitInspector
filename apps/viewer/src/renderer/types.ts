export type CoverageLevel = "EXPLICIT" | "SUPPLEMENTED" | "INFERRED" | "MISSING";

export interface BoundsNm {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export interface LayerSummary {
  id: string;
  name: string;
  function: string;
  side: "TOP" | "BOTTOM" | "INNER" | "NA";
  feature_count: number;
}

export interface DesignSummary {
  id: string;
  format: "ODBPP" | "GERBER_PACKAGE";
  source_path: string;
  bounds: BoundsNm;
  layers: LayerSummary[];
  component_count: number;
  net_count: number;
  test_point_count: number;
  drill_count: number;
  semantic_coverage: Record<string, CoverageLevel>;
  diagnostics: Array<{ code: string; severity: string; message: string }>;
  cache_hit: boolean;
  elapsed_ms: number;
}

export interface RulePack {
  id: string;
  version: string;
  title: string;
  status: "DRAFT" | "APPROVED" | "DEPRECATED";
  rules: Array<{ id: string; title: string; threshold_nm: number; citation?: { excerpt: string } }>;
  approval: { approved_by: string; approved_at: string; content_hash: string } | null;
}

export interface Violation {
  id: string;
  rule_id: string;
  title: string;
  verdict: "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE";
  severity: "INFO" | "WARNING" | "ERROR";
  net_names: string[];
  component_refs: string[];
  layer_ids: string[];
  x_nm: number;
  y_nm: number;
  measured_value_nm?: number;
  threshold_nm?: number;
  message: string;
  evidence_points?: Array<{ x: number; y: number }>;
}

export interface AnalysisSummary {
  id: string;
  design_id: string;
  rule_pack_id: string;
  verdict: Violation["verdict"];
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  violations: Violation[];
  report_uri: string;
  report_path?: string;
  elapsed_ms: number;
}

export interface TilePayload {
  path: string;
  feature_count: number;
  bounds: BoundsNm;
  lod: number;
  bytes: ArrayBuffer;
}

export interface ViewerApi {
  platform: NodeJS.Platform;
  chooseDesign(locale: "zh-CN" | "en-US"): Promise<string | null>;
  importDesign(path: string): Promise<DesignSummary>;
  getDesignSummary(designId: string): Promise<DesignSummary>;
  getTile(input: Record<string, unknown>): Promise<TilePayload>;
  searchDesign(input: Record<string, unknown>): Promise<{ results: SearchResult[] }>;
  pickDesign(input: Record<string, unknown>): Promise<{ results: PickResult[] }>;
  listRulePacks(): Promise<{ rule_packs: RulePack[] }>;
  approveRulePack(rulePackId: string, approvedBy: string): Promise<RulePack>;
  runAnalysis(designId: string, rulePackId: string): Promise<AnalysisSummary>;
  readAnalysis(analysisId: string): Promise<AnalysisSummary>;
  openEvidence(filePath: string): Promise<{ ok: boolean; error: string | null }>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
  onDeepLink(callback: (url: string) => void): () => void;
}

export interface SearchResult {
  kind: "COMPONENT" | "NET";
  id: string;
  label: string;
  xNm?: number;
  yNm?: number;
  bounds?: BoundsNm;
}

export interface PickResult {
  kind: "COMPONENT" | "TEST_POINT" | "FEATURE";
  id: string;
  label: string;
  layer_id: string | null;
  net_name: string | null;
  component_ref: string | null;
  distance_nm: number;
}

export interface ProgressEvent {
  phase: string;
  progress: number;
  message: string;
}

declare global {
  interface Window {
    circuitInspector: ViewerApi;
  }
}
