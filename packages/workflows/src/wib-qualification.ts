import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ManufacturingTestRequirement,
  WibInterfaceContract
} from "@circuit-inspector/contracts";
import { readManufacturingTestPlan } from "./test-recommendations.js";
import { invalidateDependentAnalyses } from "./invalidation.js";
import {
  compareFixtureWiring,
  type ConnectorMapping,
  type DesignMetric,
  type NetAlias,
  type PinoutDocument,
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
  verification_mode: "DOCUMENT_BACKED" | "MANUAL_FACTORY_CONFIRMATION";
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
  product_content_hash?: string;
  wib_content_hash?: string;
  interface_contract_content_hash?: string;
  test_plan_content_hash?: string;
  constraint_set_content_hash?: string;
  interface_contract_id?: string;
  test_plan_id?: string;
  verdict: WiringVerdict;
  verification_mode: "DOCUMENT_BACKED";
  wiring_analysis_id: string;
  wiring_verdict: WiringVerdict;
  pass_count: number;
  fail_count: number;
  review_count: number;
  not_applicable_count: number;
  constraint_results: WibConstraintResult[];
  requirement_results?: WibRequirementResult[];
  production_readiness_verdict?: "REVIEW";
  factory_confirmation_items?: WibFactoryConfirmationItem[];
  violations: Array<WibConstraintResult & { rule_id: string; title: string; severity: "ERROR" | "WARNING"; net_names: string[]; component_refs: string[] }>;
  report_uri: string;
  report_path: string;
  elapsed_ms: number;
}

export interface WibRequirementResult {
  id: string;
  requirement_id: string;
  status: WiringVerdict;
  verification_mode: "DOCUMENT_BACKED";
  access_strategy: ManufacturingTestRequirement["access_strategy"];
  target_net_names: string[];
  wiring_connection_ids: string[];
  responsibility_boundary: string;
  message: string;
  evidence: string[];
}

export interface WibFactoryConfirmationItem {
  id: string;
  status: "REVIEW";
  verification_mode: "MANUAL_FACTORY_CONFIRMATION";
  requirement: string;
  closure_evidence: string;
}

export interface CreateWibInterfaceContractInput {
  title: string;
  revision: string;
  approvedBy: string;
  productPinoutId: string;
  wibPinoutId: string;
  connectorMappings: ConnectorMapping[];
  netAliases?: NetAlias[];
  caseSensitive?: boolean;
}

export async function createWibInterfaceContract(
  input: CreateWibInterfaceContractInput,
  cacheDir: string
): Promise<WibInterfaceContract> {
  if (!input.title.trim() || !input.revision.trim() || !input.approvedBy.trim()) {
    throw new Error("Interface contract title, revision, and approved_by are required");
  }
  const wiring = await compareFixtureWiring(input.productPinoutId, input.wibPinoutId, cacheDir, {
    connectorMappings: input.connectorMappings,
    ...(input.netAliases ? { netAliases: input.netAliases } : {}),
    ...(input.caseSensitive !== undefined ? { caseSensitive: input.caseSensitive } : {})
  });
  const product = wiring.product;
  const wib = wiring.wib;
  assertContractPinout(product, "product");
  assertContractPinout(wib, "WIB");
  const mappings = validateInterfaceMappings(input.connectorMappings, product, wib);
  const aliases = validateInterfaceAliases(input.netAliases ?? []);
  const approvalPayload = {
    title: input.title.trim(),
    revision: input.revision.trim(),
    product_pinout_id: product.id,
    wib_pinout_id: wib.id,
    product_revision: product.revision,
    wib_revision: wib.revision,
    product_content_hash: product.confirmation!.content_hash,
    wib_content_hash: wib.confirmation!.content_hash,
    connector_mappings: mappings,
    net_aliases: aliases,
    case_sensitive: input.caseSensitive ?? false
  };
  const contentHash = sha256(JSON.stringify(approvalPayload));
  const contract: WibInterfaceContract = {
    schema_version: 1,
    id: `wib-interface-${contentHash.slice(0, 18)}`,
    title: approvalPayload.title,
    revision: approvalPayload.revision,
    status: "APPROVED",
    product_pinout_id: product.id,
    wib_pinout_id: wib.id,
    product_revision: product.revision!,
    wib_revision: wib.revision!,
    connector_mappings: mappings,
    net_aliases: aliases,
    case_sensitive: approvalPayload.case_sensitive,
    approved_by: input.approvedBy.trim(),
    approved_at: new Date().toISOString(),
    content_hash: contentHash
  };
  const directory = path.join(cacheDir, "wib-interface-contracts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${safeSegment(contract.id)}.json`), JSON.stringify(contract, null, 2), "utf8");
  await invalidateDependentAnalyses(
    cacheDir,
    (analysis) => analysis.kind === "WIB_DESIGN_QUALIFICATION"
      && analysis.product_pinout_id === contract.product_pinout_id
      && analysis.wib_pinout_id === contract.wib_pinout_id
      && analysis.interface_contract_id !== contract.id,
    `A new approved product-to-WIB interface contract ${contract.id} supersedes the contract used by this qualification`
  );
  return contract;
}

export async function readWibInterfaceContract(id: string, cacheDir: string): Promise<WibInterfaceContract> {
  const contract = JSON.parse(await readFile(path.join(cacheDir, "wib-interface-contracts", `${safeSegment(id)}.json`), "utf8")) as WibInterfaceContract;
  if (contract.status !== "APPROVED" || contract.schema_version !== 1) throw new Error(`${id} is not an approved WIB interface contract`);
  return contract;
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
  const supersededIds = new Set<string>();
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const existing = JSON.parse(await readFile(path.join(directory, name), "utf8")) as WibConstraintSet;
      if (existing.id !== constraintSet.id && existing.title === constraintSet.title) supersededIds.add(existing.id);
    } catch {
      // Invalid cached artifacts are reported by the artifact catalog and must not block a new controlled set.
    }
  }
  await writeFile(path.join(directory, `${safeSegment(constraintSet.id)}.json`), JSON.stringify(constraintSet, null, 2), "utf8");
  if (supersededIds.size) {
    await invalidateDependentAnalyses(
      cacheDir,
      (analysis) => analysis.kind === "WIB_DESIGN_QUALIFICATION" && typeof analysis.constraint_set_id === "string" && supersededIds.has(analysis.constraint_set_id),
      `Approved WIB constraint set ${constraintSet.id} supersedes an earlier revision with the same controlled title`
    );
  }
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

export async function qualifyWibClosedLoop(
  productPinoutId: string,
  wibPinoutId: string,
  interfaceContractId: string,
  approvedTestPlanId: string,
  approvedConstraintSetId: string,
  cacheDir: string
): Promise<WibQualification> {
  const started = performance.now();
  const [contract, testPlan, constraintSet] = await Promise.all([
    readWibInterfaceContract(interfaceContractId, cacheDir),
    readManufacturingTestPlan(approvedTestPlanId, cacheDir),
    readWibConstraintSet(approvedConstraintSetId, cacheDir)
  ]);
  if (testPlan.lifecycle_status !== "APPROVED" || !testPlan.approval) throw new Error(`${approvedTestPlanId} is not an APPROVED DFT requirement baseline`);
  if (contract.product_pinout_id !== productPinoutId || contract.wib_pinout_id !== wibPinoutId) {
    throw new Error("WIB interface contract does not match the selected product and WIB pinouts");
  }
  if (testPlan.product_pinout_id !== productPinoutId) throw new Error("Approved test plan does not match the selected product pinout");
  if (testPlan.baseline.product_revision !== contract.product_revision) throw new Error("Product revision differs between the DFT baseline and WIB interface contract");

  const wiring = await compareFixtureWiring(productPinoutId, wibPinoutId, cacheDir, {
    connectorMappings: contract.connector_mappings,
    netAliases: contract.net_aliases,
    caseSensitive: contract.case_sensitive
  });
  assertQualificationRevision(wiring.product, contract.product_revision, "product");
  assertQualificationRevision(wiring.wib, contract.wib_revision, "WIB");

  const wiringClosure: WibConstraintResult = {
    id: "qualification-mandatory-wiring",
    constraint_id: "MANDATORY-PRODUCT-WIB-WIRING",
    status: wiring.verdict === "PASS" ? "PASS" : wiring.verdict === "FAIL" ? "FAIL" : "REVIEW",
    verification_mode: "DOCUMENT_BACKED",
    area: "CONNECTIVITY",
    requirement: "The confirmed actual WIB schematic shall match the approved connector and pin interface contract.",
    metric_id: null,
    comparator: "ALL",
    required_value: "PASS",
    actual_value: wiring.verdict,
    unit: null,
    message: wiring.verdict === "PASS" ? "Approved pin-to-pin interface contract passed." : `Approved pin-to-pin interface contract is ${wiring.verdict}; see ${wiring.id}.`,
    evidence: [`circuit://analysis/${wiring.id}/report`, `circuit://artifact/${contract.id}`]
  };
  const constraintResults = [
    wiringClosure,
    ...constraintSet.constraints.map((constraint) => evaluateConstraint(constraint, wiring, wiring.wib.design_metrics ?? [], wiring.wib.status === "CONFIRMED"))
  ];
  const requirementResults = testPlan.requirements.map((requirement) => evaluateWibRequirement(requirement, wiring, contract));
  const allResults = [...constraintResults, ...requirementResults];
  const passCount = allResults.filter((result) => result.status === "PASS").length;
  const failCount = allResults.filter((result) => result.status === "FAIL").length;
  const reviewCount = allResults.filter((result) => result.status === "REVIEW").length;
  const notApplicableCount = allResults.filter((result) => result.status === "NOT_APPLICABLE").length;
  const verdict: WiringVerdict = failCount ? "FAIL" : reviewCount ? "REVIEW" : passCount ? "PASS" : "NOT_APPLICABLE";
  const identity = JSON.stringify({
    product: wiring.product.confirmation?.content_hash,
    wib: wiring.wib.confirmation?.content_hash,
    interfaceContract: contract.content_hash,
    testPlan: testPlan.approval.content_hash,
    constraints: constraintSet.content_hash
  });
  const id = `wib-qualification-${sha256(identity).slice(0, 18)}`;
  const directory = path.join(cacheDir, "evidence", id);
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "report.html");
  const factoryConfirmationItems = createWibFactoryConfirmationItems();
  const qualification: WibQualification = {
    schema_version: 1,
    kind: "WIB_DESIGN_QUALIFICATION",
    id,
    product_pinout_id: wiring.product.id,
    wib_pinout_id: wiring.wib.id,
    constraint_set_id: constraintSet.id,
    product_content_hash: wiring.product.confirmation!.content_hash,
    wib_content_hash: wiring.wib.confirmation!.content_hash,
    interface_contract_content_hash: contract.content_hash,
    test_plan_content_hash: testPlan.approval.content_hash,
    constraint_set_content_hash: constraintSet.content_hash,
    interface_contract_id: contract.id,
    test_plan_id: testPlan.id,
    verdict,
    verification_mode: "DOCUMENT_BACKED",
    wiring_analysis_id: wiring.id,
    wiring_verdict: wiring.verdict,
    pass_count: passCount,
    fail_count: failCount,
    review_count: reviewCount,
    not_applicable_count: notApplicableCount,
    constraint_results: constraintResults,
    requirement_results: requirementResults,
    production_readiness_verdict: "REVIEW",
    factory_confirmation_items: factoryConfirmationItems,
    violations: [
      ...constraintResults.filter((result) => result.status !== "PASS" && result.status !== "NOT_APPLICABLE").map((result) => ({
        ...result,
        rule_id: result.constraint_id,
        title: result.requirement,
        severity: result.status === "FAIL" ? "ERROR" as const : "WARNING" as const,
        net_names: [],
        component_refs: []
      })),
      ...requirementResults.filter((result) => result.status !== "PASS" && result.status !== "NOT_APPLICABLE").map((result) => ({
        id: result.id,
        constraint_id: result.requirement_id,
        status: result.status,
        verification_mode: result.verification_mode,
        area: "DFT_REQUIREMENT",
        requirement: result.message,
        metric_id: null,
        comparator: "ALL" as const,
        required_value: "TRACEABLE_WIB_PATH",
        actual_value: result.wiring_connection_ids.length,
        unit: null,
        message: result.message,
        evidence: result.evidence,
        rule_id: result.requirement_id,
        title: result.message,
        severity: result.status === "FAIL" ? "ERROR" as const : "WARNING" as const,
        net_names: result.target_net_names,
        component_refs: []
      }))
    ],
    report_uri: `circuit://analysis/${id}/report`,
    report_path: reportPath,
    elapsed_ms: Math.round(performance.now() - started)
  };
  await writeFile(reportPath, renderQualificationReport(qualification, constraintSet, wiring, contract, testPlan.approval.content_hash), "utf8");
  await writeFile(path.join(directory, "analysis.json"), JSON.stringify(qualification, null, 2), "utf8");
  return qualification;
}

function assertContractPinout(pinout: PinoutDocument, label: string) {
  if (pinout.status !== "CONFIRMED" || !pinout.confirmation) throw new Error(`${label} pinout must be CONFIRMED before interface-contract approval`);
  if (!pinout.revision?.trim()) throw new Error(`${label} revision is required before interface-contract approval`);
}

function assertQualificationRevision(pinout: PinoutDocument, expectedRevision: string, label: string) {
  if (pinout.status !== "CONFIRMED" || !pinout.confirmation) throw new Error(`${label} pinout is no longer CONFIRMED`);
  if (pinout.revision !== expectedRevision) throw new Error(`${label} revision ${pinout.revision ?? "MISSING"} does not match approved interface revision ${expectedRevision}`);
}

function validateInterfaceMappings(
  mappings: ConnectorMapping[],
  product: PinoutDocument,
  wib: PinoutDocument
): Array<{ product_connector: string; wib_connector: string; pin_map: Array<{ product_pin: string; wib_pin: string }> }> {
  if (!mappings.length) throw new Error("At least one explicit connector mapping is required");
  const productPins = new Set(product.pins.map((pin) => pinIdentity(pin.connector, pin.pin)));
  const wibPins = new Set(wib.pins.map((pin) => pinIdentity(pin.connector, pin.pin)));
  const mappedProductPins = new Set<string>();
  const mappedWibPins = new Set<string>();
  const normalized = mappings.map((mapping) => {
    const productConnector = mapping.product_connector.trim();
    const wibConnector = mapping.wib_connector.trim();
    if (!productConnector || !wibConnector || !mapping.pin_map?.length) {
      throw new Error("Every approved interface mapping requires product connector, WIB connector, and an explicit pin_map");
    }
    const pinMap = mapping.pin_map.map((pair) => {
      const productPin = pair.product_pin.trim();
      const wibPin = pair.wib_pin.trim();
      if (!productPin || !wibPin) throw new Error("Interface pin-map entries cannot be empty");
      const productId = pinIdentity(productConnector, productPin);
      const wibId = pinIdentity(wibConnector, wibPin);
      if (!productPins.has(productId)) throw new Error(`Interface contract references missing product pin ${productConnector}.${productPin}`);
      if (!wibPins.has(wibId)) throw new Error(`Interface contract references missing WIB pin ${wibConnector}.${wibPin}`);
      if (mappedProductPins.has(productId)) throw new Error(`Product pin ${productConnector}.${productPin} is mapped more than once`);
      if (mappedWibPins.has(wibId)) throw new Error(`WIB pin ${wibConnector}.${wibPin} is mapped more than once`);
      mappedProductPins.add(productId);
      mappedWibPins.add(wibId);
      return { product_pin: productPin, wib_pin: wibPin };
    });
    return { product_connector: productConnector, wib_connector: wibConnector, pin_map: pinMap };
  });
  const missingProduct = [...productPins].filter((pin) => !mappedProductPins.has(pin));
  const missingWib = [...wibPins].filter((pin) => !mappedWibPins.has(pin));
  if (missingProduct.length || missingWib.length) {
    throw new Error(`Approved interface contract must cover every confirmed interface pin; missing product=${missingProduct.join(", ") || "none"}, WIB=${missingWib.join(", ") || "none"}`);
  }
  return normalized;
}

function validateInterfaceAliases(aliases: NetAlias[]): NetAlias[] {
  const productNets = new Set<string>();
  const wibNets = new Set<string>();
  return aliases.map((alias) => {
    const productNet = alias.product_net.trim();
    const wibNet = alias.wib_net.trim();
    if (!productNet || !wibNet) throw new Error("NET aliases cannot be empty");
    if (productNets.has(key(productNet)) || wibNets.has(key(wibNet))) throw new Error("Each NET alias endpoint may appear only once");
    productNets.add(key(productNet));
    wibNets.add(key(wibNet));
    return { product_net: productNet, wib_net: wibNet };
  });
}

function evaluateWibRequirement(
  requirement: ManufacturingTestRequirement,
  wiring: WiringAnalysis,
  contract: WibInterfaceContract
): WibRequirementResult {
  const base = {
    id: `wib-requirement-${safeSegment(requirement.id)}`,
    requirement_id: requirement.id,
    verification_mode: "DOCUMENT_BACKED" as const,
    access_strategy: requirement.access_strategy,
    target_net_names: requirement.target_net_names,
    evidence: [`circuit://analysis/${wiring.id}/report`, `circuit://artifact/${contract.id}`]
  };
  if (requirement.access_strategy === "PHYSICAL_PROBE") {
    return {
      ...base,
      status: "NOT_APPLICABLE",
      wiring_connection_ids: [],
      responsibility_boundary: "Layout/ICT or flying-probe access; no WIB path is asserted.",
      message: "This requirement is assigned to direct physical probe access. WIB path qualification is not applicable, while the Layout test-access analysis remains mandatory."
    };
  }
  if (requirement.access_strategy === "TO_BE_ASSIGNED") {
    return {
      ...base,
      status: "REVIEW",
      wiring_connection_ids: [],
      responsibility_boundary: "Test-method owner has not assigned the access path.",
      message: "The approved requirement does not assign a physical, connector, boundary-scan, programming, BIST, or FCT access path."
    };
  }
  const targetKeys = new Set(requirement.target_net_names.map((net) => contract.case_sensitive ? net.trim() : key(net)));
  const connections = wiring.connections.filter((connection) => {
    if (!connection.product_net) return false;
    const candidate = contract.case_sensitive ? connection.product_net.trim() : key(connection.product_net);
    return targetKeys.has(candidate);
  });
  const evidence = [...base.evidence, ...connections.map((connection) => `circuit://analysis/${wiring.id}/connection/${connection.id}`)];
  if (!connections.length) {
    return {
      ...base,
      status: "REVIEW",
      wiring_connection_ids: [],
      responsibility_boundary: `${requirement.access_strategy} path requires a controlled station/WIB allocation.`,
      message: "No approved product-to-WIB interface path can be linked to the requirement target NETs. An indirect functional stimulus or observation must be explicitly allocated rather than inferred from NET NAME.",
      evidence
    };
  }
  const status: WiringVerdict = connections.some((connection) => connection.verdict === "FAIL")
    ? "FAIL"
    : connections.some((connection) => connection.verdict === "REVIEW")
      ? "REVIEW"
      : requirement.access_strategy === "BOUNDARY_SCAN"
        ? "REVIEW"
        : "PASS";
  const message = status === "FAIL"
    ? "At least one confirmed interface path assigned to this test requirement is miswired."
    : status === "REVIEW" && requirement.access_strategy === "BOUNDARY_SCAN"
      ? "The connector path is traced, but exact BSDL, chain order, voltage-domain, chain-test, and production-execution evidence are still required."
      : status === "REVIEW"
        ? "At least one assigned interface path lacks confirmed endpoint or wiring evidence."
        : "All directly assigned product-to-WIB interface paths for this requirement match the approved pin contract.";
  return {
    ...base,
    status,
    wiring_connection_ids: connections.map((connection) => connection.id),
    responsibility_boundary: `${requirement.access_strategy} path is allocated to the WIB/static design review; station execution remains a separate production gate.`,
    message,
    evidence
  };
}

function createWibFactoryConfirmationItems(): WibFactoryConfirmationItem[] {
  const items: Array<[string, string, string]> = [
    ["actual-wib-harness", "Validate the actual WIB, harness, connector keying, mating life, and fixture build.", "As-built inspection plus continuity and known-fault evidence for the released station."],
    ["tester-resources", "Validate instrument channels, voltage/current capability, relay topology, isolation, protection, and parallel-resource allocation.", "Approved tester configuration and measured resource-capability results."],
    ["powered-safety", "Validate powered interlocks, back-power prevention, discharge, watchdog/reset recovery, and safe failure handling.", "Witnessed safety review and powered pilot logs on the exact fixture and product revision."],
    ["programming-security", "Validate programming image authority, device identity, recovery, security-lock sequence, and secret-handling boundary.", "Traceable production programming logs without exposing credentials or secrets."],
    ["repeatability-throughput", "Validate measurement repeatability, cycle time, parallel execution, contact stability, and false-failure handling.", "Approved repeatability study, cycle-time evidence, and maintenance limits."],
    ["pilot-acceptance", "Validate known-good, known-fault, pilot-yield, repair-localization, and production acceptance behavior.", "Pilot report and signed manufacturing/test release for the selected factory and line."]
  ];
  return items.map(([id, requirement, closureEvidence]) => ({
    id: `wib-factory-${id}`,
    status: "REVIEW" as const,
    verification_mode: "MANUAL_FACTORY_CONFIRMATION" as const,
    requirement,
    closure_evidence: closureEvidence
  }));
}

function pinIdentity(connector: string, pin: string) {
  return `${key(connector)}::${key(pin)}`;
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
  if (constraint.verification_mode === "MANUAL_FACTORY_CONFIRMATION") {
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
    if (!(["DOCUMENT_BACKED", "MANUAL_FACTORY_CONFIRMATION"] as const).includes(constraint.verification_mode)) throw new Error(`${constraint.id} has an invalid verification_mode`);
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

function renderQualificationReport(
  qualification: WibQualification,
  set: WibConstraintSet,
  wiring: WiringAnalysis,
  contract?: WibInterfaceContract,
  testPlanContentHash?: string
) {
  const rows = qualification.constraint_results.map((result) => `<tr class="${result.status.toLowerCase()}"><td>${html(result.status)}</td><td>${html(result.constraint_id)}</td><td>${html(result.area)}</td><td>${html(result.requirement)}</td><td>${html(result.comparator)}</td><td>${html(formatRequired(result.required_value, result.unit))}</td><td>${html(result.actual_value == null ? "MISSING" : formatValue(result.actual_value, result.unit))}</td><td>${html(result.message)}</td></tr>`).join("");
  const requirementRows = (qualification.requirement_results ?? []).map((result) => `<tr class="${result.status.toLowerCase()}"><td>${html(result.status)}</td><td>${html(result.requirement_id)}</td><td>${html(result.access_strategy)}</td><td>${html(result.target_net_names.join(", "))}</td><td>${html(result.responsibility_boundary)}</td><td>${html(result.message)}</td></tr>`).join("");
  const factoryRows = (qualification.factory_confirmation_items ?? []).map((item) => `<tr class="review"><td>REVIEW</td><td>${html(item.requirement)}</td><td>${html(item.closure_evidence)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>WIB qualification ${html(qualification.verdict)}</title><style>${css()}</style></head><body><main><header><div><p>CircuitInspector · CLOSED-LOOP WIB DESIGN REVIEW</p><h1>WIB static design qualification</h1><span>${html(qualification.id)}</span></div><div><strong class="verdict ${qualification.verdict.toLowerCase()}">DESIGN ${html(qualification.verdict)}</strong>${qualification.production_readiness_verdict ? `<strong class="verdict review">PRODUCTION ${qualification.production_readiness_verdict}</strong>` : ""}</div></header><section class="metrics"><div><b>${qualification.pass_count}</b> PASS</div><div><b>${qualification.fail_count}</b> FAIL</div><div><b>${qualification.review_count}</b> REVIEW</div><div><b>${qualification.not_applicable_count}</b> N/A</div></section><section><h2>Controlled inputs</h2><ul><li>Product pinout: ${html(qualification.product_pinout_id)} · SHA-256 ${html(qualification.product_content_hash ?? "not recorded")}</li><li>Actual WIB pinout: ${html(qualification.wib_pinout_id)} · SHA-256 ${html(qualification.wib_content_hash ?? "not recorded")}</li>${contract ? `<li>Interface contract: ${html(contract.id)} · revision ${html(contract.revision)} · approved by ${html(contract.approved_by)} · SHA-256 ${html(contract.content_hash)}</li>` : ""}${qualification.test_plan_id ? `<li>Approved DFT baseline: ${html(qualification.test_plan_id)} · SHA-256 ${html(testPlanContentHash ?? "MISSING")}</li>` : ""}<li>Constraint set: ${html(set.id)} · revision ${html(set.revision)} · approved by ${html(set.approved_by)} · SHA-256 ${html(set.content_hash)}</li><li>Wiring analysis: <code>${html(wiring.id)}</code> · ${html(wiring.verdict)}</li></ul></section><section><h2>Hard-constraint results</h2><table><thead><tr><th>Status</th><th>ID</th><th>Area</th><th>Requirement</th><th>Comparator</th><th>Required</th><th>Actual</th><th>Evidence/result</th></tr></thead><tbody>${rows}</tbody></table></section>${qualification.requirement_results ? `<section><h2>Approved DFT requirement → WIB traceability</h2><table><thead><tr><th>Status</th><th>Requirement</th><th>Access</th><th>Target NETs</th><th>Responsibility boundary</th><th>Evidence/result</th></tr></thead><tbody>${requirementRows}</tbody></table></section>` : ""}${qualification.factory_confirmation_items ? `<section><h2>Production release gates</h2><table><thead><tr><th>Status</th><th>Factory confirmation</th><th>Closure evidence</th></tr></thead><tbody>${factoryRows}</tbody></table></section>` : ""}<footer>A static design PASS means the applicable approved pin contract, DFT traceability, and supported constraint checks passed. It does not approve the physical WIB, harness, fixture, tester configuration, powered safety, cycle time, pilot yield, or production release; those remain REVIEW until factory evidence closes every gate.</footer></main></body></html>`;
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
