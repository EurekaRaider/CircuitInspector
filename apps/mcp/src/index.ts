import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type {
  AnalysisSummary,
  DesignSummary,
  ManufacturingTestRequirement,
  RulePack,
  TestMethodCoverage
} from "@circuit-inspector/contracts";
import { CoreClient } from "./core-client.js";
import {
  analyzeTestAccess,
  approveManufacturingTestPlan,
  confirmLayoutBaseline,
  compareFixtureWiring,
  applySchematicCorrections,
  confirmSchematicPaths,
  confirmSchematicPinout,
  importSchematicDocument,
  invalidateDependentAnalyses,
  traceSchematicInterface,
  readLocalDocumentAnalysis,
  readWiringAnalysis,
  recommendManufacturingTests,
  updateManufacturingTestPlan,
  createWibInterfaceContract,
  createWibConstraintSet,
  extractRulePackWithValidation,
  qualifyWibClosedLoop
} from "@circuit-inspector/workflows";
import { ruleValidationText } from "./rule-validation.js";

const cacheDir = path.resolve(
  process.env.CIRCUIT_INSPECTOR_CACHE_DIR ?? path.join(os.homedir(), ".circuit-inspector", "cache")
);
const core = new CoreClient();
const server = new McpServer({ name: "circuit-inspector", version: "0.1.0" });

const coverageSchema = z.object({
  layers: z.string(),
  nets: z.string(),
  components: z.string(),
  pins: z.string(),
  test_points: z.string(),
  drills: z.string()
});

const ruleCitationSchema = z.object({
  source_path: z.string(),
  source_hash: z.string(),
  page: z.number().int().positive().nullable(),
  paragraph: z.number().int().positive().nullable(),
  excerpt: z.string()
});

const ruleDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["MINIMUM_DISTANCE", "MINIMUM_WIDTH", "MINIMUM_ANNULAR_RING", "MINIMUM_DIAMETER"]),
  source: z.enum(["TEST_POINT", "COMPONENT", "COPPER", "BOARD_EDGE", "DRILL", "TOOLING_HOLE", "PANEL_TAB", "BGA_CSP", "SHIELD_FENCE", "UV_GLUE"]),
  target: z.enum(["TEST_POINT", "COMPONENT", "COPPER", "BOARD_EDGE", "DRILL", "TOOLING_HOLE", "PANEL_TAB", "BGA_CSP", "SHIELD_FENCE", "UV_GLUE"]).nullable(),
  metric: z.enum(["CENTER_TO_CENTER", "EDGE_TO_EDGE", "BODY_TO_PAD"]).nullable(),
  threshold_nm: z.number().int(),
  severity: z.enum(["INFO", "WARNING", "ERROR"]).nullable(),
  layer_functions: z.array(z.string()),
  same_net_only: z.boolean(),
  different_net_only: z.boolean(),
  citation: ruleCitationSchema
});

const reviewResolutionSchema = z.object({
  review_item_id: z.string().min(1),
  decision: z.enum(["ACCEPT_SUGGESTION", "IGNORE", "MODIFY_RULE"]),
  note: z.string(),
  rule_id: z.string().min(1).nullable()
});

const schematicDocumentOutputSchema = {
  schema_version: z.literal(2),
  parser_version: z.string(),
  id: z.string(),
  role: z.enum(["PRODUCT", "WIB"]),
  source_path: z.string(),
  source_hash: z.string(),
  source_format: z.enum(["JSON", "CSV", "TSV", "TEXT", "PDF"]),
  revision: z.string().nullable(),
  status: z.enum(["DRAFT", "PARTIALLY_CONFIRMED", "CONFIRMED"]),
  pages: z.array(z.record(z.string(), z.unknown())),
  components: z.array(z.record(z.string(), z.unknown())),
  graph_pins: z.array(z.record(z.string(), z.unknown())),
  nets: z.array(z.record(z.string(), z.unknown())),
  wires: z.array(z.record(z.string(), z.unknown())),
  junctions: z.array(z.record(z.string(), z.unknown())),
  labels: z.array(z.record(z.string(), z.unknown())),
  edges: z.array(z.record(z.string(), z.unknown())),
  interface_candidates: z.array(z.record(z.string(), z.unknown())),
  paths: z.array(z.record(z.string(), z.unknown())),
  corrections: z.array(z.record(z.string(), z.unknown())),
  confirmed_scopes: z.array(z.record(z.string(), z.unknown())),
  pins: z.array(z.record(z.string(), z.unknown())),
  design_metrics: z.array(z.record(z.string(), z.unknown())),
  diagnostics: z.array(z.record(z.string(), z.unknown())),
  confirmation: z.record(z.string(), z.unknown()).nullable()
};

server.registerTool(
  "import_design",
  {
    title: "Import PCB design",
    description: "Import a local ODB++, TGZ, Gerber X1/X2/X3, Gerber Job, XNC/Excellon, ZIP, or IPC-356 manufacturing package.",
    inputSchema: { path: z.string().min(1) },
    outputSchema: {
      id: z.string(),
      format: z.string(),
      source_path: z.string(),
      content_hash: z.string(),
      bounds: z.record(z.string(), z.number()),
      layers: z.array(z.record(z.string(), z.unknown())),
      component_count: z.number(),
      net_count: z.number(),
      test_point_count: z.number(),
      drill_count: z.number(),
      semantic_coverage: coverageSchema,
      diagnostics: z.array(z.record(z.string(), z.unknown())),
      cache_hit: z.boolean(),
      elapsed_ms: z.number()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ path: designPath }, extra) => {
    await progress(extra, 0, 100, "Validating and streaming PCB input");
    const result = await core.request<Record<string, unknown>>(
      "import_design",
      { path: path.resolve(designPath), cache_dir: cacheDir },
      extra.signal
    );
    await progress(extra, 100, 100, "PCB design is indexed");
    return toolResult(result, `Imported ${String(result.format)} design ${String(result.id)}.`);
  }
);

server.registerTool(
  "import_schematic",
  {
    title: "Import product or WIB schematic graph",
    description: "Build a local SchematicDocument v2 graph from a complete vector or scanned PDF, or adapt a JSON/CSV/TSV/text pin mapping. PDF paths remain REVIEW until the relevant interface paths are confirmed.",
    inputSchema: {
      path: z.string().min(1),
      role: z.enum(["PRODUCT", "WIB"]),
      revision: z.string().min(1).optional()
    },
    outputSchema: schematicDocumentOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ path: schematicPath, role, revision }, extra) => {
    await progress(extra, 0, 100, "Building local schematic pages and connectivity graph");
    const document = await importSchematicDocument(schematicPath, role, cacheDir, revision, (amount, message) => {
      void progress(extra, amount, 100, message);
    });
    await progress(extra, 100, 100, "Schematic graph and interface candidates are ready for review");
    return toolResult(document as unknown as Record<string, unknown>, `Imported ${role} schematic ${document.id}: ${document.pages.length} page(s), ${document.components.length} component(s), ${document.interface_candidates.length} interface candidate(s).`);
  }
);

server.registerTool(
  "trace_schematic_interface",
  {
    title: "Trace schematic interface paths",
    description: "Trace every pin of a selected connector candidate through named nets and permitted passthrough devices to actual IC pin endpoints. Ambiguous or unmodeled paths remain REVIEW.",
    inputSchema: { schematic_id: z.string().min(1), candidate_id: z.string().min(1) },
    outputSchema: schematicDocumentOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ schematic_id, candidate_id }) => {
    const document = await traceSchematicInterface(schematic_id, candidate_id, cacheDir);
    return toolResult(document as unknown as Record<string, unknown>, `Traced ${document.paths.length} path(s); ${document.paths.filter((item) => item.status === "REVIEW").length} require review.`);
  }
);

server.registerTool(
  "apply_schematic_corrections",
  {
    title: "Apply audited schematic graph corrections",
    description: "Apply local graphical/semantic corrections and invalidate prior path confirmation. Every correction records before/after values, operator, time, and a content hash.",
    inputSchema: {
      schematic_id: z.string().min(1),
      corrected_by: z.string().min(1),
      candidate_id: z.string().min(1).optional(),
      corrections: z.array(z.object({
        operation: z.enum(["UPDATE", "ADD", "DELETE", "MERGE_NETS", "SPLIT_NET", "SET_JUNCTION", "SET_OFF_PAGE", "SET_PASSTHROUGH"]),
        entity_kind: z.enum(["COMPONENT", "PIN", "NET", "WIRE", "JUNCTION", "LABEL"]),
        entity_id: z.string().min(1),
        after: z.record(z.string(), z.unknown()).nullable().optional()
      })).min(1)
    },
    outputSchema: schematicDocumentOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ schematic_id, corrected_by, candidate_id, corrections }) => {
    const document = await applySchematicCorrections(schematic_id, corrections, corrected_by, cacheDir, candidate_id);
    await invalidateSchematicAnalyses(schematic_id, "Schematic graph corrections changed controlled connectivity evidence");
    return toolResult(document as unknown as Record<string, unknown>, `Applied ${corrections.length} correction(s); prior confirmation was invalidated and paths were retraced.`);
  }
);

server.registerTool(
  "confirm_schematic_paths",
  {
    title: "Confirm selected schematic analysis paths",
    description: "Confirm only the selected interface paths after reviewing their cross-page evidence. This does not mark the complete PDF as authoritative.",
    inputSchema: {
      schematic_id: z.string().min(1),
      candidate_id: z.string().min(1),
      path_ids: z.array(z.string().min(1)).min(1),
      confirmed_by: z.string().min(1)
    },
    outputSchema: schematicDocumentOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ schematic_id, candidate_id, path_ids, confirmed_by }) => {
    const document = await confirmSchematicPaths(schematic_id, candidate_id, path_ids, confirmed_by, cacheDir);
    await invalidateSchematicAnalyses(schematic_id, "Schematic path confirmation changed the authoritative analysis scope");
    return toolResult(document as unknown as Record<string, unknown>, `Confirmed ${path_ids.length} selected path(s) in scope ${document.confirmed_scopes[0]?.id ?? "-"}.`);
  }
);

server.registerTool(
  "confirm_schematic_pinout",
  {
    title: "Confirm schematic pinout evidence",
    description: "Confirm the complete connector/pin/NET NAME set before it can support deterministic WIB PASS or FAIL. Supply corrected pins when PDF extraction is incomplete or wrong.",
    inputSchema: {
      pinout_id: z.string().min(1),
      confirmed_by: z.string().min(1),
      revision: z.string().min(1).optional(),
      pins: z.array(z.object({ connector: z.string().min(1), pin: z.string().min(1), net_name: z.string().min(1) })).min(1).optional(),
      design_metrics: z.array(z.object({
        id: z.string().min(1),
        value: z.union([z.string().min(1), z.number().finite()]),
        unit: z.string().nullable().optional()
      })).optional()
    },
    outputSchema: {
      id: z.string(),
      role: z.enum(["PRODUCT", "WIB"]),
      source_path: z.string(),
      source_hash: z.string(),
      source_format: z.enum(["JSON", "CSV", "TSV", "TEXT", "PDF"]),
      revision: z.string().nullable(),
      status: z.literal("CONFIRMED"),
      pins: z.array(z.record(z.string(), z.unknown())),
      design_metrics: z.array(z.record(z.string(), z.unknown())),
      diagnostics: z.array(z.record(z.string(), z.unknown())),
      confirmation: z.record(z.string(), z.unknown())
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ pinout_id, confirmed_by, pins, revision, design_metrics }) => {
    const document = await confirmSchematicPinout(pinout_id, confirmed_by, cacheDir, pins, revision, design_metrics);
    await invalidateSchematicAnalyses(pinout_id, "Confirmed pinout rows, revision, or design metrics changed");
    return toolResult(document as unknown as Record<string, unknown>, `Confirmed ${document.role} pinout ${document.id} with ${document.pins.length} pin row(s).`);
  }
);

server.registerTool(
  "compare_fixture_wiring",
  {
    title: "Compare product and WIB schematic wiring",
    description: "Compare confirmed product and WIB connector pins one-to-one by NET NAME, generate an evidence-linked report, and return PASS only for a complete confirmed mapping with no mismatch.",
    inputSchema: {
      product_pinout_id: z.string().min(1),
      wib_pinout_id: z.string().min(1),
      connector_mappings: z.array(z.object({
        product_connector: z.string().min(1),
        wib_connector: z.string().min(1),
        pin_map: z.array(z.object({ product_pin: z.string().min(1), wib_pin: z.string().min(1) })).min(1).optional()
      })).min(1).optional(),
      net_aliases: z.array(z.object({ product_net: z.string().min(1), wib_net: z.string().min(1) })).optional(),
      case_sensitive: z.boolean().default(false)
    },
    outputSchema: {
      kind: z.literal("WIRING_COMPARISON"),
      id: z.string(),
      product_pinout_id: z.string(),
      wib_pinout_id: z.string(),
      verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]),
      verification_mode: z.literal("DOCUMENT_BACKED"),
      pass_count: z.number(),
      fail_count: z.number(),
      review_count: z.number(),
      not_applicable_count: z.number(),
      connections: z.array(z.record(z.string(), z.unknown())),
      violations: z.array(z.record(z.string(), z.unknown())),
      diagnostics: z.array(z.record(z.string(), z.unknown())),
      report_uri: z.string(),
      report_path: z.string(),
      elapsed_ms: z.number(),
      product: z.record(z.string(), z.unknown()),
      wib: z.record(z.string(), z.unknown()),
      connector_mappings: z.array(z.record(z.string(), z.unknown())),
      net_aliases: z.array(z.record(z.string(), z.unknown())),
      case_sensitive: z.boolean()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ product_pinout_id, wib_pinout_id, connector_mappings, net_aliases, case_sensitive }, extra) => {
    await progress(extra, 0, 100, "Comparing product and WIB pin mappings");
    const analysis = await compareFixtureWiring(product_pinout_id, wib_pinout_id, cacheDir, {
      ...(connector_mappings ? { connectorMappings: connector_mappings } : {}),
      ...(net_aliases ? { netAliases: net_aliases } : {}),
      caseSensitive: case_sensitive
    });
    await progress(extra, 100, 100, "WIB wiring comparison and report are ready");
    return {
      content: [
        { type: "text" as const, text: `WIB wiring ${analysis.id}: ${analysis.verdict}. PASS ${analysis.pass_count}, FAIL ${analysis.fail_count}, REVIEW ${analysis.review_count}.` },
        { type: "resource_link" as const, name: "Open wiring report", uri: analysis.report_uri, mimeType: "text/html" },
        { type: "resource_link" as const, name: "Open wiring analysis in CircuitInspector Viewer", uri: viewerLink(analysis.id), mimeType: "application/x-circuit-inspector" }
      ],
      structuredContent: analysis as unknown as Record<string, unknown>
    };
  }
);

server.registerTool(
  "recommend_manufacturing_tests",
  {
    title: "Recommend manufacturing tests and WIB design constraints",
    description: "Generate schematic-backed manufacturing-line test recommendations, corresponding WIB design guidance, and a hard-constraint matrix. Missing factory/tester numeric limits remain REVIEW and are never invented.",
    inputSchema: { product_pinout_id: z.string().min(1) },
    outputSchema: {
      kind: z.literal("MANUFACTURING_TEST_RECOMMENDATIONS"),
      schema_version: z.literal(2),
      id: z.string(),
      product_pinout_id: z.string(),
      product: z.record(z.string(), z.unknown()),
      lifecycle_status: z.enum(["DRAFT", "APPROVED", "SUPERSEDED"]),
      baseline: z.record(z.string(), z.unknown()),
      approval: z.record(z.string(), z.unknown()).nullable(),
      verdict: z.literal("REVIEW"),
      verification_mode: z.literal("DOCUMENT_BACKED"),
      method_matrix: z.array(z.record(z.string(), z.unknown())),
      requirements: z.array(z.record(z.string(), z.unknown())),
      recommendation_count: z.number(),
      recommendations: z.array(z.record(z.string(), z.unknown())),
      wib_design_recommendations: z.array(z.record(z.string(), z.unknown())),
      wib_constraints: z.array(z.record(z.string(), z.unknown())),
      diagnostics: z.array(z.record(z.string(), z.unknown())),
      report_uri: z.string(),
      report_path: z.string(),
      elapsed_ms: z.number()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ product_pinout_id }, extra) => {
    await progress(extra, 0, 100, "Classifying schematic NET NAME evidence and building the manufacturing test plan");
    const plan = await recommendManufacturingTests(product_pinout_id, cacheDir);
    await progress(extra, 100, 100, "Manufacturing test, WIB design, and hard-constraint lists are ready");
    return {
      content: [
        { type: "text" as const, text: `Generated ${plan.recommendation_count} manufacturing-test groups, ${plan.wib_design_recommendations.length} WIB design recommendations, and ${plan.wib_constraints.length} hard-constraint rows. Overall status remains REVIEW.` },
        { type: "resource_link" as const, name: "Open manufacturing test and WIB design report", uri: plan.report_uri, mimeType: "text/html" },
        { type: "resource_link" as const, name: "Open recommendations in CircuitInspector Viewer", uri: viewerLink(plan.id), mimeType: "application/x-circuit-inspector" }
      ],
      structuredContent: plan as unknown as Record<string, unknown>
    };
  }
);

server.registerTool(
  "update_manufacturing_test_plan",
  {
    title: "Review and update a draft manufacturing test plan",
    description: "Replace the complete requirement and method-fault matrices of a DRAFT plan after AI or human review. The workflow validates controlled fields and rejects mutation after approval.",
    inputSchema: {
      test_plan_id: z.string().min(1),
      requirements: z.array(z.record(z.string(), z.unknown())).min(1),
      method_matrix: z.array(z.record(z.string(), z.unknown())).min(1)
    },
    outputSchema: { test_plan: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  async ({ test_plan_id, requirements, method_matrix }) => {
    const plan = await updateManufacturingTestPlan(
      test_plan_id,
      requirements as unknown as ManufacturingTestRequirement[],
      method_matrix as unknown as TestMethodCoverage[],
      cacheDir
    );
    return toolResult({ test_plan: plan as unknown as Record<string, unknown> }, `Updated DRAFT DFT plan ${plan.id}; authoritative approval is still required.`);
  }
);

server.registerTool(
  "approve_manufacturing_test_plan",
  {
    title: "Approve the DFT requirement baseline",
    description: "Freeze what manufacturing tests must cover against a confirmed product revision and an already approved factory/line/tester rule pack. This does not release the production test solution.",
    inputSchema: {
      test_plan_id: z.string().min(1),
      approved_by: z.string().min(1),
      variant: z.string().min(1).nullable().optional(),
      panel: z.string().min(1).nullable().optional(),
      factory: z.string().min(1),
      line: z.string().min(1),
      tester: z.string().min(1),
      approved_rule_pack_id: z.string().min(1)
    },
    outputSchema: { test_plan: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  async ({ test_plan_id, approved_by, variant, panel, factory, line, tester, approved_rule_pack_id }) => {
    await requireApprovedRulePack(approved_rule_pack_id);
    const plan = await approveManufacturingTestPlan(test_plan_id, {
      approvedBy: approved_by,
      ...(variant !== undefined ? { variant } : {}),
      ...(panel !== undefined ? { panel } : {}),
      factory,
      line,
      tester,
      approvedRulePackId: approved_rule_pack_id
    }, cacheDir);
    return toolResult({ test_plan: plan as unknown as Record<string, unknown> }, `Approved DFT requirement baseline ${plan.id} at SHA-256 ${plan.approval?.content_hash ?? "MISSING"}. Fixture, station, powered, throughput, and pilot release remain separate gates.`);
  }
);

const constraintValueSchema = z.union([
  z.string().min(1),
  z.number().finite(),
  z.object({ min: z.number().finite(), max: z.number().finite() })
]);

server.registerTool(
  "create_wib_constraint_set",
  {
    title: "Create an approved WIB hard-constraint set",
    description: "Store explicit WIB hard requirements with comparator, value/range, unit, authority, revision, and approver. This tool accepts structured approved requirements; it does not infer or invent numeric limits.",
    inputSchema: {
      title: z.string().min(1),
      revision: z.string().min(1),
      approved_by: z.string().min(1),
      constraints: z.array(z.object({
        id: z.string().min(1),
        area: z.string().min(1),
        requirement: z.string().min(1),
        check: z.enum(["WIRING_ONE_TO_ONE", "NET_IDENTITY", "COMPLETE_PIN_COVERAGE", "NO_UNINTENDED_INTERCONNECT", "NC_ISOLATION", "DESIGN_METRIC", "ENDPOINT_UNIQUENESS", "NO_UNRESOLVED_BRANCH", "PATH_COMPONENT_POLICY", "ENDPOINT_PIN_MATCH"]),
        metric_id: z.string().nullable().optional(),
        comparator: z.enum(["EXACT", "ALL", "NONE", "MAXIMUM", "MINIMUM", "RANGE"]),
        required_value: constraintValueSchema,
        unit: z.string().nullable().optional(),
        verification_mode: z.enum(["DOCUMENT_BACKED", "MANUAL_FACTORY_CONFIRMATION"]),
        source_authority: z.string().min(1),
        scope: z.object({ connector: z.string().min(1).optional(), pin: z.string().min(1).optional(), net_name: z.string().min(1).optional() }).optional(),
        allowed_component_kinds: z.array(z.enum(["CONNECTOR", "IC", "PASSIVE", "PROTECTION", "POWER", "UNKNOWN"])).optional(),
        forbidden_component_refs: z.array(z.string().min(1)).optional(),
        expected_endpoint_refs: z.array(z.string().min(1)).optional()
      })).min(1)
    },
    outputSchema: {
      id: z.string(),
      title: z.string(),
      revision: z.string(),
      status: z.literal("APPROVED"),
      approved_by: z.string(),
      approved_at: z.string(),
      content_hash: z.string(),
      constraints: z.array(z.record(z.string(), z.unknown()))
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ title, revision, approved_by, constraints }) => {
    const constraintSet = await createWibConstraintSet({
      title,
      revision,
      approvedBy: approved_by,
      constraints: constraints.map((constraint) => ({
        id: constraint.id,
        area: constraint.area,
        requirement: constraint.requirement,
        check: constraint.check,
        metric_id: constraint.metric_id ?? null,
        comparator: constraint.comparator,
        required_value: constraint.required_value,
        unit: constraint.unit ?? null,
        verification_mode: constraint.verification_mode,
        source_authority: constraint.source_authority,
        ...(constraint.scope ? { scope: {
          ...(constraint.scope.connector ? { connector: constraint.scope.connector } : {}),
          ...(constraint.scope.pin ? { pin: constraint.scope.pin } : {}),
          ...(constraint.scope.net_name ? { net_name: constraint.scope.net_name } : {})
        } } : {}),
        ...(constraint.allowed_component_kinds ? { allowed_component_kinds: constraint.allowed_component_kinds } : {}),
        ...(constraint.forbidden_component_refs ? { forbidden_component_refs: constraint.forbidden_component_refs } : {}),
        ...(constraint.expected_endpoint_refs ? { expected_endpoint_refs: constraint.expected_endpoint_refs } : {})
      }))
    }, cacheDir);
    return toolResult(constraintSet as unknown as Record<string, unknown>, `Stored approved WIB constraint set ${constraintSet.id} revision ${constraintSet.revision} with ${constraintSet.constraints.length} hard requirement(s).`);
  }
);

server.registerTool(
  "create_wib_interface_contract",
  {
    title: "Approve a product-to-WIB pin interface contract",
    description: "Freeze a complete explicit connector and pin mapping between confirmed product and WIB revisions. NET NAME aliases are controlled hints within this exact mapping, never a substitute for pin identity.",
    inputSchema: {
      title: z.string().min(1),
      revision: z.string().min(1),
      approved_by: z.string().min(1),
      product_pinout_id: z.string().min(1),
      wib_pinout_id: z.string().min(1),
      connector_mappings: z.array(z.object({
        product_connector: z.string().min(1),
        wib_connector: z.string().min(1),
        pin_map: z.array(z.object({ product_pin: z.string().min(1), wib_pin: z.string().min(1) })).min(1)
      })).min(1),
      net_aliases: z.array(z.object({ product_net: z.string().min(1), wib_net: z.string().min(1) })).optional(),
      case_sensitive: z.boolean().default(false)
    },
    outputSchema: {
      id: z.string(),
      title: z.string(),
      revision: z.string(),
      status: z.literal("APPROVED"),
      product_pinout_id: z.string(),
      wib_pinout_id: z.string(),
      product_revision: z.string(),
      wib_revision: z.string(),
      connector_mappings: z.array(z.record(z.string(), z.unknown())),
      net_aliases: z.array(z.record(z.string(), z.unknown())),
      case_sensitive: z.boolean(),
      approved_by: z.string(),
      approved_at: z.string(),
      content_hash: z.string()
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ title, revision, approved_by, product_pinout_id, wib_pinout_id, connector_mappings, net_aliases, case_sensitive }) => {
    const contract = await createWibInterfaceContract({
      title,
      revision,
      approvedBy: approved_by,
      productPinoutId: product_pinout_id,
      wibPinoutId: wib_pinout_id,
      connectorMappings: connector_mappings,
      ...(net_aliases ? { netAliases: net_aliases } : {}),
      caseSensitive: case_sensitive
    }, cacheDir);
    return toolResult(contract as unknown as Record<string, unknown>, `Approved complete pin interface contract ${contract.id} revision ${contract.revision}; actual wiring is qualified separately.`);
  }
);

server.registerTool(
  "qualify_wib_design",
  {
    title: "Qualify final WIB design",
    description: "Qualify confirmed product and actual WIB schematics against an approved pin interface contract, approved DFT baseline, and approved electrical/resource constraint set. Static design PASS never implies production release.",
    inputSchema: {
      product_pinout_id: z.string().min(1),
      wib_pinout_id: z.string().min(1),
      interface_contract_id: z.string().min(1),
      approved_test_plan_id: z.string().min(1),
      approved_constraint_set_id: z.string().min(1)
    },
    outputSchema: {
      kind: z.literal("WIB_DESIGN_QUALIFICATION"),
      id: z.string(),
      product_pinout_id: z.string(),
      wib_pinout_id: z.string(),
      constraint_set_id: z.string(),
      interface_contract_id: z.string(),
      test_plan_id: z.string(),
      product_content_hash: z.string(),
      wib_content_hash: z.string(),
      interface_contract_content_hash: z.string(),
      test_plan_content_hash: z.string(),
      constraint_set_content_hash: z.string(),
      verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]),
      production_readiness_verdict: z.literal("REVIEW"),
      verification_mode: z.literal("DOCUMENT_BACKED"),
      wiring_analysis_id: z.string(),
      wiring_verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]),
      pass_count: z.number(),
      fail_count: z.number(),
      review_count: z.number(),
      not_applicable_count: z.number(),
      constraint_results: z.array(z.record(z.string(), z.unknown())),
      requirement_results: z.array(z.record(z.string(), z.unknown())),
      factory_confirmation_items: z.array(z.record(z.string(), z.unknown())),
      violations: z.array(z.record(z.string(), z.unknown())),
      report_uri: z.string(),
      report_path: z.string(),
      elapsed_ms: z.number()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ product_pinout_id, wib_pinout_id, interface_contract_id, approved_test_plan_id, approved_constraint_set_id }, extra) => {
    await progress(extra, 0, 100, "Running closed-loop WIB pin-contract, DFT-traceability, and constraint qualification");
    const qualification = await qualifyWibClosedLoop(product_pinout_id, wib_pinout_id, interface_contract_id, approved_test_plan_id, approved_constraint_set_id, cacheDir);
    await progress(extra, 100, 100, "WIB static qualification is ready; production gates remain REVIEW");
    return {
      content: [
        { type: "text" as const, text: `WIB static qualification ${qualification.id}: ${qualification.verdict}. Production readiness: REVIEW. PASS ${qualification.pass_count}, FAIL ${qualification.fail_count}, REVIEW ${qualification.review_count}, N/A ${qualification.not_applicable_count}.` },
        { type: "resource_link" as const, name: "Open final WIB qualification report", uri: qualification.report_uri, mimeType: "text/html" },
        { type: "resource_link" as const, name: "Open final WIB qualification in CircuitInspector Viewer", uri: viewerLink(qualification.id), mimeType: "application/x-circuit-inspector" }
      ],
      structuredContent: qualification as unknown as Record<string, unknown>
    };
  }
);

server.registerTool(
  "extract_rule_pack",
  {
    title: "Extract draft PCB rules",
    description: "Extract auditable DFT/DFM rule candidates from local PDF, DOCX, Markdown, or text documents. The result remains DRAFT until approved in the Viewer.",
    inputSchema: { paths: z.array(z.string().min(1)).min(1), title: z.string().optional() },
    outputSchema: {
      rule_pack: z.record(z.string(), z.unknown()).nullable(),
      passage_count: z.number(),
      rule_count: z.number(),
      rag_index_path: z.string(),
      validation: z.record(z.string(), z.unknown())
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ paths, title }, extra) => {
    await progress(extra, 0, 100, "Validating the rule-source template and extracting local evidence");
    const extracted = await extractRulePackWithValidation(paths, cacheDir, title);
    if (extracted.rulePack) {
      await core.request("save_rule_pack", { cache_dir: cacheDir, rule_pack: extracted.rulePack }, extra.signal);
    }
    await progress(extra, 100, 100, extracted.rulePack
      ? "Draft rule pack created; review the reported diagnostics before approval"
      : "Rule-source validation failed; no rule pack was created");
    const structured = {
      rule_pack: extracted.rulePack,
      passage_count: extracted.passageCount,
      rule_count: extracted.ruleCount,
      rag_index_path: extracted.ragIndexPath,
      validation: extracted.validation
    };
    const result = toolResult(structured, ruleValidationText(extracted.rulePack?.id ?? null, extracted.ruleCount, extracted.validation));
    return extracted.rulePack ? result : { ...result, isError: true };
  }
);

server.registerTool(
  "update_rule_pack_draft",
  {
    title: "Resolve and edit a draft PCB rule pack",
    description: "Update an existing DRAFT rule pack. Review items may accept the program suggestion, ignore it with a reason, or link to a manually modified candidate rule. Pass the complete current rule list and complete current resolution list. This tool never approves a rule pack.",
    inputSchema: {
      rule_pack_id: z.string().min(1),
      rules: z.array(ruleDefinitionSchema),
      review_item_resolutions: z.array(reviewResolutionSchema)
    },
    outputSchema: { rule_pack: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  },
  async ({ rule_pack_id, rules, review_item_resolutions }) => {
    const rulePack = await core.request<Record<string, unknown>>("update_rule_pack", {
      cache_dir: cacheDir,
      rule_pack_id,
      rules,
      review_item_resolutions
    });
    const counts = review_item_resolutions.reduce<Record<string, number>>((current, resolution) => {
      current[resolution.decision] = (current[resolution.decision] ?? 0) + 1;
      return current;
    }, {});
    return toolResult(
      { rule_pack: rulePack },
      `Updated DRAFT rule pack ${rule_pack_id}: ${rules.length} candidate rule(s); ${counts.ACCEPT_SUGGESTION ?? 0} accepted suggestion(s), ${counts.IGNORE ?? 0} ignored with recorded reasons, and ${counts.MODIFY_RULE ?? 0} linked rule modification(s). Human approval in CircuitInspector Viewer is still required.`
    );
  }
);

server.registerTool(
  "list_rule_packs",
  {
    title: "List PCB rule packs",
    description: "List local DRAFT, APPROVED, and DEPRECATED rule packs.",
    inputSchema: {},
    outputSchema: { rule_packs: z.array(z.record(z.string(), z.unknown())) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    const result = await core.request<{ rule_packs: unknown[] }>("list_rule_packs", { cache_dir: cacheDir });
    return toolResult(result, `Found ${result.rule_packs.length} local rule packs.`);
  }
);

server.registerTool(
  "analyze_design",
  {
    title: "Analyze PCB design",
    description: "Run an APPROVED deterministic DFT/DFM rule pack against an imported PCB design.",
    inputSchema: { design_id: z.string().min(1), rule_pack_id: z.string().min(1) },
    outputSchema: {
      id: z.string(),
      design_id: z.string(),
      rule_pack_id: z.string(),
      verdict: z.string(),
      pass_count: z.number(),
      fail_count: z.number(),
      review_count: z.number(),
      not_applicable_count: z.number(),
      violations: z.array(z.record(z.string(), z.unknown())),
      report_uri: z.string(),
      elapsed_ms: z.number(),
      report_path: z.string()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ design_id, rule_pack_id }, extra) => {
    await progress(extra, 0, 100, "Starting deterministic geometry checks");
    const result = await core.request<Record<string, unknown>>(
      "analyze_design",
      { cache_dir: cacheDir, design_id, rule_pack_id },
      extra.signal
    );
    await progress(extra, 100, 100, "Analysis complete");
    const viewer = viewerLink(String(result.id));
    return {
      content: [
        { type: "text" as const, text: `Analysis ${String(result.id)}: ${String(result.verdict)}. FAIL ${String(result.fail_count)}, REVIEW ${String(result.review_count)}.` },
        { type: "resource_link" as const, name: "Open in CircuitInspector Viewer", uri: viewer, mimeType: "application/x-circuit-inspector" }
      ],
      structuredContent: result
    };
  }
);

server.registerTool(
  "confirm_layout_baseline",
  {
    title: "Approve the controlled ODB++ Layout baseline",
    description: "Bind an exact ODB++ hash to the approved DFT plan and record source units, coordinate origin, Top/Bottom viewing convention, mirror convention, and Panel step-repeat applicability. This is document-backed configuration approval, not factory release.",
    inputSchema: {
      design_id: z.string().min(1),
      approved_test_plan_id: z.string().min(1),
      source_units: z.enum(["MM", "INCH", "MIXED"]),
      coordinate_origin: z.string().min(1),
      bottom_mirrored_in_top_view: z.boolean(),
      panel_step_repeat: z.string().min(1),
      approved_by: z.string().min(1)
    },
    outputSchema: { layout_baseline: z.record(z.string(), z.unknown()) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  },
  async ({ design_id, approved_test_plan_id, source_units, coordinate_origin, bottom_mirrored_in_top_view, panel_step_repeat, approved_by }, extra) => {
    const design = await core.request<DesignSummary>("get_design_summary", { cache_dir: cacheDir, design_id }, extra.signal);
    const baseline = await confirmLayoutBaseline({ design, approvedTestPlanId: approved_test_plan_id, sourceUnits: source_units, coordinateOrigin: coordinate_origin, bottomMirroredInTopView: bottom_mirrored_in_top_view, panelStepRepeat: panel_step_repeat, approvedBy: approved_by }, cacheDir);
    return toolResult({ layout_baseline: baseline as unknown as Record<string, unknown> }, `Approved controlled Layout baseline ${baseline.id} for design SHA-256 ${baseline.design_content_hash}.`);
  }
);

server.registerTool(
  "analyze_test_access",
  {
    title: "Analyze approved DFT requirements against PCB test access",
    description: "Build the approved requirement-to-access traceability matrix, distinguish physical and virtual access, apply the same approved geometry rule pack, and keep factory/fixture production release as REVIEW.",
    inputSchema: {
      design_id: z.string().min(1),
      approved_test_plan_id: z.string().min(1),
      approved_rule_pack_id: z.string().min(1)
    },
    outputSchema: {
      schema_version: z.literal(1),
      kind: z.literal("LAYOUT_TEST_ACCESS_ANALYSIS"),
      id: z.string(),
      design_id: z.string(),
      design_content_hash: z.string(),
      test_plan_id: z.string(),
      test_plan_content_hash: z.string(),
      rule_pack_id: z.string(),
      rule_pack_content_hash: z.string(),
      layout_baseline_confirmation_id: z.string().nullable(),
      layout_baseline_content_hash: z.string().nullable(),
      geometry_analysis_id: z.string(),
      verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]),
      production_readiness_verdict: z.literal("REVIEW"),
      pass_count: z.number(),
      fail_count: z.number(),
      review_count: z.number(),
      not_applicable_count: z.number(),
      baseline_checks: z.array(z.record(z.string(), z.unknown())),
      mappings: z.array(z.record(z.string(), z.unknown())),
      factory_confirmation_items: z.array(z.record(z.string(), z.unknown())),
      diagnostics: z.array(z.record(z.string(), z.unknown())),
      report_uri: z.string(),
      report_path: z.string(),
      elapsed_ms: z.number()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ design_id, approved_test_plan_id, approved_rule_pack_id }, extra) => {
    await progress(extra, 0, 100, "Loading the complete layout, approved DFT baseline, and approved rule pack");
    const [design, pointsResult, rulePacks] = await Promise.all([
      core.request<DesignSummary>("get_design_summary", { cache_dir: cacheDir, design_id }, extra.signal),
      core.request<{ test_points: unknown[] }>("list_test_points", { cache_dir: cacheDir, design_id }, extra.signal),
      core.request<{ rule_packs: RulePack[] }>("list_rule_packs", { cache_dir: cacheDir }, extra.signal)
    ]);
    const rulePack = rulePacks.rule_packs.find((candidate) => candidate.id === approved_rule_pack_id);
    if (!rulePack || rulePack.status !== "APPROVED" || !rulePack.approval) throw new Error(`${approved_rule_pack_id} is not an approved rule pack`);
    await progress(extra, 35, 100, "Running approved geometry rules across all imported layers and semantics");
    const geometry = await core.request<AnalysisSummary>("analyze_design", {
      cache_dir: cacheDir,
      design_id,
      rule_pack_id: approved_rule_pack_id
    }, extra.signal);
    await progress(extra, 70, 100, "Building requirement-to-physical-or-virtual access traceability");
    const analysis = await analyzeTestAccess({
      design,
      testPoints: pointsResult.test_points as Parameters<typeof analyzeTestAccess>[0]["testPoints"],
      geometryAnalysis: geometry,
      rulePack,
      testPlanId: approved_test_plan_id
    }, cacheDir);
    await progress(extra, 100, 100, "Layout DFT report is ready; production readiness remains REVIEW");
    return {
      content: [
        { type: "text" as const, text: `Layout DFT ${analysis.id}: design ${analysis.verdict}; production readiness REVIEW. PASS ${analysis.pass_count}, FAIL ${analysis.fail_count}, REVIEW ${analysis.review_count}, N/A ${analysis.not_applicable_count}.` },
        { type: "resource_link" as const, name: "Open Layout DFT report", uri: analysis.report_uri, mimeType: "text/html" },
        { type: "resource_link" as const, name: "Open Layout DFT analysis in CircuitInspector Viewer", uri: viewerLink(analysis.id), mimeType: "application/x-circuit-inspector" }
      ],
      structuredContent: analysis as unknown as Record<string, unknown>
    };
  }
);

server.registerTool(
  "query_violations",
  {
    title: "Query PCB violations",
    description: "Filter analysis results by net name, reference designator, rule, or verdict.",
    inputSchema: {
      analysis_id: z.string().min(1),
      net_name: z.string().optional(),
      component_ref: z.string().optional(),
      rule_id: z.string().optional(),
      verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(1000).default(100)
    },
    outputSchema: {
      analysis_id: z.string(),
      total: z.number(),
      offset: z.number(),
      violations: z.array(z.record(z.string(), z.unknown()))
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async (input, extra) => {
    const wiring = await readWiringAnalysis(input.analysis_id, cacheDir);
    if (wiring) {
      const filtered = wiring.violations
        .filter((finding) => input.net_name == null || finding.net_names.some((net) => net.includes(input.net_name!)))
        .filter((finding) => input.component_ref == null || finding.component_refs.some((reference) => reference.includes(input.component_ref!)))
        .filter((finding) => input.rule_id == null || finding.rule_id === input.rule_id)
        .filter((finding) => input.verdict == null || finding.verdict === input.verdict);
      const result = {
        analysis_id: wiring.id,
        total: filtered.length,
        offset: input.offset,
        violations: filtered.slice(input.offset, input.offset + input.limit)
      };
      return toolResult(result, `Returned ${result.violations.length} wiring findings.`);
    }
    const result = await core.request<Record<string, unknown>>(
      "query_violations",
      { cache_dir: cacheDir, ...input },
      extra.signal
    );
    return toolResult(result, `Returned ${(result.violations as unknown[]).length} violations.`);
  }
);

server.registerTool(
  "render_evidence",
  {
    title: "Render PCB evidence",
    description: "Render local high-resolution PNG and lossless SVG evidence for selected violations.",
    inputSchema: {
      analysis_id: z.string().min(1),
      violation_ids: z.array(z.string()).default([]),
      width: z.number().int().min(256).max(4096).default(1600),
      height: z.number().int().min(256).max(4096).default(1200)
    },
    outputSchema: { analysis_id: z.string(), evidence: z.array(z.record(z.string(), z.unknown())) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async (input, extra) => {
    await progress(extra, 0, 100, "Rendering vector evidence locally");
    const result = await core.request<{ analysis_id: string; evidence: Array<{ violation_id: string; png_path: string; svg_path: string }> }>(
      "render_evidence",
      { cache_dir: cacheDir, ...input },
      extra.signal
    );
    await progress(extra, 100, 100, "Evidence ready");
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
      | { type: "resource_link"; name: string; uri: string; mimeType: string }
    > = [
      { type: "text", text: `Rendered ${result.evidence.length} evidence image(s) for analysis ${result.analysis_id}.` }
    ];
    for (const item of result.evidence.slice(0, 8)) {
      const data = await readFile(item.png_path);
      content.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
      content.push({ type: "resource_link", name: `${item.violation_id} SVG`, uri: pathToFileURL(item.svg_path).href, mimeType: "image/svg+xml" });
      content.push({ type: "resource_link", name: "Open issue in Viewer", uri: viewerLink(result.analysis_id, item.violation_id), mimeType: "application/x-circuit-inspector" });
    }
    return { content, structuredContent: result };
  }
);

server.registerResource(
  "analysis-summary",
  new ResourceTemplate("circuit://analysis/{analysisId}/summary", { list: undefined }),
  { title: "CircuitInspector analysis summary", mimeType: "application/json" },
  async (uri, { analysisId }) => {
    const analysis = await readLocalDocumentAnalysis(String(analysisId), cacheDir)
      ?? await core.request("read_analysis", { cache_dir: cacheDir, analysis_id: String(analysisId) });
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(analysis, null, 2) }] };
  }
);

server.registerResource(
  "analysis-report",
  new ResourceTemplate("circuit://analysis/{analysisId}/report", { list: undefined }),
  { title: "CircuitInspector HTML report", mimeType: "text/html" },
  async (uri, { analysisId }) => {
    const report = path.join(cacheDir, "evidence", resourceSegment(analysisId), "report.html");
    return { contents: [{ uri: uri.href, mimeType: "text/html", text: await readFile(report, "utf8") }] };
  }
);

server.registerResource(
  "analysis-evidence",
  new ResourceTemplate("circuit://analysis/{analysisId}/evidence/{fileName}", { list: undefined }),
  { title: "CircuitInspector evidence", mimeType: "application/octet-stream" },
  async (uri, { analysisId, fileName }) => {
    const safeFile = resourceSegment(fileName, true);
    const file = path.join(cacheDir, "evidence", resourceSegment(analysisId), safeFile);
    const data = await readFile(file);
    return {
      contents: [{
        uri: uri.href,
        mimeType: safeFile.endsWith(".svg") ? "image/svg+xml" : "image/png",
        blob: data.toString("base64")
      }]
    };
  }
);

async function progress(
  extra: {
    _meta?: { progressToken?: string | number | undefined } | undefined;
    sendNotification: (notification: any) => Promise<void>;
  },
  value: number,
  total: number,
  message: string
) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: value, total, message } });
}

function toolResult<T extends Record<string, unknown>>(structuredContent: T, text: string) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

async function requireApprovedRulePack(rulePackId: string): Promise<RulePack> {
  const result = await core.request<{ rule_packs: RulePack[] }>("list_rule_packs", { cache_dir: cacheDir });
  const rulePack = result.rule_packs.find((candidate) => candidate.id === rulePackId);
  if (!rulePack || rulePack.status !== "APPROVED" || !rulePack.approval) throw new Error(`${rulePackId} is not an approved rule pack`);
  return rulePack;
}

async function invalidateSchematicAnalyses(schematicId: string, reason: string) {
  const direct = await invalidateDependentAnalyses(
    cacheDir,
    (analysis) => analysis.product_pinout_id === schematicId || analysis.wib_pinout_id === schematicId,
    `${reason}: ${schematicId}`
  );
  if (!direct.length) return;
  const ids = new Set(direct);
  await invalidateDependentAnalyses(
    cacheDir,
    (analysis) => (typeof analysis.test_plan_id === "string" && ids.has(analysis.test_plan_id))
      || (typeof analysis.wiring_analysis_id === "string" && ids.has(analysis.wiring_analysis_id)),
    `A controlled schematic dependency was invalidated: ${schematicId}`
  );
}

function viewerLink(analysisId: string, issueId?: string): string {
  const search = issueId ? `?issue=${encodeURIComponent(issueId)}` : "";
  return `circuitinspector://analysis/${encodeURIComponent(analysisId)}${search}`;
}

function resourceSegment(value: unknown, allowDot = false): string {
  const text = String(value);
  const pattern = allowDot ? /^[a-zA-Z0-9_-]+\.(?:png|svg)$/ : /^[a-zA-Z0-9_-]+$/;
  if (!pattern.test(text)) throw new Error("Invalid CircuitInspector resource identifier");
  return text;
}

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    core.close();
    process.exit(0);
  });
}
