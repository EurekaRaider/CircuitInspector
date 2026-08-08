export type CoverageLevel = "EXPLICIT" | "SUPPLEMENTED" | "INFERRED" | "MISSING";
export type Verdict = "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE";
export type DesignFormat = "ODBPP" | "GERBER_PACKAGE";

export interface SemanticCoverage {
  layers: CoverageLevel;
  nets: CoverageLevel;
  components: CoverageLevel;
  pins: CoverageLevel;
  test_points: CoverageLevel;
  drills: CoverageLevel;
}

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
  format: DesignFormat;
  source_path: string;
  content_hash: string;
  bounds: BoundsNm;
  layers: LayerSummary[];
  component_count: number;
  net_count: number;
  test_point_count: number;
  drill_count: number;
  semantic_coverage: SemanticCoverage;
  diagnostics: Diagnostic[];
  cache_hit: boolean;
  elapsed_ms: number;
}

export interface Diagnostic {
  code: string;
  severity: "INFO" | "WARNING" | "ERROR";
  message: string;
  source?: string;
}

export interface Violation {
  id: string;
  analysis_id: string;
  rule_id: string;
  title: string;
  severity: "INFO" | "WARNING" | "ERROR";
  verdict: Verdict;
  source_format: DesignFormat;
  semantic_confidence: CoverageLevel;
  net_names: string[];
  component_refs: string[];
  layer_ids: string[];
  x_nm: number;
  y_nm: number;
  measured_value_nm: number | null;
  threshold_nm: number | null;
  message: string;
  evidence_points: Array<{ x: number; y: number }>;
  evidence_uris: string[];
  rule_citation: RuleCitation | null;
}

export interface RuleCitation {
  source_path: string;
  source_hash: string;
  page: number | null;
  paragraph: number | null;
  excerpt: string;
}

export interface AnalysisSummary {
  id: string;
  design_id: string;
  rule_pack_id: string;
  verdict: Verdict;
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  violations: Violation[];
  report_uri: string;
  elapsed_ms: number;
}

export interface SchematicPin {
  connector: string;
  pin: string;
  net_name: string;
  confidence: "EXPLICIT" | "INFERRED";
}

export interface SchematicDesignMetric {
  id: string;
  value: string | number;
  unit: string | null;
  confidence: "EXPLICIT" | "INFERRED";
}

export interface SchematicPinout {
  id: string;
  role: "PRODUCT" | "WIB";
  source_path: string;
  source_hash: string;
  source_format: "JSON" | "CSV" | "TSV" | "TEXT" | "PDF";
  revision: string | null;
  status: "DRAFT" | "CONFIRMED";
  pins: SchematicPin[];
  design_metrics: SchematicDesignMetric[];
  confirmation: { confirmed_by: string; confirmed_at: string; content_hash: string } | null;
}

export interface ConnectorMapping {
  product_connector: string;
  wib_connector: string;
  pin_map?: Array<{ product_pin: string; wib_pin: string }>;
}

export interface WiringConnection {
  id: string;
  product_connector: string;
  product_pin: string;
  product_net: string | null;
  wib_connector: string;
  wib_pin: string;
  wib_net: string | null;
  verdict: Verdict;
  message: string;
}

export interface WiringAnalysis {
  kind: "WIRING_COMPARISON";
  id: string;
  product_pinout_id: string;
  wib_pinout_id: string;
  verdict: Verdict;
  verification_mode: "DOCUMENT_BACKED";
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  connections: WiringConnection[];
  violations: Array<Record<string, unknown>>;
  report_uri: string;
  report_path: string;
}

export interface ManufacturingTestPlan {
  kind: "MANUFACTURING_TEST_RECOMMENDATIONS";
  id: string;
  product_pinout_id: string;
  verdict: "REVIEW";
  verification_mode: "DOCUMENT_BACKED";
  recommendations: Array<Record<string, unknown>>;
  wib_design_recommendations: Array<Record<string, unknown>>;
  wib_constraints: Array<Record<string, unknown>>;
  report_uri: string;
  report_path: string;
}

export interface WibConstraintDefinition {
  id: string;
  area: string;
  requirement: string;
  check: "WIRING_ONE_TO_ONE" | "NET_IDENTITY" | "COMPLETE_PIN_COVERAGE" | "NO_UNINTENDED_INTERCONNECT" | "NC_ISOLATION" | "DESIGN_METRIC";
  metric_id: string | null;
  comparator: "EXACT" | "ALL" | "NONE" | "MAXIMUM" | "MINIMUM" | "RANGE";
  required_value: string | number | { min: number; max: number };
  unit: string | null;
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_FACTORY_CONFIRMATION";
  source_authority: string;
}

export interface WibConstraintSet {
  id: string;
  title: string;
  revision: string;
  status: "APPROVED";
  approved_by: string;
  approved_at: string;
  content_hash: string;
  constraints: WibConstraintDefinition[];
}

export interface WibQualification {
  kind: "WIB_DESIGN_QUALIFICATION";
  id: string;
  product_pinout_id: string;
  wib_pinout_id: string;
  constraint_set_id: string;
  verdict: Verdict;
  verification_mode: "DOCUMENT_BACKED";
  wiring_analysis_id: string;
  wiring_verdict: Verdict;
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  constraint_results: Array<Record<string, unknown>>;
  report_uri: string;
  report_path: string;
}

export interface TileDescriptor {
  path: string;
  feature_count: number;
  bounds: BoundsNm;
  lod: number;
}

export interface CoreRequest<T = unknown> {
  id: number;
  method: string;
  params: T;
}

export interface CoreResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: string; message: string; details?: unknown };
}
