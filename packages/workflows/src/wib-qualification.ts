import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compareFixtureWiring,
  type ConnectorMapping,
  type DesignMetric,
  type NetAlias,
  type WiringAnalysis,
  type WiringVerdict
} from "./wiring.js";

export type ConstraintComparator = "EXACT" | "ALL" | "NONE" | "MAXIMUM" | "MINIMUM" | "RANGE";
export type ConstraintCheck = "WIRING_ONE_TO_ONE" | "NET_IDENTITY" | "COMPLETE_PIN_COVERAGE" | "NO_UNINTENDED_INTERCONNECT" | "NC_ISOLATION" | "DESIGN_METRIC" | "ENDPOINT_UNIQUENESS" | "NO_UNRESOLVED_BRANCH" | "PATH_COMPONENT_POLICY" | "ENDPOINT_PIN_MATCH";

export interface WibConstraintDefinition {
  id: string;
  area: string;
  requirement: string;
  check: ConstraintCheck;
  metric_id: string | null;
  comparator: ConstraintComparator;
  required_value: string | number | { min: number; max: number };
  unit: string | null;
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_IMPLEMENTATION_CONFIRMATION" | "MANUAL_FACTORY_CONFIRMATION";
  source_authority: string;
  scope?: { connector?: string; pin?: string; net_name?: string } | undefined;
  allowed_component_kinds?: Array<"CONNECTOR" | "IC" | "PASSIVE" | "PROTECTION" | "POWER" | "UNKNOWN"> | undefined;
  forbidden_component_refs?: string[] | undefined;
  expected_endpoint_refs?: string[] | undefined;
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

export interface WibConstraintResult {
  id: string;
  constraint_id: string;
  status: WiringVerdict;
  verification_mode: WibConstraintDefinition["verification_mode"];
  area: string;
  requirement: string;
  metric_id: string | null;
  comparator: ConstraintComparator;
  required_value: WibConstraintDefinition["required_value"];
  actual_value: string | number | null;
  unit: string | null;
  message: string;
  evidence: string[];
}

export interface WibQualification {
  schema_version: 1;
  kind: "WIB_DESIGN_QUALIFICATION";
  id: string;
  product_pinout_id: string;
  wib_pinout_id: string;
  constraint_set_id: string;
  verdict: WiringVerdict;
  verification_mode: "DOCUMENT_BACKED";
  wiring_analysis_id: string;
  wiring_verdict: WiringVerdict;
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  constraint_results: WibConstraintResult[];
  violations: Array<WibConstraintResult & { rule_id: string; title: string; severity: "ERROR" | "WARNING"; net_names: string[]; component_refs: string[] }>;
  report_uri: string;
  report_path: string;
  elapsed_ms: number;
}

export async function createWibConstraintSet(
  input: {
    title: string;
    revision: string;
    approvedBy: string;
    constraints: WibConstraintDefinition[];
  },
  cacheDir: string
): Promise<WibConstraintSet> {
  if (!input.title.trim() || !input.revision.trim() || !input.approvedBy.trim()) throw new Error("Constraint title, revision, and approved_by are required");
  if (!input.constraints.length) throw new Error("At least one WIB constraint is required");
  const constraints = validateConstraints(input.constraints);
  const contentHash = sha256(JSON.stringify(constraints));
  const constraintSet: WibConstraintSet = {
    schema_version: 1,
    id: `wib-constraints-${contentHash.slice(0, 18)}`,
    title: input.title.trim(),
    revision: input.revision.trim(),
    status: "APPROVED",
    approved_by: input.approvedBy.trim(),
    approved_at: new Date().toISOString(),
    content_hash: contentHash,
    constraints
  };
  const directory = path.join(cacheDir, "wib-constraints");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${safeSegment(constraintSet.id)}.json`), JSON.stringify(constraintSet, null, 2), "utf8");
  return constraintSet;
}

export async function readWibConstraintSet(id: string, cacheDir: string): Promise<WibConstraintSet> {
  return JSON.parse(await readFile(path.join(cacheDir, "wib-constraints", `${safeSegment(id)}.json`), "utf8")) as WibConstraintSet;
}

export async function qualifyWibDesign(
  productPinoutId: string,
  wibPinoutId: string,
  constraintSetId: string,
  cacheDir: string,
  options: { connectorMappings?: ConnectorMapping[]; netAliases?: NetAlias[]; caseSensitive?: boolean } = {}
): Promise<WibQualification> {
  const started = performance.now();
  const [wiring, constraintSet] = await Promise.all([
    compareFixtureWiring(productPinoutId, wibPinoutId, cacheDir, options),
    readWibConstraintSet(constraintSetId, cacheDir)
  ]);
  const product = wiring.product;
  const wib = wiring.wib;
  if (product.status !== "CONFIRMED" || wib.status !== "CONFIRMED") {
    // The comparison still runs to provide evidence, but the final verdict will remain REVIEW.
  }
  const wiringClosure: WibConstraintResult = {
    id: "qualification-mandatory-wiring",
    constraint_id: "MANDATORY-PRODUCT-WIB-WIRING",
    status: wiring.verdict === "PASS" ? "PASS" : wiring.verdict === "FAIL" ? "FAIL" : "REVIEW",
    verification_mode: "DOCUMENT_BACKED",
    area: "CONNECTIVITY",
    requirement: "The confirmed actual WIB schematic shall match the complete confirmed product interface pinout.",
    metric_id: null,
    comparator: "ALL",
    required_value: "PASS",
    actual_value: wiring.verdict,
    unit: null,
    message: wiring.verdict === "PASS" ? "Mandatory product-to-WIB wiring closure passed." : `Mandatory product-to-WIB wiring closure is ${wiring.verdict}; see ${wiring.id}.`,
    evidence: [`circuit://analysis/${wiring.id}/report`]
  };
  const results = [
    wiringClosure,
    ...constraintSet.constraints.map((constraint) => evaluateConstraint(constraint, wiring, wib.design_metrics ?? [], wib.status === "CONFIRMED"))
  ];
  const passCount = results.filter((result) => result.status === "PASS").length;
  const failCount = results.filter((result) => result.status === "FAIL").length;
  const reviewCount = results.filter((result) => result.status === "REVIEW").length;
  const notApplicableCount = results.filter((result) => result.status === "NOT_APPLICABLE").length;
  const verdict: WiringVerdict = failCount ? "FAIL" : reviewCount ? "REVIEW" : results.length && passCount === results.length ? "PASS" : "NOT_APPLICABLE";
  const identity = JSON.stringify({ product: product.confirmation?.content_hash, wib: wib.confirmation?.content_hash, constraints: constraintSet.content_hash, mappings: wiring.connector_mappings, aliases: wiring.net_aliases });
  const id = `wib-qualification-${sha256(identity).slice(0, 18)}`;
  const directory = path.join(cacheDir, "evidence", id);
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "report.html");
  const qualification: WibQualification = {
    schema_version: 1,
    kind: "WIB_DESIGN_QUALIFICATION",
    id,
    product_pinout_id: product.id,
    wib_pinout_id: wib.id,
    constraint_set_id: constraintSet.id,
    verdict,
    verification_mode: "DOCUMENT_BACKED",
    wiring_analysis_id: wiring.id,
    wiring_verdict: wiring.verdict,
    pass_count: passCount,
    fail_count: failCount,
    review_count: reviewCount,
    not_applicable_count: notApplicableCount,
    constraint_results: results,
    violations: results.filter((result) => result.status !== "PASS").map((result) => ({
      ...result,
      rule_id: result.constraint_id,
      title: result.requirement,
      severity: result.status === "FAIL" ? "ERROR" as const : "WARNING" as const,
      net_names: [],
      component_refs: []
    })),
    report_uri: `circuit://analysis/${id}/report`,
    report_path: reportPath,
    elapsed_ms: Math.round(performance.now() - started)
  };
  await writeFile(reportPath, renderQualificationReport(qualification, constraintSet, wiring), "utf8");
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(qualification, null, 2), "utf8");
  return qualification;
}

function evaluateConstraint(constraint: WibConstraintDefinition, wiring: WiringAnalysis, metrics: DesignMetric[], wibConfirmed: boolean): WibConstraintResult {
  const base = {
    id: `qualification-${safeSegment(constraint.id)}`,
    constraint_id: constraint.id,
    verification_mode: constraint.verification_mode,
    area: constraint.area,
    requirement: constraint.requirement,
    metric_id: constraint.metric_id,
    comparator: constraint.comparator,
    required_value: constraint.required_value,
    unit: constraint.unit,
    evidence: [constraint.source_authority]
  };
  if (constraint.verification_mode === "MANUAL_FACTORY_CONFIRMATION" || constraint.verification_mode === "MANUAL_IMPLEMENTATION_CONFIRMATION") {
    return { ...base, status: "REVIEW", actual_value: null, message: "The engineering-owned requirement baseline needs implementation confirmation from the actual tester, fixture, supplier/factory capability, selected part, deviations, or production evidence; schematics alone cannot close it." };
  }
  if (["ENDPOINT_UNIQUENESS", "NO_UNRESOLVED_BRANCH", "PATH_COMPONENT_POLICY", "ENDPOINT_PIN_MATCH"].includes(constraint.check)) {
    return evaluatePathConstraint(constraint, wiring, base);
  }
  if (constraint.check !== "DESIGN_METRIC") {
    const status = wiring.verdict === "PASS" ? "PASS" : wiring.verdict === "FAIL" ? "FAIL" : "REVIEW";
    return {
      ...base,
      status,
      actual_value: wiring.verdict,
      message: status === "PASS"
        ? `Confirmed product-to-WIB wiring satisfies ${constraint.check}.`
        : `Product-to-WIB wiring analysis is ${wiring.verdict}; see ${wiring.id}.`,
      evidence: [...base.evidence, `circuit://analysis/${wiring.id}/report`]
    };
  }
  if (!wibConfirmed) {
    return { ...base, status: "REVIEW", actual_value: null, message: "The WIB schematic design metric evidence is not CONFIRMED." };
  }
  if (!constraint.metric_id) return { ...base, status: "REVIEW", actual_value: null, message: "DESIGN_METRIC constraint has no metric_id." };
  const metric = metrics.find((candidate) => candidate.id.toLocaleUpperCase("en-US") === constraint.metric_id!.toLocaleUpperCase("en-US"));
  if (!metric) return { ...base, status: "REVIEW", actual_value: null, message: `WIB schematic has no confirmed design metric ${constraint.metric_id}.` };
  if ((constraint.unit ?? "").toLocaleUpperCase("en-US") !== (metric.unit ?? "").toLocaleUpperCase("en-US")) {
    return { ...base, status: "REVIEW", actual_value: metric.value, message: `Unit mismatch for ${constraint.metric_id}: required ${constraint.unit ?? "unitless"}, actual ${metric.unit ?? "unitless"}; no implicit conversion was applied.`, evidence: [...base.evidence, metric.evidence.source_path] };
  }
  const passed = compareValues(metric.value, constraint.required_value, constraint.comparator);
  if (passed == null) return { ...base, status: "REVIEW", actual_value: metric.value, message: `The ${constraint.comparator} comparison cannot be evaluated from the supplied value types.`, evidence: [...base.evidence, metric.evidence.source_path] };
  return {
    ...base,
    status: passed ? "PASS" : "FAIL",
    actual_value: metric.value,
    message: `${constraint.metric_id} actual ${formatValue(metric.value, metric.unit)} ${passed ? "satisfies" : "violates"} ${constraint.comparator} ${formatRequired(constraint.required_value, constraint.unit)}.`,
    evidence: [...base.evidence, metric.evidence.source_path]
  };
}

function evaluatePathConstraint(
  constraint: WibConstraintDefinition,
  wiring: WiringAnalysis,
  base: Omit<WibConstraintResult, "status" | "actual_value" | "message">
): WibConstraintResult {
  const connections = scopedConnections(constraint, wiring);
  const evidence = [...base.evidence, `circuit://analysis/${wiring.id}/report`];
  if (!connections.length) return { ...base, status: "REVIEW", actual_value: null, message: "No compared interface path matches this constraint scope.", evidence };
  const hasUnresolvedInput = connections.some((connection) => connection.verdict === "REVIEW");

  if (constraint.check === "ENDPOINT_UNIQUENESS" || constraint.check === "NO_UNRESOLVED_BRANCH") {
    const pathSides = connections.flatMap((connection) => [
      connection.product_path_id ? connection.product_endpoint_refs ?? [] : null,
      connection.wib_path_id ? connection.wib_endpoint_refs ?? [] : null
    ]).filter((item): item is string[] => item !== null);
    if (!pathSides.length) return { ...base, status: "REVIEW", actual_value: null, message: "No traced schematic path metadata is available for this constraint.", evidence };
    const unique = pathSides.every((endpoints) => endpoints.length === 1);
    if (!unique || hasUnresolvedInput) {
      return { ...base, status: "REVIEW", actual_value: pathSides.map((endpoints) => endpoints.length).join(","), message: "At least one path has zero, multiple, or otherwise unresolved chip endpoints; no endpoint was guessed.", evidence };
    }
    return { ...base, status: "PASS", actual_value: pathSides.length, message: `${pathSides.length} confirmed path side(s) each resolve to exactly one chip endpoint.`, evidence };
  }

  if (constraint.check === "PATH_COMPONENT_POLICY") {
    const refs = connections.flatMap((connection) => [...(connection.product_path_component_refs ?? []), ...(connection.wib_path_component_refs ?? [])]);
    const kinds = connections.flatMap((connection) => [...(connection.product_path_component_kinds ?? []), ...(connection.wib_path_component_kinds ?? [])]);
    if (!refs.length || hasUnresolvedInput) return { ...base, status: "REVIEW", actual_value: refs.join(", ") || null, message: "Path component evidence is missing or unresolved.", evidence };
    const forbidden = new Set((constraint.forbidden_component_refs ?? []).map(key));
    const forbiddenHits = refs.filter((ref) => forbidden.has(key(ref)));
    const allowed = new Set<string>(constraint.allowed_component_kinds ?? []);
    const disallowedKinds = allowed.size ? kinds.filter((kind) => kind !== "CONNECTOR" && kind !== "IC" && !allowed.has(kind)) : [];
    const violations = [...forbiddenHits, ...disallowedKinds];
    return violations.length
      ? { ...base, status: "FAIL", actual_value: violations.join(", "), message: `Confirmed path contains forbidden or non-allowed path elements: ${violations.join(", ")}.`, evidence }
      : { ...base, status: "PASS", actual_value: refs.join(", "), message: "Confirmed paths satisfy the allowed and forbidden path-component policy.", evidence };
  }

  const expected = [...new Set(constraint.expected_endpoint_refs ?? [])].sort(naturalCompare);
  if (!expected.length) return { ...base, status: "REVIEW", actual_value: null, message: "ENDPOINT_PIN_MATCH requires expected_endpoint_refs.", evidence };
  if (hasUnresolvedInput) return { ...base, status: "REVIEW", actual_value: null, message: "Endpoint matching cannot be adjudicated while a relevant path remains REVIEW.", evidence };
  const actual = [...new Set(connections.flatMap((connection) => connection.wib_endpoint_refs?.length ? connection.wib_endpoint_refs : connection.product_endpoint_refs ?? []))].sort(naturalCompare);
  if (!actual.length) return { ...base, status: "REVIEW", actual_value: null, message: "No resolved chip endpoint is available for matching.", evidence };
  const matches = actual.length === expected.length && actual.every((value, index) => key(value) === key(expected[index]!));
  return matches
    ? { ...base, status: "PASS", actual_value: actual.join(", "), message: `Confirmed chip endpoint set matches ${expected.join(", ")}.`, evidence }
    : { ...base, status: "FAIL", actual_value: actual.join(", "), message: `Confirmed chip endpoints ${actual.join(", ")} do not match expected ${expected.join(", ")}.`, evidence };
}

function scopedConnections(constraint: WibConstraintDefinition, wiring: WiringAnalysis) {
  if (!constraint.scope) return wiring.connections;
  return wiring.connections.filter((connection) => {
    const connectorMatches = !constraint.scope?.connector || [connection.product_connector, connection.wib_connector].some((value) => key(value) === key(constraint.scope!.connector!));
    const pinMatches = !constraint.scope?.pin || [connection.product_pin, connection.wib_pin].some((value) => key(value) === key(constraint.scope!.pin!));
    const netMatches = !constraint.scope?.net_name || [connection.product_net, connection.wib_net].some((value) => value != null && key(value) === key(constraint.scope!.net_name!));
    return connectorMatches && pinMatches && netMatches;
  });
}

function compareValues(actual: string | number, required: WibConstraintDefinition["required_value"], comparator: ConstraintComparator): boolean | null {
  if (comparator === "EXACT" || comparator === "ALL") return scalarKey(actual) === scalarKey(required);
  if (comparator === "NONE") return typeof actual === "number" ? actual === 0 : /^(0|none|no|false)$/i.test(actual.trim());
  if (typeof actual !== "number") return null;
  if (comparator === "MAXIMUM") return typeof required === "number" ? actual <= required : null;
  if (comparator === "MINIMUM") return typeof required === "number" ? actual >= required : null;
  if (comparator === "RANGE") return typeof required === "object" ? actual >= required.min && actual <= required.max : null;
  return null;
}

function validateConstraints(constraints: WibConstraintDefinition[]) {
  const seen = new Set<string>();
  const checks: ConstraintCheck[] = ["WIRING_ONE_TO_ONE", "NET_IDENTITY", "COMPLETE_PIN_COVERAGE", "NO_UNINTENDED_INTERCONNECT", "NC_ISOLATION", "DESIGN_METRIC", "ENDPOINT_UNIQUENESS", "NO_UNRESOLVED_BRANCH", "PATH_COMPONENT_POLICY", "ENDPOINT_PIN_MATCH"];
  const comparators: ConstraintComparator[] = ["EXACT", "ALL", "NONE", "MAXIMUM", "MINIMUM", "RANGE"];
  return constraints.map((constraint) => {
    if (!constraint.id.trim() || !constraint.area.trim() || !constraint.requirement.trim() || !constraint.source_authority.trim()) throw new Error("Every constraint needs id, area, requirement, and source_authority");
    const key = constraint.id.toLocaleUpperCase("en-US");
    if (seen.has(key)) throw new Error(`Duplicate WIB constraint ${constraint.id}`);
    seen.add(key);
    if (!checks.includes(constraint.check)) throw new Error(`${constraint.id} has an invalid check`);
    if (!comparators.includes(constraint.comparator)) throw new Error(`${constraint.id} has an invalid comparator`);
    if (!(["DOCUMENT_BACKED", "MANUAL_IMPLEMENTATION_CONFIRMATION", "MANUAL_FACTORY_CONFIRMATION"] as const).includes(constraint.verification_mode)) throw new Error(`${constraint.id} has an invalid verification_mode`);
    if (constraint.check === "DESIGN_METRIC" && !constraint.metric_id?.trim()) throw new Error(`${constraint.id} requires metric_id`);
    if (constraint.check === "DESIGN_METRIC" && !constraint.unit?.trim()) throw new Error(`${constraint.id} requires unit`);
    if (constraint.check === "ENDPOINT_PIN_MATCH" && !constraint.expected_endpoint_refs?.length) throw new Error(`${constraint.id} requires expected_endpoint_refs`);
    if (constraint.check === "PATH_COMPONENT_POLICY" && !constraint.allowed_component_kinds?.length && !constraint.forbidden_component_refs?.length) throw new Error(`${constraint.id} requires allowed_component_kinds or forbidden_component_refs`);
    if ((constraint.comparator === "MINIMUM" || constraint.comparator === "MAXIMUM") && (typeof constraint.required_value !== "number" || !Number.isFinite(constraint.required_value))) throw new Error(`${constraint.id} requires a finite numeric value`);
    if (constraint.comparator === "RANGE") {
      if (typeof constraint.required_value !== "object" || !Number.isFinite(constraint.required_value.min) || !Number.isFinite(constraint.required_value.max) || constraint.required_value.min > constraint.required_value.max) throw new Error(`${constraint.id} requires a valid {min,max} range`);
    }
    return {
      ...constraint,
      id: constraint.id.trim(),
      area: constraint.area.trim(),
      requirement: constraint.requirement.trim(),
      metric_id: constraint.metric_id?.trim() || null,
      unit: constraint.unit?.trim() || null,
      source_authority: constraint.source_authority.trim(),
      ...(constraint.scope ? { scope: {
        ...(constraint.scope.connector?.trim() ? { connector: constraint.scope.connector.trim() } : {}),
        ...(constraint.scope.pin?.trim() ? { pin: constraint.scope.pin.trim() } : {}),
        ...(constraint.scope.net_name?.trim() ? { net_name: constraint.scope.net_name.trim() } : {})
      } } : {}),
      ...(constraint.forbidden_component_refs ? { forbidden_component_refs: constraint.forbidden_component_refs.map((value) => value.trim()).filter(Boolean) } : {}),
      ...(constraint.expected_endpoint_refs ? { expected_endpoint_refs: constraint.expected_endpoint_refs.map((value) => value.trim()).filter(Boolean) } : {})
    };
  });
}

function renderQualificationReport(qualification: WibQualification, set: WibConstraintSet, wiring: WiringAnalysis) {
  const rows = qualification.constraint_results.map((result) => `<tr class="${result.status.toLowerCase()}"><td>${html(result.status)}</td><td>${html(result.constraint_id)}</td><td>${html(result.area)}</td><td>${html(result.requirement)}</td><td>${html(result.comparator)}</td><td>${html(formatRequired(result.required_value, result.unit))}</td><td>${html(result.actual_value == null ? "MISSING" : formatValue(result.actual_value, result.unit))}</td><td>${html(result.message)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>WIB qualification ${html(qualification.verdict)}</title><style>${css()}</style></head><body><main><header><div><p>CircuitInspector · CLOSED-LOOP WIB DESIGN REVIEW</p><h1>Final WIB design qualification</h1><span>${html(qualification.id)}</span></div><strong class="verdict ${qualification.verdict.toLowerCase()}">${html(qualification.verdict)}</strong></header><section class="metrics"><div><b>${qualification.pass_count}</b> PASS</div><div><b>${qualification.fail_count}</b> FAIL</div><div><b>${qualification.review_count}</b> REVIEW</div></section><section><h2>Controlled inputs</h2><ul><li>Product pinout: ${html(qualification.product_pinout_id)}</li><li>Actual WIB pinout: ${html(qualification.wib_pinout_id)}</li><li>Constraint set: ${html(set.id)} · revision ${html(set.revision)} · approved by ${html(set.approved_by)} · SHA-256 ${html(set.content_hash)}</li><li>Wiring analysis: <code>${html(wiring.id)}</code> · ${html(wiring.verdict)}</li></ul></section><section><h2>Hard-constraint results</h2><table><thead><tr><th>Status</th><th>ID</th><th>Area</th><th>Requirement</th><th>Comparator</th><th>Required</th><th>Actual</th><th>Evidence/result</th></tr></thead><tbody>${rows}</tbody></table></section><footer>PASS means every constraint in this approved set was evaluated with supported evidence and passed. Engineering owns each requirement baseline; the result does not extend to omitted constraints or implementation evidence not represented in the approved set.</footer></main></body></html>`;
}

function css() {
  return `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#111416;color:#ecebe7}body{margin:0}main{max-width:1380px;margin:auto;padding:38px}header{display:flex;justify-content:space-between;border-bottom:1px solid #2d3234;padding-bottom:24px}header p,header span,footer{color:#838a87;font:11px ui-monospace}h1{margin:8px 0}.verdict{padding:10px 18px;border-radius:999px;height:max-content}.verdict.pass{background:#263423;color:#a9c994}.verdict.fail{background:#422720;color:#f09884}.verdict.review{background:#3b321f;color:#e1bb73}.metrics{display:flex;gap:12px;margin:22px 0}.metrics div{flex:1;padding:18px;border:1px solid #2d3234;border-radius:10px;background:#171b1d;color:#8d9491}.metrics b{font-size:24px;color:#ecebe7;margin-right:8px}section{margin-top:26px}li{color:#a4aaa7;line-height:1.7}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #2a2f31}th{color:#8e9592;font:10px ui-monospace}tr.fail{background:#2c1e1b}tr.review{background:#292419}td:first-child{font-weight:700}footer{margin-top:30px;padding-top:20px;border-top:1px solid #2d3234;line-height:1.6}`;
}

function scalarKey(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().toLocaleUpperCase("en-US") : "";
}

function key(value: string) {
  return value.trim().toLocaleUpperCase("en-US");
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function formatRequired(value: WibConstraintDefinition["required_value"], unit: string | null) {
  const body = typeof value === "object" ? `${value.min}..${value.max}` : String(value);
  return `${body}${unit ? ` ${unit}` : ""}`;
}

function formatValue(value: string | number, unit: string | null) {
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid CircuitInspector identifier");
  return value;
}

function html(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
