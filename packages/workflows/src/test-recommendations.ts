import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { invalidateDependentAnalyses } from "./invalidation.js";
import type {
  ControlledTestBaseline,
  ManufacturingTestMethod,
  ManufacturingTestPlan as ContractManufacturingTestPlan,
  ManufacturingTestRequirement,
  TestMethodCoverage,
  TestPlanApproval
} from "@circuit-inspector/contracts";
import { readAnalysisPinout, type PinoutDocument } from "./wiring.js";

export type { ManufacturingTestRequirement, TestMethodCoverage } from "@circuit-inspector/contracts";

export interface ManufacturingTestRecommendation {
  id: string;
  status: "REVIEW";
  verification_mode: "DOCUMENT_BACKED";
  category: "POWER" | "GROUND" | "PROGRAMMING_DEBUG" | "RESET_BOOT" | "CLOCK" | "DIGITAL_INTERFACE" | "ANALOG_SENSOR" | "ACTUATOR_SAFETY" | "GENERAL_SIGNAL";
  priority: "HIGH" | "MEDIUM";
  title: string;
  net_names: string[];
  schematic_evidence: Array<{ connector: string; pin: string; net_name: string; page: number | null; excerpt: string }>;
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
  verification_mode: "DOCUMENT_BACKED";
  category: ManufacturingTestRecommendation["category"];
  priority: "HIGH" | "MEDIUM";
  title: string;
  related_net_names: string[];
  recommendation: string;
  rationale: string;
  validation_needed: string;
}

export interface TestPlanApprovalInput {
  approvedBy: string;
  variant?: string | null;
  panel?: string | null;
  factory: string;
  line: string;
  tester: string;
  approvedRulePackId: string;
}

export interface WibDesignConstraint {
  id: string;
  status: "REVIEW";
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_FACTORY_CONFIRMATION";
  requirement_level: "HARD";
  area: "CONNECTIVITY" | "ELECTRICAL" | "SIGNAL_INTEGRITY" | "MEASUREMENT" | "FIXTURE_GEOMETRY" | "MECHANICAL" | "TESTER_CAPACITY" | "THROUGHPUT";
  requirement: string;
  metric: string;
  comparator: "EXACT" | "ALL" | "NONE" | "MAXIMUM" | "MINIMUM" | "RANGE" | "TO_BE_DEFINED";
  required_value: string | number | null;
  unit: string | null;
  source_authority: string;
  related_net_names: string[];
  owner: string;
  closure_evidence: string;
}

export interface ManufacturingTestPlan extends Omit<ContractManufacturingTestPlan, "product" | "recommendations" | "wib_design_recommendations" | "wib_constraints" | "diagnostics"> {
  product: PinoutDocument;
  recommendations: ManufacturingTestRecommendation[];
  wib_design_recommendations: WibDesignRecommendation[];
  wib_constraints: WibDesignConstraint[];
  diagnostics: Array<{ code: string; severity: "INFO" | "WARNING" | "ERROR"; message: string }>;
  elapsed_ms: number;
}

interface RecommendationTemplate {
  category: ManufacturingTestRecommendation["category"];
  priority: ManufacturingTestRecommendation["priority"];
  title: string;
  matches: (net: string) => boolean;
  rationale: string;
  suggestedTest: string;
  stimulus: string;
  observation: string;
  missingInputs: string[];
  closureEvidence: string;
}

const templates: RecommendationTemplate[] = [
  {
    category: "GROUND",
    priority: "HIGH",
    title: "Ground and measurement-reference integrity",
    matches: (net) => /(^|[_/.-])(gnd|ground|vss|agnd|dgnd|pgnd)([_/.-]|$)/i.test(net),
    rationale: "Manufacturing measurements need a known return path, and open or resistive ground connections can mask many downstream failures.",
    suggestedTest: "Verify continuity and the intended separation or joining of ground domains before powered tests.",
    stimulus: "Use the approved low-energy continuity or resistance method for the assembly and fixture.",
    observation: "Record resistance or continuity result between each required ground domain and the station reference.",
    missingInputs: ["Schematic ground-domain intent", "Factory resistance limits", "Fixture ground and guard strategy"],
    closureEvidence: "Approved limits plus fixture/station trial data for the exact product and line revision."
  },
  {
    category: "POWER",
    priority: "HIGH",
    title: "Power-rail voltage, current, sequencing, and short protection",
    matches: (net) => /(^|[_/.-])(vcc|vdd|vbat|vin|vout|[+-]?\d+(?:v\d+|v)|pwr|power|supply)([_/.-]|$)/i.test(net),
    rationale: "Power faults can damage the unit or invalidate every functional test that follows.",
    suggestedTest: "Use current-limited power-up, rail-voltage checks, current consumption, sequencing, discharge, and short detection as applicable.",
    stimulus: "Apply the approved supply profile with current limiting and deterministic shutdown.",
    observation: "Capture rail voltage, current, sequence timing, brownout or power-good state, and discharge behavior.",
    missingInputs: ["Power tree and nominal rail values", "Current and timing limits", "Safe injection points", "Back-powering constraints"],
    closureEvidence: "Electrical limits, station configuration, and powered pilot evidence approved by hardware and test engineering."
  },
  {
    category: "PROGRAMMING_DEBUG",
    priority: "HIGH",
    title: "Programming, debug-chain, and production identity access",
    matches: (net) => /(jtag|swd|swclk|swdio|tck|tms|tdi|tdo|trst|isp|icsp|program|prog|debug)/i.test(net),
    rationale: "Blank, corrupt, wrong-version, or incorrectly secured devices are manufacturing fault classes that need an executable production flow.",
    suggestedTest: "Verify target detection, image identity, programming, read-back, unique identity, retry/recovery, and final security state.",
    stimulus: "Drive the documented programming/debug protocol in the required reset, boot, and power state.",
    observation: "Log device identity, image hash/version, programming result, verification result, and serialized unit identity without exposing secrets.",
    missingInputs: ["Exact device/package and programming algorithm", "Image and configuration authority", "Security/lock sequence", "Recovery and quarantine rules"],
    closureEvidence: "Successful station execution with traceable image, device, fixture, and unit records."
  },
  {
    category: "RESET_BOOT",
    priority: "HIGH",
    title: "Reset, enable, boot-strap, and deterministic test-state control",
    matches: (net) => /(reset|rst|por|boot|strap|enable|_en$|^en_|mode|testmode|test_mode)/i.test(net),
    rationale: "The line must place the assembly in known states and recover cleanly after a failed step.",
    suggestedTest: "Exercise reset and boot/test-mode transitions, verify default pulls, and confirm cleanup between units.",
    stimulus: "Drive only the documented safe reset, enable, or strap combinations with controlled timing.",
    observation: "Observe reset release, boot mode, power-good dependencies, startup state, and recovery behavior.",
    missingInputs: ["Reset/boot timing requirements", "Pull-state and blank-device behavior", "Allowed fixture drive conditions"],
    closureEvidence: "Approved state-transition procedure and repeatable station logs from pilot hardware."
  },
  {
    category: "CLOCK",
    priority: "HIGH",
    title: "Clock and oscillator startup",
    matches: (net) => /(clk|clock|xtal|xosc|osc|mclk|refclk)/i.test(net),
    rationale: "Missing or out-of-limit clocks can make digital and communication failures appear unrelated.",
    suggestedTest: "Verify required clock presence, frequency, startup, and stability using a loading-safe method.",
    stimulus: "Place the product in the documented state that enables the clock without contending with the circuit.",
    observation: "Measure or functionally infer the required clock characteristics with calibrated station resources.",
    missingInputs: ["Nominal frequency and tolerance", "Allowed measurement loading", "Startup and stability limits"],
    closureEvidence: "Instrument method, uncertainty, fixture-loss assessment, and approved production limits."
  },
  {
    category: "DIGITAL_INTERFACE",
    priority: "MEDIUM",
    title: "Digital communication and connector path",
    matches: (net) => /(i2c|scl|sda|spi|mosi|miso|sck|uart|usart|tx|rx|can|lin|usb|ethernet|eth|mdio|mdc|rs232|rs485|pcie|hdmi)/i.test(net),
    rationale: "Assembly opens, shorts, swapped pairs, pull-state errors, translators, and connector faults need both stimulus and observation.",
    suggestedTest: "Run a protocol-aware loopback, known-peripheral transaction, or boundary-scan/interconnect test that localizes failures by interface.",
    stimulus: "Use a compatible fixture endpoint at the documented voltage domain, speed, termination, and product state.",
    observation: "Log link/transaction result, error counters, expected data, and any analog integrity measurement required by the product risk.",
    missingInputs: ["Protocol and voltage-domain definition", "Expected transaction or loopback", "Termination and speed limits", "Variant behavior"],
    closureEvidence: "Validated fixture endpoint and repeatable interface test on known-good and representative fault units."
  },
  {
    category: "ANALOG_SENSOR",
    priority: "MEDIUM",
    title: "Analog, sensor, reference, and calibration path",
    matches: (net) => /(adc|dac|analog|ain|aout|sense|sensor|therm|temp|ntc|current_sense|voltage_sense|vref|refout|cal)/i.test(net),
    rationale: "Nominal digital operation does not prove analog accuracy, sensor connectivity, reference integrity, or calibration.",
    suggestedTest: "Apply traceable stimuli at representative points, capture raw values, and perform required calibration or range checks.",
    stimulus: "Use the approved source, simulated sensor, load, or golden peripheral with known fixture/cable effects.",
    observation: "Record raw measurement, converted value, limit, uncertainty, calibration coefficients, and environmental conditions as applicable.",
    missingInputs: ["Input/output ranges and tolerances", "Calibration procedure", "Instrument uncertainty and guard-band policy", "Environmental assumptions"],
    closureEvidence: "Approved limits and GR&R or equivalent measurement-system evidence for the station."
  },
  {
    category: "ACTUATOR_SAFETY",
    priority: "HIGH",
    title: "Hazardous output, load, actuator, and protection behavior",
    matches: (net) => /(motor|heater|relay|solenoid|laser|hv|high_voltage|battery|batt|charge|discharge|fan|pump|valve|actuator|pyro|rf_tx)/i.test(net),
    rationale: "Powered outputs and stored energy require controlled loads, interlocks, safe teardown, and negative-case handling.",
    suggestedTest: "Verify disabled default state, commanded operation, protection response, interlocks, load behavior, and safe shutdown.",
    stimulus: "Use approved guarded loads and interlocks; never energize a hazardous output from schematic inference alone.",
    observation: "Capture command, output, load current/voltage, protection response, and final de-energized state.",
    missingInputs: ["Hazard analysis and safe limits", "Load/fixture specification", "Interlock design", "Discharge and emergency-stop procedure"],
    closureEvidence: "Safety-approved station design and witnessed pilot execution on the exact line configuration."
  }
];

export async function recommendManufacturingTests(productPinoutId: string, cacheDir: string): Promise<ManufacturingTestPlan> {
  const started = performance.now();
  const product = await readAnalysisPinout(productPinoutId, cacheDir);
  if (product.role !== "PRODUCT") throw new Error(`${product.id} is not a PRODUCT schematic pinout`);
  const nets = new Map<string, typeof product.pins>();
  for (const pin of product.pins) {
    const key = pin.net_name.trim().toLocaleUpperCase("en-US");
    const current = nets.get(key) ?? [];
    current.push(pin);
    nets.set(key, current);
  }
  const recommendations: ManufacturingTestRecommendation[] = [];
  const categorized = new Set<string>();
  for (const template of templates) {
    const matched = [...nets.entries()].filter(([net]) => template.matches(net));
    if (!matched.length) continue;
    matched.forEach(([net]) => categorized.add(net));
    recommendations.push(createRecommendation(template, matched.flatMap(([, pins]) => pins)));
  }
  const generalPins = [...nets.entries()].filter(([net]) => !categorized.has(net) && !isNoConnect(net)).flatMap(([, pins]) => pins);
  if (generalPins.length) {
    recommendations.push(createRecommendation({
      category: "GENERAL_SIGNAL",
      priority: "MEDIUM",
      title: "Remaining signal continuity and functional observability",
      matches: () => true,
      rationale: "The remaining schematic nets still need an explicit manufacturing fault disposition; being exposed at a connector does not prove a usable test method.",
      suggestedTest: "Assign each signal to ICT, flying probe, boundary scan, programming self-test, or FCT, and document any intentionally uncovered residual risk.",
      stimulus: "Use the selected method's controlled state and compatible fixture resource.",
      observation: "Record the expected state or response with enough diagnostic resolution to identify an open, short, swap, or functional failure.",
      missingInputs: ["Signal function and direction", "Fault model and required coverage", "Expected states/limits", "Selected tester and fixture capability"],
      closureEvidence: "Approved method-to-fault matrix and station/fixture evidence for the assigned test method."
    }, generalPins));
  }
  const wibDesignRecommendations = createWibDesignRecommendations(recommendations);
  const wibConstraints = createWibConstraints(product, recommendations);
  const requirements = createRequirements(product, recommendations);
  const methodMatrix = createMethodMatrix(recommendations);

  const identity = JSON.stringify({ product: product.confirmation?.content_hash ?? product.source_hash, model: "manufacturing-test-plan-v2" });
  const id = `test-plan-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  const directory = path.join(cacheDir, "evidence", safeSegment(id));
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "report.html");
  const diagnostics: ManufacturingTestPlan["diagnostics"] = [];
  if (product.status !== "CONFIRMED") diagnostics.push({ code: "UNCONFIRMED_SCHEMATIC_PINOUT", severity: "WARNING", message: "Recommendations are based on unconfirmed extracted pinout candidates." });
  if (!product.revision) diagnostics.push({ code: "MISSING_PRODUCT_REVISION", severity: "WARNING", message: "The product schematic revision is missing and must be established before approving a line test plan." });
  diagnostics.push({ code: "CONNECTOR_NET_SCOPE", severity: "INFO", message: "V1 recommendations cover NET NAME values present in the imported connector pinout. Internal schematic nets and components require a controlled full-netlist export or manual review." });
  const plan: ManufacturingTestPlan = {
    schema_version: 2,
    kind: "MANUFACTURING_TEST_RECOMMENDATIONS",
    id,
    product_pinout_id: product.id,
    product,
    lifecycle_status: "DRAFT",
    baseline: {
      product_revision: product.revision,
      product_source_hash: product.confirmation?.content_hash ?? product.source_hash,
      variant: null,
      panel: null,
      factory: null,
      line: null,
      tester: null,
      approved_rule_pack_id: null
    },
    approval: null,
    verdict: "REVIEW",
    verification_mode: "DOCUMENT_BACKED",
    method_matrix: methodMatrix,
    requirements,
    recommendation_count: recommendations.length,
    recommendations,
    wib_design_recommendations: wibDesignRecommendations,
    wib_constraints: wibConstraints,
    diagnostics,
    report_uri: `circuit://analysis/${id}/report`,
    report_path: reportPath,
    elapsed_ms: Math.round(performance.now() - started)
  };
  await writeFile(reportPath, renderReport(plan), "utf8");
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(plan, null, 2), "utf8");
  const priorPlans = await invalidateDependentAnalyses(
    cacheDir,
    (analysis) => analysis.kind === "MANUFACTURING_TEST_RECOMMENDATIONS"
      && analysis.product_pinout_id === product.id
      && analysis.id !== plan.id,
    `Product schematic/pinout evidence changed and generated replacement DFT plan ${plan.id}`
  );
  if (priorPlans.length) {
    const replaced = new Set(priorPlans);
    await invalidateDependentAnalyses(
      cacheDir,
      (analysis) => typeof analysis.test_plan_id === "string" && replaced.has(analysis.test_plan_id),
      `The DFT baseline used by this analysis was invalidated by replacement plan ${plan.id}`
    );
  }
  return plan;
}

export async function readManufacturingTestPlan(planId: string, cacheDir: string): Promise<ManufacturingTestPlan> {
  const value = JSON.parse(await readFile(planFile(cacheDir, planId), "utf8")) as ManufacturingTestPlan;
  if (value.kind !== "MANUFACTURING_TEST_RECOMMENDATIONS" || value.schema_version !== 2) {
    throw new Error(`${planId} is not a controlled manufacturing test plan`);
  }
  return {
    ...value,
    requirements: value.requirements.map((requirement) => ({ ...requirement, target_functions: requirement.target_functions ?? [] }))
  };
}

export async function updateManufacturingTestPlan(
  planId: string,
  requirements: ManufacturingTestRequirement[],
  methodMatrix: TestMethodCoverage[],
  cacheDir: string
): Promise<ManufacturingTestPlan> {
  const plan = await readManufacturingTestPlan(planId, cacheDir);
  if (plan.lifecycle_status !== "DRAFT") throw new Error(`test plan ${plan.id} is immutable after approval`);
  validateRequirementUpdate(plan.requirements, requirements, false);
  validateMethodMatrix(methodMatrix);
  const updated: ManufacturingTestPlan = {
    ...plan,
    requirements,
    method_matrix: methodMatrix,
    recommendation_count: requirements.length,
    elapsed_ms: plan.elapsed_ms
  };
  await persistPlan(updated, cacheDir);
  return updated;
}

export async function approveManufacturingTestPlan(
  planId: string,
  input: TestPlanApprovalInput,
  cacheDir: string
): Promise<ManufacturingTestPlan> {
  const plan = await readManufacturingTestPlan(planId, cacheDir);
  if (plan.lifecycle_status !== "DRAFT") throw new Error(`test plan ${plan.id} is not a DRAFT`);
  if (plan.product.status !== "CONFIRMED") throw new Error("product schematic/pinout must be CONFIRMED before DFT baseline approval");
  if (!plan.product.revision) throw new Error("product revision is required before DFT baseline approval");
  if (!input.approvedBy.trim() || !input.factory.trim() || !input.line.trim() || !input.tester.trim() || !input.approvedRulePackId.trim()) {
    throw new Error("approver, factory, line, tester, and approved rule pack are required");
  }
  validateRequirementUpdate(plan.requirements, plan.requirements, true);
  validateMethodMatrix(plan.method_matrix);
  const baseline: ControlledTestBaseline = {
    ...plan.baseline,
    product_revision: plan.product.revision,
    variant: input.variant?.trim() || null,
    panel: input.panel?.trim() || null,
    factory: input.factory.trim(),
    line: input.line.trim(),
    tester: input.tester.trim(),
    approved_rule_pack_id: input.approvedRulePackId.trim()
  };
  const approvalPayload = {
    schema_version: plan.schema_version,
    product_pinout_id: plan.product_pinout_id,
    baseline,
    method_matrix: plan.method_matrix,
    requirements: plan.requirements
  };
  const approval: TestPlanApproval = {
    approved_by: input.approvedBy.trim(),
    approved_at: new Date().toISOString(),
    content_hash: createHash("sha256").update(JSON.stringify(approvalPayload)).digest("hex"),
    statement: "Approved as the DFT requirement baseline. Factory fixture, station, powered, throughput, and pilot acceptance remain separate evidence gates."
  };
  const approved: ManufacturingTestPlan = { ...plan, lifecycle_status: "APPROVED", baseline, approval };
  await persistPlan(approved, cacheDir);
  return approved;
}

export async function supersedeManufacturingTestPlan(planId: string, supersededBy: string, cacheDir: string): Promise<ManufacturingTestPlan> {
  const plan = await readManufacturingTestPlan(planId, cacheDir);
  if (plan.lifecycle_status !== "APPROVED") throw new Error(`only an APPROVED test plan can be superseded`);
  if (!supersededBy.trim()) throw new Error("superseding plan identifier is required");
  const superseded: ManufacturingTestPlan = {
    ...plan,
    lifecycle_status: "SUPERSEDED",
    diagnostics: [...plan.diagnostics, { code: "TEST_PLAN_SUPERSEDED", severity: "WARNING", message: `This DFT baseline was superseded by ${supersededBy.trim()}; rerun Layout and WIB qualification against the replacement.` }]
  };
  await persistPlan(superseded, cacheDir);
  await invalidateDependentAnalyses(
    cacheDir,
    (analysis) => analysis.id !== plan.id && analysis.test_plan_id === plan.id,
    `DFT requirement baseline ${plan.id} was superseded by ${supersededBy.trim()}`
  );
  return superseded;
}

export async function readLocalDocumentAnalysis(analysisId: string, cacheDir: string): Promise<ManufacturingTestPlan | Record<string, unknown> | null> {
  const file = path.join(cacheDir, "evidence", safeSegment(analysisId), "analysis.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return parsed.kind === "MANUFACTURING_TEST_RECOMMENDATIONS" || parsed.kind === "WIRING_COMPARISON" || parsed.kind === "LAYOUT_TEST_ACCESS_ANALYSIS" || parsed.kind === "WIB_DESIGN_QUALIFICATION" ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function createRecommendation(template: RecommendationTemplate, pins: PinoutDocument["pins"]): ManufacturingTestRecommendation {
  const netNames = [...new Set(pins.map((pin) => pin.net_name))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return {
    id: `recommendation-${template.category.toLowerCase()}`,
    status: "REVIEW",
    verification_mode: "DOCUMENT_BACKED",
    category: template.category,
    priority: template.priority,
    title: template.title,
    net_names: netNames,
    schematic_evidence: pins.map((pin) => ({ connector: pin.connector, pin: pin.pin, net_name: pin.net_name, page: pin.evidence.page, excerpt: pin.evidence.excerpt })),
    rationale: template.rationale,
    suggested_test: template.suggestedTest,
    stimulus: template.stimulus,
    observation: template.observation,
    missing_inputs: template.missingInputs,
    closure_evidence: template.closureEvidence
  };
}

function createRequirements(product: PinoutDocument, recommendations: ManufacturingTestRecommendation[]): ManufacturingTestRequirement[] {
  return recommendations.flatMap((recommendation) => recommendation.net_names.map((netName) => {
    const pins = product.pins.filter((pin) => key(pin.net_name) === key(netName));
    const policy = requirementPolicy(recommendation.category);
    const sourceEvidence = pins.map((pin) => ({
      source_path: pin.evidence.source_path,
      source_hash: pin.evidence.source_hash,
      page: pin.evidence.page,
      excerpt: pin.evidence.excerpt
    }));
    return {
      id: `requirement-${recommendation.category.toLowerCase()}-${createHash("sha256").update(key(netName)).digest("hex").slice(0, 10)}`,
      status: "REVIEW",
      verification_mode: "DOCUMENT_BACKED",
      category: recommendation.category,
      priority: recommendation.priority,
      title: `${recommendation.title} · ${netName}`,
      fault_classes: policy.faultClasses,
      target_net_names: [netName],
      target_pins: pins.map((pin) => ({ connector: pin.connector, pin: pin.pin, net_name: pin.net_name })),
      target_functions: [],
      methods: policy.methods,
      test_stage: policy.stage,
      access_strategy: policy.accessStrategy,
      physical_access_required: policy.physicalAccessRequired,
      allowed_sides: ["TOP", "BOTTOM"],
      stimulus: recommendation.stimulus,
      observation: recommendation.observation,
      limit_authority: null,
      owner: "Product test engineering requirement owner",
      residual_risk: policy.residualRisk,
      closure_evidence: recommendation.closure_evidence,
      source_evidence: sourceEvidence
    } satisfies ManufacturingTestRequirement;
  }));
}

function requirementPolicy(category: ManufacturingTestRecommendation["category"]): {
  methods: ManufacturingTestMethod[];
  stage: ManufacturingTestRequirement["test_stage"];
  accessStrategy: ManufacturingTestRequirement["access_strategy"];
  physicalAccessRequired: boolean;
  faultClasses: string[];
  residualRisk: string;
} {
  const policies: Record<ManufacturingTestRecommendation["category"], ReturnType<typeof requirementPolicy>> = {
    GROUND: { methods: ["FLYING_PROBE", "ICT", "FCT"], stage: "PRE_SHIELD_COATING", accessStrategy: "PHYSICAL_PROBE", physicalAccessRequired: true, faultClasses: ["assembly open", "resistive connection", "wrong ground-domain join"], residualRisk: "Powered and low-level measurement behavior still needs fixture/station validation." },
    POWER: { methods: ["FLYING_PROBE", "ICT", "FCT"], stage: "PRE_SHIELD_COATING", accessStrategy: "PHYSICAL_PROBE", physicalAccessRequired: true, faultClasses: ["short", "assembly open", "wrong rail", "sequencing fault"], residualRisk: "Static access does not prove safe injection, current limiting, sequencing, or discharge." },
    PROGRAMMING_DEBUG: { methods: ["BOUNDARY_SCAN", "PROGRAMMING"], stage: "POST_REFLOW", accessStrategy: "PROGRAMMING_INTERFACE", physicalAccessRequired: false, faultClasses: ["blank device", "wrong image", "programming access fault", "digital interconnect fault"], residualRisk: "Exact device/BSDL, algorithm, security state, retry, and production execution remain to be demonstrated." },
    RESET_BOOT: { methods: ["ICT", "FCT"], stage: "POST_REFLOW", accessStrategy: "CONNECTOR", physicalAccessRequired: false, faultClasses: ["reset fault", "boot-strap fault", "unsafe default state"], residualRisk: "Control direction, pulls, contention, and blank-device behavior need document and powered evidence." },
    CLOCK: { methods: ["ICT", "FCT"], stage: "POST_REFLOW", accessStrategy: "FCT", physicalAccessRequired: false, faultClasses: ["missing clock", "wrong frequency", "startup fault"], residualRisk: "Loading, bandwidth, uncertainty, and startup limits need controlled station evidence." },
    DIGITAL_INTERFACE: { methods: ["BOUNDARY_SCAN", "FCT"], stage: "FINAL_ASSEMBLY", accessStrategy: "FCT", physicalAccessRequired: false, faultClasses: ["open", "short", "swap", "protocol path fault"], residualRisk: "Voltage domain, direction, termination, speed, and executable endpoint remain to be confirmed." },
    ANALOG_SENSOR: { methods: ["FCT"], stage: "FINAL_ASSEMBLY", accessStrategy: "FCT", physicalAccessRequired: false, faultClasses: ["analog path open", "wrong value", "sensor fault", "calibration fault"], residualRisk: "Limits, uncertainty, guard band, calibration, and environmental conditions remain factory-confirmation items." },
    ACTUATOR_SAFETY: { methods: ["FCT"], stage: "FINAL_ASSEMBLY", accessStrategy: "FCT", physicalAccessRequired: false, faultClasses: ["unsafe default", "output fault", "protection fault", "interlock fault"], residualRisk: "Hazard controls and powered negative cases require safety approval and witnessed execution." },
    GENERAL_SIGNAL: { methods: ["ICT", "FLYING_PROBE", "BOUNDARY_SCAN", "FCT"], stage: "POST_REFLOW", accessStrategy: "FCT", physicalAccessRequired: false, faultClasses: ["open", "short", "swap", "unobserved manufacturing fault"], residualRisk: "The responsible engineer must confirm signal function, method assignment, expected state, and intentionally uncovered risk before approval." }
  };
  return policies[category];
}

function createMethodMatrix(recommendations: ManufacturingTestRecommendation[]): TestMethodCoverage[] {
  const categories = new Set(recommendations.map((item) => item.category));
  const rows: Array<Omit<TestMethodCoverage, "status">> = [
    { method: "BARE_BOARD_ELECTRICAL", disposition: "SELECTED", target_fault_classes: ["bare-board open", "bare-board short"], prerequisites: ["Supplier electrical-test program and matching board revision"], residual_gaps: ["Assembly and powered behavior"], reason: "Catch fabrication interconnect faults before assembly." },
    { method: "SPI", disposition: "SUPPLEMENTAL", target_fault_classes: ["solder-paste volume and alignment defect"], prerequisites: ["Stencil/process program"], residual_gaps: ["Electrical connectivity and component function"], reason: "Inspection evidence complements electrical test and is not a substitute for it." },
    { method: "AOI", disposition: "SUPPLEMENTAL", target_fault_classes: ["visible placement, polarity, and solder defect"], prerequisites: ["Approved inspection program and golden data"], residual_gaps: ["Hidden joints and electrical behavior"], reason: "Use visual inspection where the defect is observable." },
    { method: "AXI", disposition: "SUPPLEMENTAL", target_fault_classes: ["hidden solder-joint defect"], prerequisites: ["Applicable package risk and approved X-ray program"], residual_gaps: ["Electrical and functional behavior"], reason: "Apply where hidden-joint risk justifies it." },
    { method: "FLYING_PROBE", disposition: "SUPPLEMENTAL", target_fault_classes: ["assembly open", "short", "passive-value fault"], prerequisites: ["Accessible targets and production-volume decision"], residual_gaps: ["High-throughput and powered functional behavior"], reason: "Candidate for prototypes, changing designs, or low-volume production." },
    { method: "ICT", disposition: "SUPPLEMENTAL", target_fault_classes: ["assembly open", "short", "wrong or missing component", "passive-value fault"], prerequisites: ["Approved physical access, fixture, and stable-volume business case"], residual_gaps: ["Limited-access devices and end-to-end behavior"], reason: "Candidate where repeatability, diagnostics, access, and volume justify a fixture." },
    { method: "BOUNDARY_SCAN", disposition: categories.has("PROGRAMMING_DEBUG") || categories.has("DIGITAL_INTERFACE") ? "SUPPLEMENTAL" : "NOT_SELECTED", target_fault_classes: ["limited-access digital interconnect fault"], prerequisites: ["Exact devices, packages, validated BSDL files, chain topology, and executable patterns"], residual_gaps: ["Analog, non-scan, and powered product behavior"], reason: "Use only for compatible, controllable, and observable digital structures." },
    { method: "PROGRAMMING", disposition: categories.has("PROGRAMMING_DEBUG") ? "SELECTED" : "NOT_SELECTED", target_fault_classes: ["blank, corrupt, wrong-version, or misconfigured device"], prerequisites: ["Authoritative image, algorithm, identity, security, retry, and recovery process"], residual_gaps: ["Unrelated assembly and product-function faults"], reason: "Selected only when the imported interface exposes programming/debug intent." },
    { method: "FCT", disposition: "SELECTED", target_fault_classes: ["powered interface, sensor, actuator, calibration, safety, and end-to-end fault"], prerequisites: ["Approved limits, loads, fixtures, firmware state, and station procedure"], residual_gaps: ["Structural fault localization without complementary methods"], reason: "Close product behaviors that structural and inspection methods cannot establish." }
  ];
  return rows.map((row) => ({ ...row, status: "REVIEW" }));
}

function createWibDesignRecommendations(recommendations: ManufacturingTestRecommendation[]): WibDesignRecommendation[] {
  return recommendations.map((item) => {
    const content: Record<ManufacturingTestRecommendation["category"], Pick<WibDesignRecommendation, "title" | "recommendation" | "rationale" | "validation_needed">> = {
      GROUND: {
        title: "Provide intentional ground, return, guard, and optional sense paths",
        recommendation: "Route measurement returns explicitly; separate or join ground domains only as defined by the product; provide guard, shield, or Kelvin sense paths when the selected measurement requires them.",
        rationale: "Shared or ambiguous returns can create offsets, ground loops, and false passes while high fixture current can corrupt low-level measurements.",
        validation_needed: "Review the product ground architecture and validate the WIB return topology, resistance, shielding, and tester reference on the actual fixture."
      },
      POWER: {
        title: "Add current-limited, sequenced, measurable power delivery",
        recommendation: "Provide independently controllable rail paths as required, current/voltage sense, deterministic discharge, reverse/back-power protection, and safe default-off behavior.",
        rationale: "The WIB must not energize a product rail or I/O path in an uncontrolled order or conceal shorts through excessive source impedance.",
        validation_needed: "Confirm rail values, current limits, sequence timing, connector rating, copper temperature rise, protection trip behavior, and discharge on the real station."
      },
      PROGRAMMING_DEBUG: {
        title: "Preserve a deterministic programming/debug path",
        recommendation: "Route programming/debug signals one-to-one with controlled default states, required references, optional isolation, and recovery access; keep secret material outside the WIB and reports.",
        rationale: "Fixture muxes, level translators, pulls, or long stubs can break device detection or make interrupted programming unrecoverable.",
        validation_needed: "Validate the exact device algorithm, cable/WIB path, target voltage, programming frequency, reset/boot interaction, retry, and final lock state."
      },
      RESET_BOOT: {
        title: "Make reset, enable, and boot controls contention-safe",
        recommendation: "Use high-impedance defaults and explicit drive/isolation so the WIB can place the unit in a test state without fighting on-board pulls, supervisors, or active devices.",
        rationale: "A fixture-driven strap or reset line can back-power or damage the product if drive strength and power state are not coordinated.",
        validation_needed: "Confirm pull states, voltage domains, allowable drive current, timing, blank-device behavior, and teardown state."
      },
      CLOCK: {
        title: "Minimize clock loading and measurement stubs",
        recommendation: "Use a loading-safe observation or stimulus path, short return-aware routing, and buffering only when its delay/jitter and power state are explicitly acceptable.",
        rationale: "Direct probing, long WIB traces, and switching matrices can stop or distort oscillators and high-frequency clocks.",
        validation_needed: "Confirm probe/input capacitance, bandwidth, frequency range, allowable jitter/loading, and correlation to the product-side measurement."
      },
      DIGITAL_INTERFACE: {
        title: "Preserve voltage domains, topology, and termination for digital interfaces",
        recommendation: "Use explicit level translation or isolation when needed, keep differential/bus topology and returns intact, prevent fixture/product driver contention, and expose loopback or known-peripheral endpoints.",
        rationale: "A pin-correct WIB can still fail electrically through wrong levels, termination, pair polarity, skew, or powered-off leakage.",
        validation_needed: "Validate protocol voltage, direction, termination, impedance where applicable, cable/WIB loss, bus loading, and maximum intended test speed."
      },
      ANALOG_SENSOR: {
        title: "Separate force, sense, guard, shield, and calibration resources",
        recommendation: "Route sensitive analog nets away from switching nodes; add guarding/shielding or Kelvin force/sense where required; make fixture losses and mux errors calibratable and traceable.",
        rationale: "WIB contact, copper, relay, mux, and cable errors can dominate the product tolerance and create unstable production limits.",
        validation_needed: "Establish the measurement uncertainty budget, leakage, offset, resistance, bandwidth, settling, calibration, drift, and golden-unit correlation."
      },
      ACTUATOR_SAFETY: {
        title: "Design hazardous outputs for default-safe, interlocked operation",
        recommendation: "Keep hazardous or high-energy channels de-energized by default; use appropriately rated isolation/protection, loads, interlocks, discharge, fault containment, and emergency stop paths.",
        rationale: "Schematic net presence is not authority to energize motors, heaters, batteries, relays, RF, lasers, or high voltage on a manufacturing station.",
        validation_needed: "Require safety review, component/connector derating, fault analysis, guarded fixture validation, discharge proof, and witnessed pilot execution."
      },
      GENERAL_SIGNAL: {
        title: "Use one-to-one, inspectable signal routing with controlled defaults",
        recommendation: "Preserve product pin identity and NET NAME through the WIB; avoid undocumented sharing, pulls, mux states, test stubs, and protection parts that alter the product-visible state.",
        rationale: "Unclassified signals still need a declared direction, electrical domain, test purpose, default state, and fault model before WIB circuitry is chosen.",
        validation_needed: "Assign ownership and limits for every remaining signal, then review schematic, layout, fixture, and station behavior together."
      }
    };
    return {
      id: `wib-design-${item.category.toLowerCase()}`,
      status: "REVIEW",
      verification_mode: "DOCUMENT_BACKED",
      category: item.category,
      priority: item.priority,
      related_net_names: item.net_names,
      ...content[item.category]
    };
  });
}

function createWibConstraints(product: PinoutDocument, recommendations: ManufacturingTestRecommendation[]): WibDesignConstraint[] {
  const allNets = [...new Set(product.pins.map((pin) => pin.net_name))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const netsByCategory = new Map(recommendations.map((item) => [item.category, item.net_names]));
  const productAuthority = `${product.source_path} SHA-256 ${product.source_hash}${product.revision ? ` revision ${product.revision}` : ""}`;
  const documentConstraint = (
    id: string,
    requirement: string,
    metric: string,
    comparator: WibDesignConstraint["comparator"],
    value: string | number,
    nets: string[] = allNets
  ): WibDesignConstraint => ({
    id,
    status: "REVIEW",
    verification_mode: "DOCUMENT_BACKED",
    requirement_level: "HARD",
    area: "CONNECTIVITY",
    requirement,
    metric,
    comparator,
    required_value: value,
    unit: null,
    source_authority: productAuthority,
    related_net_names: nets,
    owner: "Product hardware owner and WIB designer",
    closure_evidence: "Confirmed product and WIB pinouts plus a zero-FLAG compare_fixture_wiring analysis for the declared mapping scope."
  });
  const implementationConstraint = (
    id: string,
    area: WibDesignConstraint["area"],
    requirement: string,
    metric: string,
    comparator: WibDesignConstraint["comparator"],
    owner: string,
    nets: string[] = []
  ): WibDesignConstraint => ({
    id,
    status: "REVIEW",
    verification_mode: "MANUAL_FACTORY_CONFIRMATION",
    requirement_level: "HARD",
    area,
    requirement,
    metric,
    comparator,
    required_value: null,
    unit: null,
    source_authority: "The responsible product, hardware, test, fixture, safety, or manufacturing engineer must define and approve the project requirement; no universal value was assumed.",
    related_net_names: nets,
    owner,
    closure_evidence: "Record the engineering-approved value, unit, comparator, tolerance, source revision, applicability, and approver; then record supplier/factory capability, actual compliant selection, deviations, and real fixture/station verification."
  });
  const constraints: WibDesignConstraint[] = [
    documentConstraint("WIB-CONNECTIVITY-001", "Every declared product-interface pin shall map to exactly one intended WIB pin.", "Mapped pin cardinality", "EXACT", "one-to-one"),
    documentConstraint("WIB-CONNECTIVITY-002", "Each mapped WIB pin shall preserve the product NET NAME or an explicitly approved one-to-one alias.", "NET identity", "EXACT", "product NET NAME or approved alias"),
    documentConstraint("WIB-CONNECTIVITY-003", "No declared product-interface pin may be omitted from the approved comparison scope.", "Mapped interface coverage", "ALL", "all declared interface pins"),
    documentConstraint("WIB-CONNECTIVITY-004", "No unintended cross-net short, pin swap, or fan-in/fan-out mapping is allowed.", "Unintended interconnect count", "NONE", 0),
    documentConstraint("WIB-CONNECTIVITY-005", "NC/DNC pins shall remain isolated unless the product owner explicitly approves another use.", "Unapproved NC connections", "NONE", 0, allNets.filter((net) => isNoConnect(net)))
  ];
  constraints.push(
    implementationConstraint("WIB-ELECTRICAL-001", "ELECTRICAL", "WIB channels, connectors, protection, relays, muxes, and copper shall meet the required voltage, current, power, temperature-rise, leakage, and derating limits.", "Per-channel electrical operating range and protection thresholds", "RANGE", "Hardware/test engineering", netsByCategory.get("POWER")),
    implementationConstraint("WIB-ELECTRICAL-002", "ELECTRICAL", "The WIB shall not back-power the product or create driver contention in any power, reset, programming, or teardown state.", "Powered-off leakage, drive current, and allowable sequence", "MAXIMUM", "Hardware/test engineering", [...(netsByCategory.get("POWER") ?? []), ...(netsByCategory.get("RESET_BOOT") ?? []), ...(netsByCategory.get("PROGRAMMING_DEBUG") ?? [])]),
    implementationConstraint("WIB-MEASUREMENT-001", "MEASUREMENT", "The complete station/WIB/fixture measurement path shall meet the required accuracy, uncertainty, resolution, repeatability, settling, leakage, and calibration limits.", "Measurement-system capability by channel", "RANGE", "Test engineering and quality", netsByCategory.get("ANALOG_SENSOR")),
    implementationConstraint("WIB-SI-001", "SIGNAL_INTEGRITY", "High-speed, clock, differential, and sensitive analog paths shall meet the applicable impedance, loss, skew, crosstalk, loading, return-path, and bandwidth requirements.", "Interface-specific signal-integrity limits", "RANGE", "Hardware SI owner and test engineering", [...(netsByCategory.get("CLOCK") ?? []), ...(netsByCategory.get("DIGITAL_INTERFACE") ?? []), ...(netsByCategory.get("ANALOG_SENSOR") ?? [])]),
    implementationConstraint("WIB-PROBE-001", "FIXTURE_GEOMETRY", "Product/test/fixture engineering shall define and approve the probe family/type, tip geometry, diameter, working stroke/travel, force, current and contact-resistance limits, material/coating, access side, target geometry, and keep-outs before fixture release. The supplier/factory shall select a compliant part and record capability and deviations.", "Approved probe and target specification", "TO_BE_DEFINED", "Product/test/fixture engineering requirement owner; fixture supplier and factory implementation owner"),
    implementationConstraint("WIB-MECHANICAL-001", "MECHANICAL", "The WIB and fixture shall meet connector mating, keying, support, clamp, deflection, strain-relief, service-life, and repeatable-orientation requirements.", "Mechanical load, deflection, alignment, and mating life", "RANGE", "Mechanical/fixture engineering requirement owner; factory implementation owner"),
    implementationConstraint("WIB-TESTER-001", "TESTER_CAPACITY", "Required tester sources, measurements, grounds, guards, loads, communication endpoints, relay/mux resources, and parallel sites shall fit available station capacity with approved margin.", "Tester resource count and simultaneous load", "MINIMUM", "Test engineering requirement owner; factory implementation owner"),
    implementationConstraint("WIB-THROUGHPUT-001", "THROUGHPUT", "The complete test flow shall meet the production cycle-time, retry, uptime, diagnostics, traceability, and maintenance requirements.", "Cycle time, availability, repeatability, and logging completeness", "RANGE", "Manufacturing engineering and quality requirement owners")
  );
  return constraints;
}

function validateRequirementUpdate(original: ManufacturingTestRequirement[], next: ManufacturingTestRequirement[], forApproval: boolean) {
  if (!next.length) throw new Error("at least one manufacturing test requirement is required");
  const originalIds = new Set(original.map((item) => item.id));
  const nextIds = new Set<string>();
  for (const requirement of next) {
    if (!/^[a-zA-Z0-9_-]+$/.test(requirement.id)) throw new Error(`invalid test requirement identifier ${requirement.id}`);
    if (nextIds.has(requirement.id)) throw new Error(`duplicate test requirement ${requirement.id}`);
    nextIds.add(requirement.id);
    if (!requirement.title.trim() || !requirement.owner.trim() || (!requirement.target_net_names.length && !requirement.target_pins.length && !requirement.target_functions.length) || !requirement.methods.length) {
      throw new Error(`test requirement ${requirement.id} is incomplete`);
    }
    if (!requirement.fault_classes.length || !requirement.stimulus.trim() || !requirement.observation.trim() || !requirement.closure_evidence.trim() || !requirement.residual_risk.trim() || !requirement.source_evidence.length) {
      throw new Error(`test requirement ${requirement.id} lacks a controlled fault model, stimulus/observation, residual risk, source evidence, or closure evidence`);
    }
    if (requirement.physical_access_required && !requirement.allowed_sides.length) {
      throw new Error(`physical-access requirement ${requirement.id} needs at least one allowed side`);
    }
    if (forApproval && requirement.access_strategy === "TO_BE_ASSIGNED") {
      throw new Error(`test requirement ${requirement.id} still has TO_BE_ASSIGNED access`);
    }
  }
  if ([...originalIds].some((id) => !nextIds.has(id))) throw new Error("generated test requirements cannot be silently removed during draft review");
}

function validateMethodMatrix(rows: TestMethodCoverage[]) {
  const expected: ManufacturingTestMethod[] = ["BARE_BOARD_ELECTRICAL", "SPI", "AOI", "AXI", "FLYING_PROBE", "ICT", "BOUNDARY_SCAN", "PROGRAMMING", "FCT"];
  const ids = new Set(rows.map((row) => row.method));
  if (ids.size !== rows.length) throw new Error("manufacturing test method matrix contains duplicates");
  const missing = expected.filter((method) => !ids.has(method));
  if (missing.length) throw new Error(`manufacturing test method matrix is missing ${missing.join(", ")}`);
  for (const row of rows) {
    if (!row.target_fault_classes.length || !row.reason.trim()) throw new Error(`method ${row.method} lacks a fault model or reason`);
  }
}

async function persistPlan(plan: ManufacturingTestPlan, cacheDir: string) {
  await mkdir(path.dirname(planFile(cacheDir, plan.id)), { recursive: true });
  await writeFile(plan.report_path, renderReport(plan), "utf8");
  await writeFile(planFile(cacheDir, plan.id), JSON.stringify(plan, null, 2), "utf8");
}

function planFile(cacheDir: string, planId: string) {
  return path.join(cacheDir, "evidence", safeSegment(planId), "analysis.json");
}

function renderReport(plan: ManufacturingTestPlan) {
  const methodRows = plan.method_matrix.map((row) => `<tr><td><code>${html(row.method)}</code></td><td>${html(row.disposition)}</td><td>${html(row.target_fault_classes.join(", "))}</td><td>${html(row.prerequisites.join("; "))}</td><td>${html(row.residual_gaps.join("; "))}</td><td>${html(row.reason)}</td></tr>`).join("");
  const requirementRows = plan.requirements.map((requirement) => `<tr><td><code>${html(requirement.id)}</code></td><td>${html(requirement.priority)}</td><td>${html(requirement.target_net_names.join(", ") || requirement.target_functions.join(", ") || requirement.target_pins.map((pin) => `${pin.connector}.${pin.pin}`).join(", "))}</td><td>${html(requirement.methods.join(", "))}</td><td>${html(requirement.test_stage)}</td><td>${html(requirement.access_strategy)}</td><td>${requirement.physical_access_required ? html(requirement.allowed_sides.join(", ")) : "NOT REQUIRED"}</td><td>${html(requirement.owner)}</td><td>${html(requirement.residual_risk)}</td></tr>`).join("");
  const cards = plan.recommendations.map((item) => `<article><div class="card-head"><span class="priority ${item.priority.toLowerCase()}">${html(item.priority)}</span><span>${html(item.category)}</span></div><h2>${html(item.title)}</h2><p>${html(item.rationale)}</p><dl><dt>NET NAME evidence</dt><dd>${item.net_names.map((net) => `<code>${html(net)}</code>`).join(" ")}</dd><dt>Suggested test</dt><dd>${html(item.suggested_test)}</dd><dt>Stimulus</dt><dd>${html(item.stimulus)}</dd><dt>Observation</dt><dd>${html(item.observation)}</dd><dt>Missing inputs</dt><dd><ul>${item.missing_inputs.map((input) => `<li>${html(input)}</li>`).join("")}</ul></dd><dt>Evidence required to close REVIEW</dt><dd>${html(item.closure_evidence)}</dd></dl></article>`).join("");
  const wibCards = plan.wib_design_recommendations.map((item) => `<article><div class="card-head"><span class="priority ${item.priority.toLowerCase()}">${html(item.priority)}</span><span>${html(item.category)}</span></div><h2>${html(item.title)}</h2><p>${html(item.recommendation)}</p><dl><dt>Related NET NAME values</dt><dd>${item.related_net_names.map((net) => `<code>${html(net)}</code>`).join(" ")}</dd><dt>Why</dt><dd>${html(item.rationale)}</dd><dt>Validation needed</dt><dd>${html(item.validation_needed)}</dd></dl></article>`).join("");
  const constraintRows = plan.wib_constraints.map((constraint) => `<tr><td><code>${html(constraint.id)}</code></td><td>${html(constraint.area)}</td><td>${html(constraint.requirement)}</td><td>${html(constraint.metric)}</td><td>${html(constraint.comparator)}</td><td>${constraint.required_value == null ? '<span class="missing">TBD by authority</span>' : html(constraint.required_value)}${constraint.unit ? ` ${html(constraint.unit)}` : ""}</td><td>${html(constraint.verification_mode)}</td><td>${html(constraint.owner)}</td></tr>`).join("");
  const diagnostics = plan.diagnostics.map((diagnostic) => `<li><strong>${html(diagnostic.code)}</strong> — ${html(diagnostic.message)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Manufacturing test and WIB design plan</title><style>${css()}</style></head><body><main><header><div><p class="eyebrow">CircuitInspector · DOCUMENT_BACKED · ${html(plan.lifecycle_status)}</p><h1>Manufacturing test and WIB design plan</h1><p>${html(plan.product.source_path)} · revision ${html(plan.product.revision ?? "not supplied")}</p><p>Factory ${html(plan.baseline.factory ?? "not assigned")} · line ${html(plan.baseline.line ?? "not assigned")} · tester ${html(plan.baseline.tester ?? "not assigned")} · rule pack ${html(plan.baseline.approved_rule_pack_id ?? "not assigned")}</p></div><span class="verdict">${html(plan.lifecycle_status)} · REVIEW</span></header><section class="summary"><strong>${plan.requirements.length}</strong><span>traceable test requirements across ${plan.method_matrix.length} manufacturing methods; approval freezes test intent only and never proves factory readiness</span></section><section class="diagnostics"><h2>Scope and missing evidence</h2><ul>${diagnostics}</ul></section><h1 class="section-title">Method-to-fault matrix</h1><section class="table-wrap"><table><thead><tr><th>Method</th><th>Disposition</th><th>Target faults</th><th>Prerequisites</th><th>Residual gaps</th><th>Reason</th></tr></thead><tbody>${methodRows}</tbody></table></section><h1 class="section-title">Controlled DFT requirements</h1><section class="table-wrap"><table><thead><tr><th>ID</th><th>Priority</th><th>Target NET / pin / function</th><th>Methods</th><th>Stage</th><th>Access</th><th>Physical sides</th><th>Owner</th><th>Residual risk</th></tr></thead><tbody>${requirementRows}</tbody></table></section><h1 class="section-title">Manufacturing-line recommendation groups</h1><section class="cards">${cards || "<p>No test recommendations could be derived from the imported connector NET NAME values.</p>"}</section><h1 class="section-title">Corresponding WIB design recommendations</h1><section class="cards">${wibCards || "<p>No WIB design recommendations could be derived.</p>"}</section><h1 class="section-title">WIB constraints and hard metrics</h1><p class="constraint-note">Connectivity constraints are anchored to the product schematic. Responsible engineering defines and approves electrical, probe, geometry, mechanical, tester, and throughput requirements; suppliers and factories confirm capability, compliant selection, deviations, and station results.</p><section class="table-wrap"><table><thead><tr><th>ID</th><th>Area</th><th>Hard requirement</th><th>Metric</th><th>Comparator</th><th>Required value</th><th>Verification</th><th>Owner</th></tr></thead><tbody>${constraintRows}</tbody></table></section><footer>${plan.approval ? `Approved by ${html(plan.approval.approved_by)} at ${html(plan.approval.approved_at)} · SHA-256 ${html(plan.approval.content_hash)}. ` : "DRAFT: test engineering approval is still required. "}This is not production acceptance. Factory, fixture, tester, powered, throughput, and pilot evidence remain separate closure gates.</footer></main></body></html>`;
}

function css() {
  return `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#111416;color:#ecebe7}body{margin:0}main{max-width:1380px;margin:auto;padding:38px}header{display:flex;justify-content:space-between;gap:24px;align-items:start;border-bottom:1px solid #2b3032;padding-bottom:24px}h1{margin:.15rem 0;font-size:30px}.section-title{margin-top:38px;font-size:23px}h2{font-size:16px;margin:8px 0 10px}p,li,dd{color:#a6aba8;line-height:1.6}.eyebrow{font:11px ui-monospace;letter-spacing:.12em;color:#858b89}.verdict{padding:10px 18px;border-radius:999px;background:#3b321f;color:#e1bb73;font:700 14px ui-monospace}.summary{display:flex;align-items:baseline;gap:16px;padding:22px 0}.summary strong{font-size:34px}.summary span{color:#8f9592}.diagnostics{padding:18px 22px;border:1px solid #514327;background:#282318;border-radius:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;margin-top:18px}.cards article{border:1px solid #2b3032;background:#171b1d;border-radius:14px;padding:22px}.card-head{display:flex;justify-content:space-between;color:#7f8683;font:10px ui-monospace;letter-spacing:.08em}.priority{padding:3px 7px;border-radius:5px}.priority.high{color:#f09884;background:#3b241f}.priority.medium{color:#e1bb73;background:#332c1c}dl{margin:0}dt{margin-top:15px;color:#d5d5d0;font-size:11px;font-weight:700}dd{margin:5px 0 0;font-size:12px}code{display:inline-block;margin:3px 3px 0 0;padding:3px 6px;border:1px solid #343b3d;border-radius:5px;color:#b7c7c3;background:#101315}.constraint-note{max-width:1000px}.table-wrap{overflow:auto;border:1px solid #2b3032;border-radius:12px}table{width:100%;min-width:1200px;border-collapse:collapse;font-size:11px}th,td{padding:11px 12px;text-align:left;vertical-align:top;border-bottom:1px solid #292e30}th{font:10px ui-monospace;color:#8f9694;text-transform:uppercase}td{color:#adb2af;line-height:1.5}.missing{color:#e1bb73}footer{margin-top:32px;padding-top:20px;border-top:1px solid #2b3032;color:#858b89;font-size:11px;line-height:1.6}`;
}

function isNoConnect(net: string) {
  return /^(NC|N\/C|DNC|NO_CONNECT|UNCONNECTED)$/i.test(net.trim());
}

function safeSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid CircuitInspector identifier");
  return value;
}

function key(value: string) {
  return value.trim().toLocaleUpperCase("en-US");
}

function html(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
