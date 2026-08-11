import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AnalysisSummary,
  CoverageLevel,
  DesignSummary,
  Diagnostic,
  LayoutBaselineCheck,
  LayoutBaselineConfirmation,
  LayoutTestAccessAnalysis,
  ManufacturingTestRequirement,
  RulePack,
  TestAccessMapping,
  Verdict
} from "@circuit-inspector/contracts";
import { readManufacturingTestPlan } from "./test-recommendations.js";
import { readLayoutBaseline } from "./layout-baseline.js";

export interface TestPointSnapshot {
  id: string;
  center: { x: number; y: number };
  radius_nm: number | null;
  net_name: string | null;
  component_ref: string | null;
  confidence: CoverageLevel;
  layer_id: string | null;
  source: string;
  geometry_source: string | null;
}

export interface AnalyzeTestAccessInput {
  design: DesignSummary;
  testPoints: TestPointSnapshot[];
  geometryAnalysis: AnalysisSummary;
  rulePack: RulePack;
  testPlanId: string;
}

export async function analyzeTestAccess(input: AnalyzeTestAccessInput, cacheDir: string): Promise<LayoutTestAccessAnalysis> {
  const started = performance.now();
  const plan = await readManufacturingTestPlan(input.testPlanId, cacheDir);
  const layoutBaseline = await readLayoutBaseline(input.design.id, cacheDir);
  if (plan.lifecycle_status !== "APPROVED" || !plan.approval) throw new Error(`test plan ${plan.id} must be APPROVED before Layout test-access analysis`);
  if (input.rulePack.status !== "APPROVED" || !input.rulePack.approval) throw new Error(`rule pack ${input.rulePack.id} must be APPROVED before Layout test-access analysis`);
  if (input.geometryAnalysis.design_id !== input.design.id) throw new Error("geometry analysis and imported design do not match");
  if (input.geometryAnalysis.rule_pack_id !== input.rulePack.id) throw new Error("geometry analysis and rule pack do not match");

  const diagnostics: Diagnostic[] = [];
  let forceReview = false;
  const baselineChecks = buildBaselineChecks(input.design, plan, layoutBaseline);
  if (baselineChecks.some((item) => item.status !== "PASS")) {
    forceReview = true;
    diagnostics.push({ code: "LAYOUT_BASELINE_CONFIRMATION_OPEN", severity: "WARNING", message: "Product revision, variant/panel, coordinates, viewing direction, step-repeat, or semantic coverage is not fully confirmed for this exact ODB++ hash." });
  }
  if (plan.baseline.approved_rule_pack_id !== input.rulePack.id) {
    forceReview = true;
    diagnostics.push({ code: "TEST_PLAN_RULE_PACK_MISMATCH", severity: "WARNING", message: `Approved test plan is bound to ${plan.baseline.approved_rule_pack_id ?? "no rule pack"}, but Layout analysis used ${input.rulePack.id}.` });
  }
  if (input.design.diagnostics.some((item) => item.code === "DATA_CONFLICT" || item.code.includes("CONFLICT"))) {
    forceReview = true;
    diagnostics.push({ code: "LAYOUT_DATA_CONFLICT", severity: "WARNING", message: "Imported manufacturing data contains a conflict; affected test-access conclusions remain REVIEW." });
  }
  if (input.design.semantic_coverage.test_points === "MISSING" || input.design.semantic_coverage.nets === "MISSING") {
    forceReview = true;
    diagnostics.push({ code: "TEST_ACCESS_SEMANTICS_MISSING", severity: "WARNING", message: "Formal physical-access closure requires both test-point and net semantics." });
  }

  const mappings = plan.requirements.map((requirement) => mapRequirement(requirement, input));
  const mappingCounts = verdictCounts(mappings);
  const baselineCounts = verdictCounts(baselineChecks);
  const counts = {
    pass: mappingCounts.pass + baselineCounts.pass,
    fail: mappingCounts.fail + baselineCounts.fail,
    review: mappingCounts.review + baselineCounts.review,
    notApplicable: mappingCounts.notApplicable + baselineCounts.notApplicable
  };
  const verdict: Verdict = counts.fail > 0
    ? "FAIL"
    : forceReview || counts.review > 0
      ? "REVIEW"
      : counts.pass > 0
        ? "PASS"
        : "NOT_APPLICABLE";
  const id = `test-access-${createHash("sha256").update(JSON.stringify({
    design: input.design.content_hash,
    plan: plan.approval.content_hash,
    rule_pack: input.rulePack.approval.content_hash,
    layout_baseline: layoutBaseline?.content_hash ?? null,
    geometry: input.geometryAnalysis.id
  })).digest("hex").slice(0, 20)}`;
  const directory = path.join(cacheDir, "evidence", safeSegment(id));
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "report.html");
  const factoryConfirmationItems: LayoutTestAccessAnalysis["factory_confirmation_items"] = [
    factoryItem("FACTORY-CONTACT-REPEATABILITY", "Confirm probe/contact repeatability and contact resistance on the actual fixture and product finish.", "Fixture trial data, contact-resistance limits, repeated measurements, approver, and matching product/line revision."),
    factoryItem("FACTORY-BOARD-DEFLECTION", "Confirm support, clamp force, panel effects, and board deflection under the production probe load.", "Fixture mechanical review plus measured deflection/support evidence on the released panel or unit form."),
    factoryItem("FACTORY-TESTER-CAPACITY", "Confirm tester sources, measurements, grounds, guards, loads, switching resources, and parallel-site capacity.", "Released station configuration, resource allocation, margin, and factory/test-engineering approval."),
    factoryItem("FACTORY-POWERED-SAFETY", "Confirm current limiting, sequencing, back-power prevention, interlocks, discharge, and safe teardown.", "Witnessed powered pilot logs and safety approval for the exact fixture/station revision."),
    factoryItem("FACTORY-THROUGHPUT-REPEATABILITY", "Confirm cycle time, retry policy, measurement-system capability, and deterministic state cleanup.", "Pilot cycle-time data, repeatability or GR&R evidence as applicable, and approved retry/quarantine rules."),
    factoryItem("FACTORY-PILOT-ACCEPTANCE", "Confirm known-fault detection, fault localization, pilot yield, repair feedback, and production release.", "Known-fault or seeded-defect results, pilot summary, issue closure, and signed production-test release."),
  ];
  const analysis: LayoutTestAccessAnalysis = {
    schema_version: 1,
    kind: "LAYOUT_TEST_ACCESS_ANALYSIS",
    id,
    design_id: input.design.id,
    design_content_hash: input.design.content_hash,
    test_plan_id: plan.id,
    test_plan_content_hash: plan.approval.content_hash,
    rule_pack_id: input.rulePack.id,
    rule_pack_content_hash: input.rulePack.approval.content_hash,
    layout_baseline_confirmation_id: layoutBaseline?.id ?? null,
    layout_baseline_content_hash: layoutBaseline?.content_hash ?? null,
    geometry_analysis_id: input.geometryAnalysis.id,
    verdict,
    production_readiness_verdict: "REVIEW",
    pass_count: counts.pass,
    fail_count: counts.fail,
    review_count: counts.review,
    not_applicable_count: counts.notApplicable,
    baseline_checks: baselineChecks,
    mappings,
    factory_confirmation_items: factoryConfirmationItems,
    diagnostics,
    report_uri: `circuit://analysis/${id}/report`,
    report_path: reportPath,
    elapsed_ms: Math.round(performance.now() - started)
  };
  await writeFile(reportPath, renderReport(analysis, plan.baseline, input.design, input.geometryAnalysis), "utf8");
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
  return analysis;
}

function buildBaselineChecks(
  design: DesignSummary,
  plan: Awaited<ReturnType<typeof readManufacturingTestPlan>>,
  confirmation: LayoutBaselineConfirmation | null
): LayoutBaselineCheck[] {
  const exactBinding = Boolean(confirmation
    && confirmation.design_id === design.id
    && confirmation.design_content_hash === design.content_hash
    && confirmation.test_plan_id === plan.id
    && confirmation.test_plan_content_hash === plan.approval?.content_hash);
  const checks: LayoutBaselineCheck[] = [
    baselineCheck("ODBPP-FORMAT", design.format === "ODBPP" ? "PASS" : "REVIEW", "Use an ODB++ manufacturing package for formal Layout DFT closure.", design.format, design.format === "ODBPP" ? "The imported design is ODB++." : "Gerber-package geometry can support review, but not the requested ODB++ semantic closure."),
    baselineCheck("EXACT-CONTENT-BINDING", exactBinding ? "PASS" : "REVIEW", "Bind the exact ODB++ SHA-256 to the approved DFT baseline.", confirmation?.design_content_hash ?? "MISSING", exactBinding ? "The controlled confirmation matches this design and approved DFT plan hash." : "Approve a Layout baseline confirmation for this exact design and test-plan hash."),
    baselineCheck("PRODUCT-REVISION", exactBinding && confirmation?.product_revision === plan.baseline.product_revision ? "PASS" : "REVIEW", "Confirm the ODB++ product revision matches the approved DFT baseline.", confirmation?.product_revision ?? "MISSING", exactBinding ? "The recorded product revision matches the approved DFT baseline." : "Product revision linkage is not confirmed for this exact ODB++ hash."),
    baselineCheck("VARIANT-PANEL", exactBinding && confirmation?.variant === plan.baseline.variant && confirmation?.panel === plan.baseline.panel ? "PASS" : "REVIEW", "Confirm the applicable Variant and Panel form.", confirmation ? `${confirmation.variant ?? "N/A"} / ${confirmation.panel ?? "N/A"}` : "MISSING", exactBinding ? "Variant and Panel values match the approved DFT baseline." : "Variant/Panel applicability is not confirmed for this exact ODB++ hash."),
    baselineCheck("COORDINATE-UNITS-ORIGIN", exactBinding ? "PASS" : "REVIEW", "Confirm source units and the controlled coordinate origin before correlating fixture evidence.", confirmation ? `${confirmation.source_units} / ${confirmation.coordinate_origin}` : "MISSING", exactBinding ? "Units and origin are recorded in the controlled Layout baseline." : "Source units or coordinate origin confirmation is missing."),
    baselineCheck("TOP-BOTTOM-ORIENTATION", exactBinding ? "PASS" : "REVIEW", "Confirm Top/Bottom viewing direction and mirror convention.", confirmation ? `${confirmation.top_view_direction} / ${confirmation.bottom_view_direction} / mirrored-in-top-view=${confirmation.bottom_mirrored_in_top_view}` : "MISSING", exactBinding ? "The contact-view orientation and mirror convention are recorded." : "Top/Bottom direction and mirror convention are not confirmed."),
    baselineCheck("PANEL-STEP-REPEAT", exactBinding ? "PASS" : "REVIEW", "Confirm Panel step-repeat or explicitly record unit-board applicability.", confirmation?.panel_step_repeat ?? "MISSING", exactBinding ? "Panel step-repeat applicability is recorded." : "Panel step-repeat applicability is not confirmed.")
  ];
  for (const [field, coverage] of Object.entries(design.semantic_coverage)) {
    const status = sufficient(coverage) ? "PASS" : "REVIEW";
    checks.push(baselineCheck(`SEMANTIC-${field.toLocaleUpperCase("en-US").replaceAll("_", "-")}`, status, `Confirm ${field.replaceAll("_", " ")} semantic coverage.`, coverage, status === "PASS" ? "Imported semantics are explicit or supplemented." : "Inferred or missing semantics cannot support an authoritative closure."));
  }
  return checks;
}

function baselineCheck(id: string, status: "PASS" | "REVIEW", requirement: string, recordedValue: string, message: string): LayoutBaselineCheck {
  return { id, status, verification_mode: "DOCUMENT_BACKED", requirement, recorded_value: recordedValue, message };
}

function mapRequirement(requirement: ManufacturingTestRequirement, input: AnalyzeTestAccessInput): TestAccessMapping {
  const evidence = requirement.source_evidence.map((item) => `${item.source_path}#${item.page ?? "-"}`);
  if (!requirement.physical_access_required) {
    return {
      id: `access-${requirement.id}`,
      requirement_id: requirement.id,
      status: "NOT_APPLICABLE",
      verification_mode: "DOCUMENT_BACKED",
      target_net_names: requirement.target_net_names,
      target_functions: requirement.target_functions,
      access_strategy: requirement.access_strategy,
      physical_access_required: false,
      matched_test_points: [],
      geometry_violation_ids: [],
      message: `${requirement.access_strategy} is the approved access strategy; a physical PCB pad is not required by this DFT baseline. Method execution remains a separate evidence lane.`,
      evidence
    };
  }

  const allowedLayers = new Map(input.design.layers.map((layer) => [layer.id, layer.side]));
  const targetNets = new Set(requirement.target_net_names.map(key));
  const candidates = input.testPoints.filter((point) => point.net_name && targetNets.has(key(point.net_name)));
  const sideEligible = candidates.filter((point) => {
    const side = testPointSide(point, input.design, allowedLayers);
    return side === "TOP" || side === "BOTTOM" ? requirement.allowed_sides.includes(side) : false;
  });
  const matched = sideEligible.map((point) => ({
    id: point.id,
    net_name: point.net_name,
    component_ref: point.component_ref,
    layer_id: point.layer_id,
    side: testPointSide(point, input.design, allowedLayers),
    confidence: point.confidence,
    x_nm: point.center.x,
    y_nm: point.center.y
  }));
  const semanticSufficient = sufficient(input.design.semantic_coverage.nets) && sufficient(input.design.semantic_coverage.test_points);
  const relatedViolations = testPointViolations(requirement, matched.map((item) => item.component_ref), input);
  let status: Verdict;
  let message: string;
  if (!matched.length) {
    const hasUnknownCandidateSide = candidates.some((point) => testPointSide(point, input.design, allowedLayers) === "NA");
    status = semanticSufficient && !hasUnknownCandidateSide ? "FAIL" : "REVIEW";
    message = semanticSufficient && !hasUnknownCandidateSide
      ? `No ${requirement.allowed_sides.join("/")} physical test target was found for ${requirement.target_net_names.join(", ")} even though net, test-point, and side semantics are sufficient.`
      : hasUnknownCandidateSide
        ? `A NET-matched candidate exists for ${requirement.target_net_names.join(", ")}, but its Top/Bottom identity is not explicit; side was not guessed.`
        : `No physical target was matched for ${requirement.target_net_names.join(", ")}, but imported net/test-point semantics are not sufficient for a deterministic missing-target failure.`;
  } else if (matched.some((item) => item.confidence === "INFERRED" || item.confidence === "MISSING")) {
    status = "REVIEW";
    message = `${matched.length} candidate target(s) were found, but at least one identity is inferred and requires confirmation.`;
  } else if (relatedViolations.some((item) => item.verdict === "FAIL")) {
    status = "FAIL";
    message = `${matched.length} physical target(s) were found, but ${relatedViolations.filter((item) => item.verdict === "FAIL").length} approved-rule geometry violation(s) block access release.`;
  } else if (relatedViolations.some((item) => item.verdict === "REVIEW")) {
    status = "REVIEW";
    message = `${matched.length} physical target(s) were found; geometry or semantic review remains open.`;
  } else {
    status = "PASS";
    message = `${matched.length} explicit physical target(s) were found on the allowed side(s), with no matching approved-rule geometry violation.`;
  }
  return {
    id: `access-${requirement.id}`,
    requirement_id: requirement.id,
    status,
    verification_mode: "AUTOMATED_GEOMETRY",
    target_net_names: requirement.target_net_names,
    target_functions: requirement.target_functions,
    access_strategy: requirement.access_strategy,
    physical_access_required: true,
    matched_test_points: matched,
    geometry_violation_ids: relatedViolations.map((item) => item.id),
    message,
    evidence: [...evidence, ...relatedViolations.flatMap((item) => item.evidence_uris)]
  };
}

function testPointSide(
  point: TestPointSnapshot,
  design: DesignSummary,
  allowedLayers = new Map(design.layers.map((layer) => [layer.id, layer.side]))
): "TOP" | "BOTTOM" | "INNER" | "NA" {
  if (point.layer_id) return allowedLayers.get(point.layer_id) ?? "NA";
  const source = point.source.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  const matches = design.layers.filter((layer) => {
    const id = layer.id.toLocaleLowerCase("en-US");
    const name = layer.name.toLocaleLowerCase("en-US");
    return source.includes(`/layers/${id}/`) || source.includes(`/layers/${name}/`) || source.startsWith(`manual:${id}:`);
  });
  const sides = [...new Set(matches.map((layer) => layer.side))];
  return sides.length === 1 ? sides[0]! : "NA";
}

function testPointViolations(requirement: ManufacturingTestRequirement, componentRefs: Array<string | null>, input: AnalyzeTestAccessInput) {
  const targetNets = new Set(requirement.target_net_names.map(key));
  const refs = new Set(componentRefs.filter((value): value is string => Boolean(value)).map(key));
  const testPointRules = new Set(input.rulePack.rules.filter((rule) => rule.source === "TEST_POINT" || rule.target === "TEST_POINT").map((rule) => rule.id));
  return input.geometryAnalysis.violations.filter((violation) => {
    if (!testPointRules.has(violation.rule_id)) return false;
    if (violation.net_names.some((net) => targetNets.has(key(net)))) return true;
    if (violation.component_refs.some((reference) => refs.has(key(reference)))) return true;
    return violation.net_names.length === 0 && violation.component_refs.length === 0 && violation.verdict === "REVIEW";
  });
}

function verdictCounts(items: Array<{ status: Verdict }>) {
  return {
    pass: items.filter((item) => item.status === "PASS").length,
    fail: items.filter((item) => item.status === "FAIL").length,
    review: items.filter((item) => item.status === "REVIEW").length,
    notApplicable: items.filter((item) => item.status === "NOT_APPLICABLE").length
  };
}

function factoryItem(id: string, requirement: string, closureEvidence: string): LayoutTestAccessAnalysis["factory_confirmation_items"][number] {
  return { id, status: "REVIEW", verification_mode: "MANUAL_FACTORY_CONFIRMATION", requirement, closure_evidence: closureEvidence };
}

function renderReport(
  analysis: LayoutTestAccessAnalysis,
  baseline: { product_revision: string | null; variant: string | null; panel: string | null; factory: string | null; line: string | null; tester: string | null },
  design: DesignSummary,
  geometry: AnalysisSummary
) {
  const rows = analysis.mappings.map((mapping) => `<tr class="${mapping.status.toLowerCase().replaceAll("_", "-")}"><td>${html(mapping.status)}</td><td><code>${html(mapping.requirement_id)}</code></td><td>${html(mapping.target_net_names.join(", ") || mapping.target_functions.join(", ") || "-")}</td><td>${html(mapping.access_strategy)}</td><td>${mapping.physical_access_required ? "YES" : "NO"}</td><td>${mapping.matched_test_points.map((point) => `<code>${html(point.component_ref ?? point.id)} · ${html(point.side)} · ${html(point.confidence)}</code>`).join(" ") || "-"}</td><td>${html(mapping.geometry_violation_ids.join(", ") || "-")}</td><td>${html(mapping.message)}</td></tr>`).join("");
  const diagnostics = analysis.diagnostics.map((item) => `<li><strong>${html(item.code)}</strong> — ${html(item.message)}</li>`).join("") || "<li>No input conflict diagnostic was raised.</li>";
  const baselineChecks = analysis.baseline_checks.map((item) => `<tr class="${item.status.toLowerCase()}"><td>${html(item.status)}</td><td><code>${html(item.id)}</code></td><td>${html(item.requirement)}</td><td>${html(item.recorded_value)}</td><td>${html(item.message)}</td></tr>`).join("");
  const factory = analysis.factory_confirmation_items.map((item) => `<tr><td>REVIEW</td><td><code>${html(item.id)}</code></td><td>${html(item.requirement)}</td><td>${html(item.closure_evidence)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Layout DFT test-access ${html(analysis.verdict)}</title><style>${css()}</style></head><body><main><header><div><p>CircuitInspector · CLOSED-LOOP LAYOUT DFT</p><h1>Requirement-to-access trace matrix</h1><span>${html(analysis.id)}</span></div><strong class="verdict ${analysis.verdict.toLowerCase()}">${html(analysis.verdict)}</strong></header><section><h2>Controlled baseline</h2><ul><li>Product revision: ${html(baseline.product_revision ?? "not supplied")} · variant ${html(baseline.variant ?? "N/A")} · panel ${html(baseline.panel ?? "N/A")}</li><li>Factory: ${html(baseline.factory ?? "not assigned")} · line ${html(baseline.line ?? "not assigned")} · tester ${html(baseline.tester ?? "not assigned")}</li><li>Design: ${html(design.id)} · SHA-256 ${html(design.content_hash)} · ${html(design.format)}</li><li>Layout baseline: ${html(analysis.layout_baseline_confirmation_id ?? "MISSING")} · SHA-256 ${html(analysis.layout_baseline_content_hash ?? "MISSING")}</li><li>Approved DFT plan: ${html(analysis.test_plan_id)} · SHA-256 ${html(analysis.test_plan_content_hash)}</li><li>Approved rule pack: ${html(analysis.rule_pack_id)} · SHA-256 ${html(analysis.rule_pack_content_hash)} · geometry analysis <code>${html(geometry.id)}</code> · ${html(geometry.verdict)}</li></ul></section><section class="metrics"><div><b>${analysis.pass_count}</b> PASS</div><div><b>${analysis.fail_count}</b> FAIL</div><div><b>${analysis.review_count}</b> REVIEW</div><div><b>${analysis.not_applicable_count}</b> N/A</div></section><section><h2>Layout baseline and semantic checks</h2><table><thead><tr><th>Status</th><th>ID</th><th>Requirement</th><th>Recorded value</th><th>Decision</th></tr></thead><tbody>${baselineChecks}</tbody></table></section><section><h2>Input diagnostics</h2><ul>${diagnostics}</ul></section><section><h2>Approved requirement → Layout access</h2><table><thead><tr><th>Status</th><th>Requirement</th><th>NET</th><th>Strategy</th><th>Physical</th><th>Matched targets</th><th>Geometry findings</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Factory confirmation required before production release</h2><p>Static Layout qualification does not close these production dependencies. Production readiness remains REVIEW.</p><table><thead><tr><th>Status</th><th>ID</th><th>Requirement</th><th>Closure evidence</th></tr></thead><tbody>${factory}</tbody></table></section><footer>PASS applies only to the implemented Layout test-access scope under the recorded approved rule pack. It is not fixture, powered, throughput, pilot-yield, or production acceptance.</footer></main></body></html>`;
}

function css() {
  return `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#111416;color:#ecebe7}body{margin:0}main{max-width:1500px;margin:auto;padding:38px}header{display:flex;justify-content:space-between;border-bottom:1px solid #2d3234;padding-bottom:24px}header p,header span,footer{color:#838a87;font:11px ui-monospace}h1{margin:8px 0}.verdict{padding:10px 18px;border-radius:999px;height:max-content}.verdict.pass{background:#263423;color:#a9c994}.verdict.fail{background:#422720;color:#f09884}.verdict.review{background:#3b321f;color:#e1bb73}.metrics{display:flex;gap:12px;margin:22px 0}.metrics div{flex:1;padding:18px;border:1px solid #2d3234;border-radius:10px;background:#171b1d;color:#8d9491}.metrics b{font-size:24px;color:#ecebe7;margin-right:8px}section{margin-top:26px}li,p{color:#a4aaa7;line-height:1.7}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #2a2f31}th{color:#8e9592;font:10px ui-monospace}tr.fail{background:#2c1e1b}tr.review{background:#292419}code{display:inline-block;margin:2px;padding:3px 6px;border:1px solid #343b3d;border-radius:5px;color:#b7c7c3;background:#101315}footer{margin-top:30px;padding-top:20px;border-top:1px solid #2d3234;line-height:1.6}`;
}

function sufficient(value: CoverageLevel) {
  return value === "EXPLICIT" || value === "SUPPLEMENTED";
}

function key(value: string) {
  return value.trim().toLocaleUpperCase("en-US");
}

function safeSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid CircuitInspector identifier");
  return value;
}

function html(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
