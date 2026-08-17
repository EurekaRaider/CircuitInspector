export type CoverageLevel = "EXPLICIT" | "SUPPLEMENTED" | "INFERRED" | "MISSING";
export type Verdict = "PASS" | "FAIL" | "REVIEW" | "NOT_APPLICABLE";
export type DesignFormat = "ODBPP" | "GERBER_PACKAGE";
export type VerificationMode = "AUTOMATED_GEOMETRY" | "DOCUMENT_BACKED" | "MANUAL_FACTORY_CONFIRMATION";
export type TestPlanLifecycle = "DRAFT" | "APPROVED" | "SUPERSEDED";
export type ManufacturingTestMethod = "BARE_BOARD_ELECTRICAL" | "SPI" | "AOI" | "AXI" | "FLYING_PROBE" | "ICT" | "BOUNDARY_SCAN" | "PROGRAMMING" | "FCT";
export type TestMethodDisposition = "SELECTED" | "SUPPLEMENTAL" | "NOT_SELECTED";
export type TestAccessStrategy = "PHYSICAL_PROBE" | "CONNECTOR" | "BOUNDARY_SCAN" | "PROGRAMMING_INTERFACE" | "BIST" | "FCT" | "TO_BE_ASSIGNED";
export type TestStage = "BARE_BOARD" | "PRE_ASSEMBLY" | "POST_REFLOW" | "PRE_SHIELD_COATING" | "FINAL_ASSEMBLY";

export interface AnalysisStaleState {
  is_stale: true;
  reason: string;
  invalidated_at: string;
}

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
  entity_ids?: string[];
  x_nm: number;
  y_nm: number;
  measured_value_nm: number | null;
  threshold_nm: number | null;
  message: string;
  evidence_points: Array<{ x: number; y: number }>;
  evidence_uris: string[];
  rule_citation: RuleCitation | null;
  review?: ViolationReview;
}

export interface ViolationReview {
  kind: "SHIELD_COVERAGE_EXCLUSION" | "MANUAL_ADJUDICATION";
  resolution: ViolationReviewResolution | null;
}

export interface ViolationReviewResolution {
  decision: "IGNORE" | "PASS" | "FAIL";
  comment: string;
  reviewed_by: string;
  reviewed_at: string;
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
  resolution: RuleReviewResolution | null;
  citation: RuleCitation;
}

export type RuleReviewDecision = "ACCEPT_SUGGESTION" | "IGNORE" | "MODIFY_RULE";

export interface RuleReviewResolution {
  decision: RuleReviewDecision;
  note: string;
  rule_id: string | null;
}

export interface RuleDocumentDiagnostic {
  id: string;
  code: string;
  severity: "INFO" | "WARNING" | "ERROR";
  blocks_generation: boolean;
  blocks_approval: boolean;
  source_path: string;
  page: number | null;
  line: number | null;
  paragraph: number | null;
  section: string | null;
  rule_id: string | null;
  field: string | null;
  excerpt: string | null;
  message: string;
  suggestion: string;
  message_zh: string;
  suggestion_zh: string;
}

export interface RuleDocumentValidation {
  schema: "CIRCUITINSPECTOR_RULE_SOURCE_V1" | "LEGACY" | "MIXED";
  status: "VALID" | "REVIEW" | "INVALID";
  diagnostics: RuleDocumentDiagnostic[];
  error_count: number;
  warning_count: number;
  generation_blocker_count: number;
  approval_blocker_count: number;
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
  stale?: AnalysisStaleState;
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
  elapsed_ms: number;
  stale?: AnalysisStaleState;
}

export interface ControlledTestBaseline {
  product_revision: string | null;
  product_source_hash: string;
  variant: string | null;
  panel: string | null;
  factory: string | null;
  line: string | null;
  tester: string | null;
  approved_rule_pack_id: string | null;
}

export interface TestPlanApproval {
  approved_by: string;
  approved_at: string;
  content_hash: string;
  statement: string;
}

export interface TestMethodCoverage {
  method: ManufacturingTestMethod;
  disposition: TestMethodDisposition;
  status: "REVIEW";
  target_fault_classes: string[];
  prerequisites: string[];
  residual_gaps: string[];
  reason: string;
}

export interface ManufacturingTestRequirement {
  id: string;
  status: "REVIEW";
  verification_mode: "DOCUMENT_BACKED";
  category: string;
  priority: "HIGH" | "MEDIUM";
  title: string;
  fault_classes: string[];
  target_net_names: string[];
  target_pins: Array<{ connector: string; pin: string; net_name: string }>;
  target_functions: string[];
  methods: ManufacturingTestMethod[];
  test_stage: TestStage;
  access_strategy: TestAccessStrategy;
  physical_access_required: boolean;
  allowed_sides: Array<"TOP" | "BOTTOM">;
  stimulus: string;
  observation: string;
  limit_authority: string | null;
  owner: string;
  residual_risk: string;
  closure_evidence: string;
  source_evidence: Array<{ source_path: string; source_hash: string; page: number | null; excerpt: string }>;
}

export interface ManufacturingTestPlan {
  schema_version: 2;
  kind: "MANUFACTURING_TEST_RECOMMENDATIONS";
  id: string;
  product_pinout_id: string;
  product: SchematicPinout;
  lifecycle_status: TestPlanLifecycle;
  baseline: ControlledTestBaseline;
  approval: TestPlanApproval | null;
  verdict: "REVIEW";
  verification_mode: "DOCUMENT_BACKED";
  method_matrix: TestMethodCoverage[];
  requirements: ManufacturingTestRequirement[];
  recommendations: Array<Record<string, unknown>>;
  wib_design_recommendations: Array<Record<string, unknown>>;
  wib_constraints: Array<Record<string, unknown>>;
  recommendation_count: number;
  diagnostics: Diagnostic[];
  report_uri: string;
  report_path: string;
  elapsed_ms: number;
  stale?: AnalysisStaleState;
}

export interface TestAccessMapping {
  id: string;
  requirement_id: string;
  status: Verdict;
  verification_mode: VerificationMode;
  target_net_names: string[];
  target_functions: string[];
  access_strategy: TestAccessStrategy;
  physical_access_required: boolean;
  matched_test_points: Array<{
    id: string;
    net_name: string | null;
    component_ref: string | null;
    layer_id: string | null;
    side: "TOP" | "BOTTOM" | "INNER" | "NA";
    confidence: CoverageLevel;
    x_nm: number;
    y_nm: number;
  }>;
  geometry_violation_ids: string[];
  message: string;
  evidence: string[];
}

export interface LayoutBaselineConfirmation {
  schema_version: 1;
  id: string;
  status: "APPROVED";
  design_id: string;
  design_content_hash: string;
  test_plan_id: string;
  test_plan_content_hash: string;
  product_revision: string;
  variant: string | null;
  panel: string | null;
  source_units: "MM" | "INCH" | "MIXED";
  coordinate_origin: string;
  top_view_direction: "FROM_TOP";
  bottom_view_direction: "FROM_BOTTOM";
  bottom_mirrored_in_top_view: boolean;
  panel_step_repeat: string;
  approved_by: string;
  approved_at: string;
  content_hash: string;
}

export interface LayoutBaselineCheck {
  id: string;
  status: Verdict;
  verification_mode: "DOCUMENT_BACKED";
  requirement: string;
  recorded_value: string;
  message: string;
}

export interface LayoutTestAccessAnalysis {
  schema_version: 1;
  kind: "LAYOUT_TEST_ACCESS_ANALYSIS";
  id: string;
  design_id: string;
  design_content_hash: string;
  test_plan_id: string;
  test_plan_content_hash: string;
  rule_pack_id: string;
  rule_pack_content_hash: string;
  layout_baseline_confirmation_id: string | null;
  layout_baseline_content_hash: string | null;
  geometry_analysis_id: string;
  verdict: Verdict;
  production_readiness_verdict: "REVIEW";
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  baseline_checks: LayoutBaselineCheck[];
  mappings: TestAccessMapping[];
  factory_confirmation_items: Array<{
    id: string;
    status: "REVIEW";
    verification_mode: "MANUAL_FACTORY_CONFIRMATION";
    requirement: string;
    closure_evidence: string;
  }>;
  diagnostics: Diagnostic[];
  report_uri: string;
  report_path: string;
  elapsed_ms: number;
  stale?: AnalysisStaleState;
}

export interface WibInterfaceContract {
  schema_version: 1;
  id: string;
  title: string;
  revision: string;
  status: "APPROVED";
  product_pinout_id: string;
  wib_pinout_id: string;
  product_revision: string;
  wib_revision: string;
  connector_mappings: ConnectorMapping[];
  net_aliases: Array<{ product_net: string; wib_net: string }>;
  case_sensitive: boolean;
  approved_by: string;
  approved_at: string;
  content_hash: string;
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
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_FACTORY_CONFIRMATION";
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
  product_content_hash?: string;
  wib_content_hash?: string;
  interface_contract_content_hash?: string;
  test_plan_content_hash?: string;
  constraint_set_content_hash?: string;
  interface_contract_id?: string;
  test_plan_id?: string;
  verdict: Verdict;
  verification_mode: "DOCUMENT_BACKED";
  wiring_analysis_id: string;
  wiring_verdict: Verdict;
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  constraint_results: Array<Record<string, unknown>>;
  requirement_results?: Array<Record<string, unknown>>;
  production_readiness_verdict?: "REVIEW";
  factory_confirmation_items?: Array<Record<string, unknown>>;
  violations?: Array<Record<string, unknown>>;
  report_uri: string;
  report_path: string;
  elapsed_ms?: number;
  stale?: AnalysisStaleState;
}

export type DocumentAnalysis = WiringAnalysis | ManufacturingTestPlan | LayoutTestAccessAnalysis | WibQualification;
export type AnyAnalysis = AnalysisSummary | DocumentAnalysis;

export type ArtifactKind = "DESIGN" | "RULE_PACK" | "PINOUT" | "SCHEMATIC" | "CONSTRAINT_SET" | "INTERFACE_CONTRACT" | "LAYOUT_BASELINE" | "ANALYSIS" | "WORKFLOW_DRAFT";

export interface ArtifactSummary {
  id: string;
  kind: ArtifactKind;
  title: string;
  subtitle: string;
  status: string | null;
  verdict: Verdict | null;
  analysis_kind: "GEOMETRY" | "WIRING_COMPARISON" | "MANUFACTURING_TEST_RECOMMENDATIONS" | "LAYOUT_TEST_ACCESS_ANALYSIS" | "WIB_DESIGN_QUALIFICATION" | null;
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
  interface_contract_id?: string | null;
  test_plan_id?: string | null;
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
