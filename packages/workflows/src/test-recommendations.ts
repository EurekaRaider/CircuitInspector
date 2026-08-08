import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPinout, type PinoutDocument } from "./wiring.js";

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

export interface ManufacturingTestPlan {
  schema_version: 1;
  kind: "MANUFACTURING_TEST_RECOMMENDATIONS";
  id: string;
  product_pinout_id: string;
  product: PinoutDocument;
  verdict: "REVIEW";
  verification_mode: "DOCUMENT_BACKED";
  recommendation_count: number;
  recommendations: ManufacturingTestRecommendation[];
  wib_design_recommendations: WibDesignRecommendation[];
  wib_constraints: WibDesignConstraint[];
  diagnostics: Array<{ code: string; severity: "INFO" | "WARNING"; message: string }>;
  report_uri: string;
  report_path: string;
  elapsed_ms: number;
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
  const product = await readPinout(productPinoutId, cacheDir);
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

  const identity = JSON.stringify({ product: product.confirmation?.content_hash ?? product.source_hash, model: "manufacturing-test-recommendations-v1" });
  const id = `test-plan-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  const directory = path.join(cacheDir, "evidence", safeSegment(id));
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "report.html");
  const diagnostics: ManufacturingTestPlan["diagnostics"] = [];
  if (product.status !== "CONFIRMED") diagnostics.push({ code: "UNCONFIRMED_SCHEMATIC_PINOUT", severity: "WARNING", message: "Recommendations are based on unconfirmed extracted pinout candidates." });
  if (!product.revision) diagnostics.push({ code: "MISSING_PRODUCT_REVISION", severity: "WARNING", message: "The product schematic revision is missing and must be established before approving a line test plan." });
  diagnostics.push({ code: "CONNECTOR_NET_SCOPE", severity: "INFO", message: "V1 recommendations cover NET NAME values present in the imported connector pinout. Internal schematic nets and components require a controlled full-netlist export or manual review." });
  const plan: ManufacturingTestPlan = {
    schema_version: 1,
    kind: "MANUFACTURING_TEST_RECOMMENDATIONS",
    id,
    product_pinout_id: product.id,
    product,
    verdict: "REVIEW",
    verification_mode: "DOCUMENT_BACKED",
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
  return plan;
}

export async function readLocalDocumentAnalysis(analysisId: string, cacheDir: string): Promise<ManufacturingTestPlan | Record<string, unknown> | null> {
  const file = path.join(cacheDir, "evidence", safeSegment(analysisId), "analysis.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return parsed.kind === "MANUFACTURING_TEST_RECOMMENDATIONS" || parsed.kind === "WIRING_COMPARISON" || parsed.kind === "WIB_DESIGN_QUALIFICATION" ? parsed : null;
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
  const factoryConstraint = (
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
    source_authority: "Applicable approved project, factory, tester, fixture, safety, or interface requirement is required; no universal value was assumed.",
    related_net_names: nets,
    owner,
    closure_evidence: "Record the approved numeric value, unit, comparator, tolerance, source revision, applicability, approver, and real fixture/station verification result."
  });
  const constraints: WibDesignConstraint[] = [
    documentConstraint("WIB-CONNECTIVITY-001", "Every declared product-interface pin shall map to exactly one intended WIB pin.", "Mapped pin cardinality", "EXACT", "one-to-one"),
    documentConstraint("WIB-CONNECTIVITY-002", "Each mapped WIB pin shall preserve the product NET NAME or an explicitly approved one-to-one alias.", "NET identity", "EXACT", "product NET NAME or approved alias"),
    documentConstraint("WIB-CONNECTIVITY-003", "No declared product-interface pin may be omitted from the approved comparison scope.", "Mapped interface coverage", "ALL", "all declared interface pins"),
    documentConstraint("WIB-CONNECTIVITY-004", "No unintended cross-net short, pin swap, or fan-in/fan-out mapping is allowed.", "Unintended interconnect count", "NONE", 0),
    documentConstraint("WIB-CONNECTIVITY-005", "NC/DNC pins shall remain isolated unless the product owner explicitly approves another use.", "Unapproved NC connections", "NONE", 0, allNets.filter((net) => isNoConnect(net)))
  ];
  constraints.push(
    factoryConstraint("WIB-ELECTRICAL-001", "ELECTRICAL", "WIB channels, connectors, protection, relays, muxes, and copper shall meet the required voltage, current, power, temperature-rise, leakage, and derating limits.", "Per-channel electrical operating range and protection thresholds", "RANGE", "Hardware/test engineering", netsByCategory.get("POWER")),
    factoryConstraint("WIB-ELECTRICAL-002", "ELECTRICAL", "The WIB shall not back-power the product or create driver contention in any power, reset, programming, or teardown state.", "Powered-off leakage, drive current, and allowable sequence", "MAXIMUM", "Hardware/test engineering", [...(netsByCategory.get("POWER") ?? []), ...(netsByCategory.get("RESET_BOOT") ?? []), ...(netsByCategory.get("PROGRAMMING_DEBUG") ?? [])]),
    factoryConstraint("WIB-MEASUREMENT-001", "MEASUREMENT", "The complete station/WIB/fixture measurement path shall meet the required accuracy, uncertainty, resolution, repeatability, settling, leakage, and calibration limits.", "Measurement-system capability by channel", "RANGE", "Test engineering and quality", netsByCategory.get("ANALOG_SENSOR")),
    factoryConstraint("WIB-SI-001", "SIGNAL_INTEGRITY", "High-speed, clock, differential, and sensitive analog paths shall meet the applicable impedance, loss, skew, crosstalk, loading, return-path, and bandwidth requirements.", "Interface-specific signal-integrity limits", "RANGE", "Hardware SI owner and test engineering", [...(netsByCategory.get("CLOCK") ?? []), ...(netsByCategory.get("DIGITAL_INTERFACE") ?? []), ...(netsByCategory.get("ANALOG_SENSOR") ?? [])]),
    factoryConstraint("WIB-FIXTURE-001", "FIXTURE_GEOMETRY", "WIB/fixture targets, mask openings, pitch, edge/component/keep-out clearances, probe approach, density, and allowed test side shall meet the selected fixture and tester rules.", "Fixture target geometry and clearances", "TO_BE_DEFINED", "Fixture supplier and factory/test engineering"),
    factoryConstraint("WIB-MECHANICAL-001", "MECHANICAL", "The WIB and fixture shall meet connector mating, keying, support, clamp, deflection, strain-relief, service-life, and repeatable-orientation requirements.", "Mechanical load, deflection, alignment, and mating life", "RANGE", "Mechanical/fixture engineering and factory"),
    factoryConstraint("WIB-TESTER-001", "TESTER_CAPACITY", "Required tester sources, measurements, grounds, guards, loads, communication endpoints, relay/mux resources, and parallel sites shall fit available station capacity with approved margin.", "Tester resource count and simultaneous load", "MINIMUM", "Test engineering and factory"),
    factoryConstraint("WIB-THROUGHPUT-001", "THROUGHPUT", "The complete test flow shall meet the production cycle-time, retry, uptime, diagnostics, traceability, and maintenance requirements.", "Cycle time, availability, repeatability, and logging completeness", "RANGE", "Manufacturing engineering and quality")
  );
  return constraints;
}

function renderReport(plan: ManufacturingTestPlan) {
  const cards = plan.recommendations.map((item) => `<article><div class="card-head"><span class="priority ${item.priority.toLowerCase()}">${html(item.priority)}</span><span>${html(item.category)}</span></div><h2>${html(item.title)}</h2><p>${html(item.rationale)}</p><dl><dt>NET NAME evidence</dt><dd>${item.net_names.map((net) => `<code>${html(net)}</code>`).join(" ")}</dd><dt>Suggested test</dt><dd>${html(item.suggested_test)}</dd><dt>Stimulus</dt><dd>${html(item.stimulus)}</dd><dt>Observation</dt><dd>${html(item.observation)}</dd><dt>Missing inputs</dt><dd><ul>${item.missing_inputs.map((input) => `<li>${html(input)}</li>`).join("")}</ul></dd><dt>Evidence required to close REVIEW</dt><dd>${html(item.closure_evidence)}</dd></dl></article>`).join("");
  const wibCards = plan.wib_design_recommendations.map((item) => `<article><div class="card-head"><span class="priority ${item.priority.toLowerCase()}">${html(item.priority)}</span><span>${html(item.category)}</span></div><h2>${html(item.title)}</h2><p>${html(item.recommendation)}</p><dl><dt>Related NET NAME values</dt><dd>${item.related_net_names.map((net) => `<code>${html(net)}</code>`).join(" ")}</dd><dt>Why</dt><dd>${html(item.rationale)}</dd><dt>Validation needed</dt><dd>${html(item.validation_needed)}</dd></dl></article>`).join("");
  const constraintRows = plan.wib_constraints.map((constraint) => `<tr><td><code>${html(constraint.id)}</code></td><td>${html(constraint.area)}</td><td>${html(constraint.requirement)}</td><td>${html(constraint.metric)}</td><td>${html(constraint.comparator)}</td><td>${constraint.required_value == null ? '<span class="missing">TBD by authority</span>' : html(constraint.required_value)}${constraint.unit ? ` ${html(constraint.unit)}` : ""}</td><td>${html(constraint.verification_mode)}</td><td>${html(constraint.owner)}</td></tr>`).join("");
  const diagnostics = plan.diagnostics.map((diagnostic) => `<li><strong>${html(diagnostic.code)}</strong> — ${html(diagnostic.message)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Manufacturing test and WIB design recommendations</title><style>${css()}</style></head><body><main><header><div><p class="eyebrow">CircuitInspector · DOCUMENT_BACKED</p><h1>Manufacturing test and WIB design plan</h1><p>${html(plan.product.source_path)} · revision ${html(plan.product.revision ?? "not supplied")}</p></div><span class="verdict">REVIEW</span></header><section class="summary"><strong>${plan.recommendation_count}</strong><span>test groups, ${plan.wib_design_recommendations.length} WIB design recommendations, and ${plan.wib_constraints.length} hard-constraint rows generated from ${new Set(plan.product.pins.map((pin) => pin.net_name)).size} NET NAME values</span></section><section class="diagnostics"><h2>Scope and missing evidence</h2><ul>${diagnostics}</ul></section><h1 class="section-title">Manufacturing-line test recommendations</h1><section class="cards">${cards || "<p>No test recommendations could be derived from the imported connector NET NAME values.</p>"}</section><h1 class="section-title">Corresponding WIB design recommendations</h1><section class="cards">${wibCards || "<p>No WIB design recommendations could be derived.</p>"}</section><h1 class="section-title">WIB constraints and hard metrics</h1><p class="constraint-note">Connectivity constraints are anchored to the product schematic. Numeric electrical, geometry, mechanical, tester, and throughput limits remain REVIEW until an applicable approved project/factory/tester source supplies the exact value, unit, comparator, and revision.</p><section class="table-wrap"><table><thead><tr><th>ID</th><th>Area</th><th>Hard requirement</th><th>Metric</th><th>Comparator</th><th>Required value</th><th>Verification</th><th>Owner</th></tr></thead><tbody>${constraintRows}</tbody></table></section><footer>This is a schematic-backed planning list, not production acceptance. Final methods, limits, fixture access, safety, repeatability, cycle time, and coverage require the exact factory/tester evidence.</footer></main></body></html>`;
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

function html(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
