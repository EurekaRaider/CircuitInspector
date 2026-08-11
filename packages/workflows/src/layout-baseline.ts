import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesignSummary, LayoutBaselineConfirmation } from "@circuit-inspector/contracts";
import { invalidateDependentAnalyses } from "./invalidation.js";
import { readManufacturingTestPlan } from "./test-recommendations.js";

export interface ConfirmLayoutBaselineInput {
  design: DesignSummary;
  approvedTestPlanId: string;
  sourceUnits: LayoutBaselineConfirmation["source_units"];
  coordinateOrigin: string;
  bottomMirroredInTopView: boolean;
  panelStepRepeat: string;
  approvedBy: string;
}

export async function confirmLayoutBaseline(input: ConfirmLayoutBaselineInput, cacheDir: string): Promise<LayoutBaselineConfirmation> {
  const plan = await readManufacturingTestPlan(input.approvedTestPlanId, cacheDir);
  if (input.design.format !== "ODBPP") throw new Error("formal Layout DFT closure requires an ODB++ design");
  if (plan.lifecycle_status !== "APPROVED" || !plan.approval) throw new Error(`test plan ${plan.id} must be APPROVED before confirming the Layout baseline`);
  if (!plan.baseline.product_revision) throw new Error("approved DFT baseline must record a product revision");
  const coordinateOrigin = required(input.coordinateOrigin, "coordinate origin");
  const panelStepRepeat = required(input.panelStepRepeat, "panel step-repeat or explicit unit-board statement");
  const approvedBy = required(input.approvedBy, "Layout baseline approver");
  const approvedAt = new Date().toISOString();
  const controlled = {
    design_id: input.design.id,
    design_content_hash: input.design.content_hash,
    test_plan_id: plan.id,
    test_plan_content_hash: plan.approval.content_hash,
    product_revision: plan.baseline.product_revision,
    variant: plan.baseline.variant,
    panel: plan.baseline.panel,
    source_units: input.sourceUnits,
    coordinate_origin: coordinateOrigin,
    top_view_direction: "FROM_TOP" as const,
    bottom_view_direction: "FROM_BOTTOM" as const,
    bottom_mirrored_in_top_view: input.bottomMirroredInTopView,
    panel_step_repeat: panelStepRepeat,
    approved_by: approvedBy,
    approved_at: approvedAt
  };
  const contentHash = createHash("sha256").update(JSON.stringify(controlled)).digest("hex");
  const confirmation: LayoutBaselineConfirmation = {
    schema_version: 1,
    id: layoutBaselineId(input.design.id),
    status: "APPROVED",
    ...controlled,
    content_hash: contentHash
  };
  const directory = path.join(cacheDir, "layout-baselines");
  await mkdir(directory, { recursive: true });
  await invalidateDependentAnalyses(cacheDir, (analysis) =>
    analysis.kind === "LAYOUT_TEST_ACCESS_ANALYSIS"
    && analysis.test_plan_id === plan.id
    && (analysis.design_content_hash !== input.design.content_hash || analysis.layout_baseline_content_hash !== contentHash),
  `A new controlled Layout baseline was approved for DFT plan ${plan.id}.`);
  await writeFile(path.join(directory, `${confirmation.id}.json`), JSON.stringify(confirmation, null, 2), "utf8");
  return confirmation;
}

export async function readLayoutBaseline(designId: string, cacheDir: string): Promise<LayoutBaselineConfirmation | null> {
  try {
    return JSON.parse(await readFile(path.join(cacheDir, "layout-baselines", `${layoutBaselineId(designId)}.json`), "utf8")) as LayoutBaselineConfirmation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function safeSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid CircuitInspector identifier");
  return value;
}

function layoutBaselineId(designId: string) {
  return `layout-baseline-${safeSegment(designId)}`;
}
