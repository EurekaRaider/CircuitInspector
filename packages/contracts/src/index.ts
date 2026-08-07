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
