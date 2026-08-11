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

export interface RuleReviewItem {
  id: string;
  code: "RELATIVE_THRESHOLD" | "AMBIGUOUS_THRESHOLD" | "NON_EXECUTABLE_GUIDANCE" | "UNSUPPORTED_TARGET" | "LEGACY_AUTO_SEVERITY";
  message: string;
  acknowledged: boolean;
  citation: RuleCitation;
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
  report_path?: string;
}

export interface RuleDefinition {
  id: string;
  title: string;
  kind: "MINIMUM_DISTANCE" | "MINIMUM_WIDTH" | "MINIMUM_ANNULAR_RING" | "MINIMUM_DIAMETER";
  source: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL" | "TOOLING_HOLE" | "PANEL_TAB" | "BGA_CSP" | "SHIELD_FENCE" | "UV_GLUE";
  target: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL" | "TOOLING_HOLE" | "PANEL_TAB" | "BGA_CSP" | "SHIELD_FENCE" | "UV_GLUE" | null;
  metric: "CENTER_TO_CENTER" | "EDGE_TO_EDGE" | "BODY_TO_PAD" | null;
  threshold_nm: number;
  severity: "INFO" | "WARNING" | "ERROR" | null;
  layer_functions: string[];
  same_net_only: boolean;
  different_net_only: boolean;
  citation: RuleCitation;
}

export interface RulePack {
  id: string;
  version: string;
  title: string;
  status: "DRAFT" | "APPROVED" | "DEPRECATED";
  rules: RuleDefinition[];
  review_items: RuleReviewItem[];
  approval: { approved_by: string; approved_at: string; content_hash: string } | null;
}

export interface SchematicPin {
  connector: string;
  pin: string;
  net_name: string;
  confidence: "EXPLICIT" | "INFERRED";
  evidence?: {
    source_path: string;
    source_hash: string;
    page: number | null;
    line: number | null;
    excerpt: string;
  };
}

export interface SchematicDesignMetric {
  id: string;
  value: string | number;
  unit: string | null;
  confidence: "EXPLICIT" | "INFERRED";
}

export interface SchematicPinout {
  schema_version: 1;
  id: string;
  role: "PRODUCT" | "WIB";
  source_path: string;
  source_hash: string;
  source_format: "JSON" | "CSV" | "TSV" | "TEXT" | "PDF";
  revision: string | null;
  status: "DRAFT" | "CONFIRMED";
  pins: SchematicPin[];
  design_metrics: SchematicDesignMetric[];
  diagnostics: Diagnostic[];
  confirmation: { confirmed_by: string; confirmed_at: string; content_hash: string } | null;
}

export type SchematicExtractionMethod = "STRUCTURED" | "PDF_TEXT" | "PDF_VECTOR" | "OCR" | "USER";
export type SchematicComponentKind = "CONNECTOR" | "IC" | "PASSIVE" | "PROTECTION" | "POWER" | "UNKNOWN";

export interface SchematicBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SchematicEvidence {
  source_path: string;
  source_hash: string;
  page: number | null;
  bbox: SchematicBox | null;
  excerpt: string;
  method: SchematicExtractionMethod;
  confidence: number;
}

export interface SchematicPage {
  number: number;
  width: number;
  height: number;
  render_path: string;
  thumbnail_path: string;
  extraction: "VECTOR_TEXT" | "OCR";
}

export interface SchematicComponent {
  id: string;
  refdes: string;
  value: string | null;
  kind: SchematicComponentKind;
  page: number | null;
  bbox: SchematicBox | null;
  pin_ids: string[];
  passthrough_pin_pairs: Array<[string, string]>;
  evidence: SchematicEvidence[];
}

export interface SchematicGraphPin {
  id: string;
  component_id: string;
  number: string;
  name: string | null;
  net_id: string | null;
  page: number | null;
  x: number | null;
  y: number | null;
  evidence: SchematicEvidence[];
}

export interface SchematicNet {
  id: string;
  name: string | null;
  pin_ids: string[];
  wire_ids: string[];
  label_ids: string[];
  page_numbers: number[];
  confidence: number;
  evidence: SchematicEvidence[];
}

export interface SchematicWire {
  id: string;
  page: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  net_id: string | null;
  evidence: SchematicEvidence;
}

export interface SchematicJunction {
  id: string;
  page: number;
  x: number;
  y: number;
  connected_wire_ids: string[];
  evidence: SchematicEvidence;
}

export interface SchematicLabel {
  id: string;
  page: number;
  text: string;
  kind: "NET" | "OFF_PAGE" | "HIERARCHICAL";
  x: number;
  y: number;
  net_id: string | null;
  evidence: SchematicEvidence;
}

export interface SchematicGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "WIRE" | "NET_LABEL" | "OFF_PAGE" | "PASSTHROUGH" | "USER";
  evidence: SchematicEvidence[];
}

export interface SchematicInterfaceCandidate {
  id: string;
  component_id: string;
  score: number;
  reasons: string[];
  confirmed: boolean;
}

export interface SchematicPath {
  id: string;
  anchor_pin_id: string;
  node_ids: string[];
  edge_ids: string[];
  component_ids: string[];
  endpoint_pin_ids: string[];
  status: "RESOLVED" | "REVIEW";
  confidence: number;
  diagnostics: Diagnostic[];
  evidence: SchematicEvidence[];
}

export interface SchematicCorrection {
  id: string;
  operation: "UPDATE" | "ADD" | "DELETE" | "MERGE_NETS" | "SPLIT_NET" | "SET_JUNCTION" | "SET_OFF_PAGE" | "SET_PASSTHROUGH";
  entity_kind: "COMPONENT" | "PIN" | "NET" | "WIRE" | "JUNCTION" | "LABEL";
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  corrected_by: string;
  corrected_at: string;
  content_hash: string;
}

export interface SchematicConfirmedScope {
  id: string;
  anchor_candidate_id: string;
  path_ids: string[];
  confirmed_by: string;
  confirmed_at: string;
  content_hash: string;
}

export interface SchematicDocument {
  schema_version: 2;
  parser_version: string;
  id: string;
  role: "PRODUCT" | "WIB";
  source_path: string;
  source_hash: string;
  source_format: "JSON" | "CSV" | "TSV" | "TEXT" | "PDF";
  source_page_count: number | null;
  revision: string | null;
  status: "DRAFT" | "PARTIALLY_CONFIRMED" | "CONFIRMED";
  pages: SchematicPage[];
  components: SchematicComponent[];
  graph_pins: SchematicGraphPin[];
  nets: SchematicNet[];
  wires: SchematicWire[];
  junctions: SchematicJunction[];
  labels: SchematicLabel[];
  edges: SchematicGraphEdge[];
  interface_candidates: SchematicInterfaceCandidate[];
  paths: SchematicPath[];
  corrections: SchematicCorrection[];
  confirmed_scopes: SchematicConfirmedScope[];
  pins: SchematicPin[];
  design_metrics: SchematicDesignMetric[];
  diagnostics: Diagnostic[];
  confirmation: { confirmed_by: string; confirmed_at: string; content_hash: string } | null;
}

export type SchematicArtifact = SchematicPinout | SchematicDocument;

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
  product_endpoint_refs?: string[];
  wib_endpoint_refs?: string[];
  product_path_component_refs?: string[];
  wib_path_component_refs?: string[];
  product_path_component_kinds?: SchematicComponentKind[];
  wib_path_component_kinds?: SchematicComponentKind[];
  product_path_id?: string | null;
  wib_path_id?: string | null;
  verdict: Verdict;
  message: string;
}

export interface WiringAnalysis {
  schema_version: 1;
  kind: "WIRING_COMPARISON";
  id: string;
  product_pinout_id: string;
  wib_pinout_id: string;
  product: SchematicPinout;
  wib: SchematicPinout;
  connector_mappings: ConnectorMapping[];
  net_aliases: Array<{ product_net: string; wib_net: string }>;
  case_sensitive?: boolean;
  verdict: Verdict;
  verification_mode: "DOCUMENT_BACKED";
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  connections: WiringConnection[];
  net_name_review: Array<{
    net_name: string;
    product_locations: string[];
    wib_locations: string[];
    product_count: number;
    wib_count: number;
    status: "MATCH_CANDIDATE" | "COUNT_MISMATCH" | "PRODUCT_ONLY" | "WIB_ONLY";
    message: string;
  }>;
  violations: Array<Record<string, unknown>>;
  diagnostics: Diagnostic[];
  report_uri: string;
  report_path: string;
}

export interface ManufacturingTestPlan {
  schema_version: 1;
  kind: "MANUFACTURING_TEST_RECOMMENDATIONS";
  id: string;
  product_pinout_id: string;
  product: SchematicPinout;
  verdict: "REVIEW";
  verification_mode: "DOCUMENT_BACKED";
  recommendations: Array<Record<string, unknown>>;
  wib_design_recommendations: Array<Record<string, unknown>>;
  wib_constraints: Array<Record<string, unknown>>;
  recommendation_count: number;
  diagnostics: Diagnostic[];
  report_uri: string;
  report_path: string;
}

export interface WibConstraintDefinition {
  id: string;
  area: string;
  requirement: string;
  check: "WIRING_ONE_TO_ONE" | "NET_IDENTITY" | "COMPLETE_PIN_COVERAGE" | "NO_UNINTENDED_INTERCONNECT" | "NC_ISOLATION" | "DESIGN_METRIC" | "ENDPOINT_UNIQUENESS" | "NO_UNRESOLVED_BRANCH" | "PATH_COMPONENT_POLICY" | "ENDPOINT_PIN_MATCH";
  metric_id: string | null;
  comparator: "EXACT" | "ALL" | "NONE" | "MAXIMUM" | "MINIMUM" | "RANGE";
  required_value: string | number | { min: number; max: number };
  unit: string | null;
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_IMPLEMENTATION_CONFIRMATION" | "MANUAL_FACTORY_CONFIRMATION";
  source_authority: string;
  scope?: { connector?: string; pin?: string; net_name?: string };
  allowed_component_kinds?: SchematicComponentKind[] | undefined;
  forbidden_component_refs?: string[];
  expected_endpoint_refs?: string[];
}

export interface WibConstraintSet {
  schema_version: 1;
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
  schema_version: 1;
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

export type DocumentAnalysis = WiringAnalysis | ManufacturingTestPlan | WibQualification;
export type AnyAnalysis = AnalysisSummary | DocumentAnalysis;

export type ArtifactKind = "DESIGN" | "RULE_PACK" | "PINOUT" | "SCHEMATIC" | "CONSTRAINT_SET" | "ANALYSIS" | "WORKFLOW_DRAFT";

export interface ArtifactSummary {
  id: string;
  kind: ArtifactKind;
  title: string;
  subtitle: string;
  status: string | null;
  verdict: Verdict | null;
  analysis_kind: "GEOMETRY" | "WIRING_COMPARISON" | "MANUFACTURING_TEST_RECOMMENDATIONS" | "WIB_DESIGN_QUALIFICATION" | null;
  source_path: string | null;
  updated_at: string;
}

export interface ArtifactCatalog {
  artifacts: ArtifactSummary[];
  diagnostics: Diagnostic[];
}

export interface WibWorkflowDraft {
  schema_version: 1;
  id: string;
  title: string;
  step: 1 | 2 | 3 | 4 | 5 | 6;
  product_pinout_id: string | null;
  wib_pinout_id: string | null;
  product_schematic_id?: string | null;
  wib_schematic_id?: string | null;
  product_interface_candidate_id?: string | null;
  wib_interface_candidate_id?: string | null;
  product_edits?: WibDraftPinoutEdits;
  wib_edits?: WibDraftPinoutEdits;
  connector_mappings: ConnectorMapping[];
  net_aliases: Array<{ product_net: string; wib_net: string }>;
  case_sensitive?: boolean;
  constraint_set_id: string | null;
  constraint_title?: string;
  constraint_revision?: string;
  constraint_rows: Array<Partial<WibConstraintDefinition> & { id: string }>;
  updated_at: string;
}

export interface WibDraftPinoutEdits {
  pins: Array<{ connector: string; pin: string; net_name: string }>;
  design_metrics: Array<{ id: string; value: string | number; unit: string | null }>;
  revision: string;
}

export type TableKind = "PINOUT" | "DESIGN_METRIC" | "CONNECTOR_MAPPING" | "NET_ALIAS" | "CONSTRAINT";
export type TableFormat = "CSV" | "JSON";

export interface TableRowError {
  row: number;
  field: string | null;
  message: string;
}

export interface TableImportResult {
  schema_version: 1;
  kind: TableKind;
  rows: Array<Record<string, unknown>>;
  errors: TableRowError[];
}

export interface WorkflowProgressEvent {
  phase: string;
  progress: number;
  message: string;
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
