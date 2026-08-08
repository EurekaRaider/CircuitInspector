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

export interface WiringConnection {
  id: string;
  product_connector: string;
  product_pin: string;
  product_net: string | null;
  wib_connector: string;
  wib_pin: string;
  wib_net: string | null;
  verdict: Violation["verdict"];
  message: string;
}

export interface WiringAnalysis {
  kind: "WIRING_COMPARISON";
  id: string;
  verdict: Violation["verdict"];
  verification_mode: "DOCUMENT_BACKED";
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  product: SchematicPinout;
  wib: SchematicPinout;
  connections: WiringConnection[];
  violations: Array<Violation & {
    product_connector: string | null;
    product_pin: string | null;
    product_net: string | null;
    wib_connector: string | null;
    wib_pin: string | null;
    wib_net: string | null;
  }>;
  report_uri: string;
  report_path: string;
}

export interface SchematicPinout {
  id: string;
  role: "PRODUCT" | "WIB";
  source_path: string;
  source_hash: string;
  revision: string | null;
  status: "DRAFT" | "CONFIRMED";
  pins: Array<{ connector: string; pin: string; net_name: string }>;
  design_metrics: Array<{ id: string; value: string | number; unit: string | null }>;
}

export interface TestRecommendation {
  id: string;
  status: "REVIEW";
  category: string;
  priority: "HIGH" | "MEDIUM";
  title: string;
  net_names: string[];
  rationale: string;
  suggested_test: string;
  stimulus: string;
  observation: string;
  missing_inputs: string[];
  closure_evidence: string;
}

export interface WibDesignRecommendation {
  id: string;
  status: "REVIEW";
  category: string;
  priority: "HIGH" | "MEDIUM";
  title: string;
  related_net_names: string[];
  recommendation: string;
  rationale: string;
  validation_needed: string;
}

export interface WibConstraint {
  id: string;
  status: "REVIEW";
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_FACTORY_CONFIRMATION";
  area: string;
  requirement: string;
  metric: string;
  comparator: string;
  required_value: string | number | null;
  unit: string | null;
  owner: string;
}

export interface TestRecommendationAnalysis {
  kind: "MANUFACTURING_TEST_RECOMMENDATIONS";
  id: string;
  verdict: "REVIEW";
  verification_mode: "DOCUMENT_BACKED";
  product: SchematicPinout;
  recommendation_count: number;
  recommendations: TestRecommendation[];
  wib_design_recommendations: WibDesignRecommendation[];
  wib_constraints: WibConstraint[];
  diagnostics: Array<{ code: string; severity: string; message: string }>;
  report_uri: string;
  report_path: string;
}

export interface WibConstraintResult {
  id: string;
  constraint_id: string;
  status: Violation["verdict"];
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_FACTORY_CONFIRMATION";
  area: string;
  requirement: string;
  comparator: string;
  required_value: string | number | { min: number; max: number };
  actual_value: string | number | null;
  unit: string | null;
  message: string;
}

export interface WibQualificationAnalysis {
  kind: "WIB_DESIGN_QUALIFICATION";
  id: string;
  verdict: Violation["verdict"];
  verification_mode: "DOCUMENT_BACKED";
  product_pinout_id: string;
  wib_pinout_id: string;
  constraint_set_id: string;
  wiring_analysis_id: string;
  wiring_verdict: Violation["verdict"];
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  constraint_results: WibConstraintResult[];
  violations: Array<WibConstraintResult & { rule_id: string; title: string; severity: "ERROR" | "WARNING" }>;
  report_uri: string;
  report_path: string;
}

export type DocumentAnalysis = WiringAnalysis | TestRecommendationAnalysis | WibQualificationAnalysis;
export type AnyAnalysis = AnalysisSummary | DocumentAnalysis;

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
  readAnalysis(analysisId: string): Promise<AnyAnalysis>;
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
