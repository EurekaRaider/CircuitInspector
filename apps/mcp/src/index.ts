import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CoreClient } from "./core-client.js";
import {
  compareFixtureWiring,
  applySchematicCorrections,
  confirmSchematicPaths,
  confirmSchematicPinout,
  importSchematicDocument,
  traceSchematicInterface,
  readLocalDocumentAnalysis,
  readWiringAnalysis,
  recommendManufacturingTests,
  createWibConstraintSet,
  extractRulePack,
  qualifyWibDesign
} from "@circuit-inspector/workflows";

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
      net_aliases: z.array(z.record(z.string(), z.unknown()))
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
      id: z.string(),
      product_pinout_id: z.string(),
      product: z.record(z.string(), z.unknown()),
      verdict: z.literal("REVIEW"),
      verification_mode: z.literal("DOCUMENT_BACKED"),
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
  "qualify_wib_design",
  {
    title: "Qualify final WIB design",
    description: "Close the loop across a confirmed product schematic, confirmed actual WIB schematic/design metrics, and an approved WIB hard-constraint set. PASS requires every applicable constraint to have supported evidence and pass.",
    inputSchema: {
      product_pinout_id: z.string().min(1),
      wib_pinout_id: z.string().min(1),
      constraint_set_id: z.string().min(1),
      connector_mappings: z.array(z.object({
        product_connector: z.string().min(1),
        wib_connector: z.string().min(1),
        pin_map: z.array(z.object({ product_pin: z.string().min(1), wib_pin: z.string().min(1) })).min(1).optional()
      })).min(1).optional(),
      net_aliases: z.array(z.object({ product_net: z.string().min(1), wib_net: z.string().min(1) })).optional(),
      case_sensitive: z.boolean().default(false)
    },
    outputSchema: {
      kind: z.literal("WIB_DESIGN_QUALIFICATION"),
      id: z.string(),
      product_pinout_id: z.string(),
      wib_pinout_id: z.string(),
      constraint_set_id: z.string(),
      verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]),
      verification_mode: z.literal("DOCUMENT_BACKED"),
      wiring_analysis_id: z.string(),
      wiring_verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]),
      pass_count: z.number(),
      fail_count: z.number(),
      review_count: z.number(),
      not_applicable_count: z.number(),
      constraint_results: z.array(z.record(z.string(), z.unknown())),
      violations: z.array(z.record(z.string(), z.unknown())),
      report_uri: z.string(),
      report_path: z.string(),
      elapsed_ms: z.number()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ product_pinout_id, wib_pinout_id, constraint_set_id, connector_mappings, net_aliases, case_sensitive }, extra) => {
    await progress(extra, 0, 100, "Running closed-loop WIB wiring and hard-constraint qualification");
    const qualification = await qualifyWibDesign(product_pinout_id, wib_pinout_id, constraint_set_id, cacheDir, {
      ...(connector_mappings ? { connectorMappings: connector_mappings } : {}),
      ...(net_aliases ? { netAliases: net_aliases } : {}),
      caseSensitive: case_sensitive
    });
    await progress(extra, 100, 100, "Final WIB qualification report is ready");
    return {
      content: [
        { type: "text" as const, text: `Final WIB qualification ${qualification.id}: ${qualification.verdict}. PASS ${qualification.pass_count}, FAIL ${qualification.fail_count}, REVIEW ${qualification.review_count}.` },
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
      rule_pack: z.record(z.string(), z.unknown()),
      passage_count: z.number(),
      rule_count: z.number(),
      rag_index_path: z.string()
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ paths, title }, extra) => {
    await progress(extra, 0, 100, "Extracting local rule evidence");
    const extracted = await extractRulePack(paths, cacheDir, title);
    await core.request("save_rule_pack", { cache_dir: cacheDir, rule_pack: extracted.rulePack }, extra.signal);
    await progress(extra, 100, 100, "Draft rule pack created; human approval is still required");
    const structured = {
      rule_pack: extracted.rulePack,
      passage_count: extracted.passageCount,
      rule_count: extracted.ruleCount,
      rag_index_path: extracted.ragIndexPath
    };
    return toolResult(structured, `Created DRAFT rule pack ${extracted.rulePack.id} with ${extracted.ruleCount} candidate rules. It cannot run until approved in the Viewer.`);
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
