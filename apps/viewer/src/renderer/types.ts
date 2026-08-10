import type {
  ArtifactCatalog,
  ConnectorMapping,
  SchematicComponent,
  SchematicDocument,
  SchematicGraphPin,
  SchematicJunction,
  SchematicLabel,
  SchematicWire,
  TableFormat,
  TableImportResult,
  TableKind,
  WibConstraintDefinition,
  WibConstraintSet,
  WibWorkflowDraft
} from "@circuit-inspector/contracts";

export type { ArtifactCatalog, ConnectorMapping, SchematicDocument, TableFormat, TableImportResult, TableKind, WibConstraintDefinition, WibConstraintSet, WibWorkflowDraft };

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
  rules: RuleDefinition[];
  review_items: Array<{
    id: string;
    code: "RELATIVE_THRESHOLD" | "AMBIGUOUS_THRESHOLD" | "NON_EXECUTABLE_GUIDANCE" | "UNSUPPORTED_TARGET" | "LEGACY_AUTO_SEVERITY";
    message: string;
    acknowledged: boolean;
    citation: RuleCitation;
  }>;
  approval: { approved_by: string; approved_at: string; content_hash: string } | null;
}

export interface RuleDefinition {
    id: string;
    title: string;
    kind: "MINIMUM_DISTANCE" | "MINIMUM_WIDTH" | "MINIMUM_ANNULAR_RING";
    source: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL";
    target: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL" | null;
    metric: "CENTER_TO_CENTER" | "EDGE_TO_EDGE" | "BODY_TO_PAD" | null;
    threshold_nm: number;
    severity: "INFO" | "WARNING" | "ERROR" | null;
    layer_functions: string[];
    same_net_only: boolean;
    different_net_only: boolean;
    citation: RuleCitation;
}

export interface RuleCitation {
  source_path: string;
  source_hash: string;
  page: number | null;
  paragraph: number | null;
  excerpt: string;
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
  product_endpoint_refs?: string[];
  wib_endpoint_refs?: string[];
  product_path_id?: string | null;
  wib_path_id?: string | null;
  verdict: Violation["verdict"];
  message: string;
}

export interface SchematicPagePayload {
  page: SchematicDocument["pages"][number];
  bytes: ArrayBuffer;
  thumbnailBytes: ArrayBuffer;
  components: SchematicComponent[];
  pins: SchematicGraphPin[];
  wires: SchematicWire[];
  junctions: SchematicJunction[];
  labels: SchematicLabel[];
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
  schema_version: 1;
  id: string;
  role: "PRODUCT" | "WIB";
  source_path: string;
  source_hash: string;
  source_format: "JSON" | "CSV" | "TSV" | "TEXT" | "PDF";
  revision: string | null;
  status: "DRAFT" | "CONFIRMED";
  pins: Array<{ connector: string; pin: string; net_name: string; confidence?: "EXPLICIT" | "INFERRED" }>;
  design_metrics: Array<{ id: string; value: string | number; unit: string | null; confidence?: "EXPLICIT" | "INFERRED" }>;
  diagnostics: Array<{ code: string; severity: "INFO" | "WARNING" | "ERROR"; message: string }>;
  confirmation: { confirmed_by: string; confirmed_at: string; content_hash: string } | null;
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
  source_authority?: string;
  related_net_names?: string[];
  closure_evidence?: string;
}

export interface TestRecommendationAnalysis {
  schema_version?: 1;
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
  updateRulePack(input: { rule_pack_id: string; rules: RuleDefinition[]; acknowledged_review_item_ids: string[] }): Promise<RulePack>;
  deleteRulePack(rulePackId: string): Promise<{ id: string; deleted: true }>;
  approveRulePack(rulePackId: string, approvedBy: string): Promise<RulePack>;
  runAnalysis(designId: string, rulePackId: string): Promise<AnalysisSummary>;
  queryViolations(input: Record<string, unknown>): Promise<{ analysis_id: string; total: number; offset: number; violations: Violation[] }>;
  renderEvidence(input: Record<string, unknown>): Promise<{ analysis_id: string; evidence: Array<{ violation_id: string; png_path: string; svg_path: string }> }>;
  readAnalysis(analysisId: string): Promise<AnyAnalysis>;
  openEvidence(filePath: string): Promise<{ ok: boolean; error: string | null }>;
  chooseWorkbenchInput(kind: "RULE_DOCUMENT" | "SCHEMATIC" | "TABLE", multiple: boolean, locale: "zh-CN" | "en-US"): Promise<string[]>;
  listArtifacts(): Promise<ArtifactCatalog>;
  extractRulePack(input: { paths: string[]; title?: string }): Promise<{ rule_pack: RulePack; passage_count: number; rule_count: number; rag_index_path: string }>;
  importSchematic(input: { path: string; role: "PRODUCT" | "WIB"; revision?: string }): Promise<SchematicDocument>;
  readSchematic(id: string): Promise<SchematicDocument>;
  traceSchematic(input: { schematic_id: string; candidate_id: string }): Promise<SchematicDocument>;
  correctSchematic(input: {
    schematic_id: string;
    corrected_by: string;
    candidate_id?: string;
    corrections: Array<{ operation: "UPDATE" | "ADD" | "DELETE" | "MERGE_NETS" | "SPLIT_NET" | "SET_JUNCTION" | "SET_OFF_PAGE" | "SET_PASSTHROUGH"; entity_kind: "COMPONENT" | "PIN" | "NET" | "WIRE" | "JUNCTION" | "LABEL"; entity_id: string; after?: Record<string, unknown> | null }>;
  }): Promise<SchematicDocument>;
  confirmSchematicPaths(input: { schematic_id: string; candidate_id: string; path_ids: string[]; confirmed_by: string }): Promise<SchematicDocument>;
  getSchematicPage(input: { schematic_id: string; page: number }): Promise<SchematicPagePayload>;
  getSchematicThumbnail(input: { schematic_id: string; page: number }): Promise<{ page: number; bytes: ArrayBuffer }>;
  readPinout(id: string): Promise<SchematicPinout>;
  confirmPinout(input: {
    pinout_id: string;
    confirmed_by: string;
    revision?: string;
    pins: Array<{ connector: string; pin: string; net_name: string }>;
    design_metrics: Array<{ id: string; value: string | number; unit?: string | null }>;
  }): Promise<SchematicPinout>;
  compareWiring(input: {
    product_pinout_id: string;
    wib_pinout_id: string;
    connector_mappings: ConnectorMapping[];
    net_aliases: Array<{ product_net: string; wib_net: string }>;
    case_sensitive: boolean;
  }): Promise<WiringAnalysis>;
  recommendTests(productPinoutId: string): Promise<TestRecommendationAnalysis>;
  createConstraintSet(input: { title: string; revision: string; approved_by: string; constraints: WibConstraintDefinition[] }): Promise<WibConstraintSet>;
  readConstraintSet(id: string): Promise<WibConstraintSet>;
  qualifyWib(input: {
    product_pinout_id: string;
    wib_pinout_id: string;
    constraint_set_id: string;
    connector_mappings: ConnectorMapping[];
    net_aliases: Array<{ product_net: string; wib_net: string }>;
    case_sensitive: boolean;
  }): Promise<WibQualificationAnalysis>;
  saveWibDraft(draft: WibWorkflowDraft): Promise<WibWorkflowDraft>;
  readWibDraft(id: string): Promise<WibWorkflowDraft>;
  importTable(kind: TableKind, filePath: string): Promise<TableImportResult>;
  parseTableText(kind: TableKind, text: string): Promise<TableImportResult>;
  exportTable(kind: TableKind, rows: Array<Record<string, unknown>>, format: TableFormat, locale: "zh-CN" | "en-US"): Promise<{ ok: boolean; path: string | null }>;
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
