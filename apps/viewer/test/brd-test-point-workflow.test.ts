import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrdTestPointWorkflow } from "../src/renderer/BrdTestPointWorkflow";
import { DocumentAnalysisScreen } from "../src/renderer/DocumentAnalysisScreen";
import type { SelectedTestPointAnalysisV1 } from "../src/renderer/types";

afterEach(() => vi.unstubAllGlobals());

describe("BRD TP five-step Viewer workflow", () => {
  it("renders all five controlled gates and keeps production release separate", () => {
    vi.stubGlobal("localStorage", { getItem: () => "", setItem: () => undefined });
    vi.stubGlobal("window", { circuitInspector: { platform: "linux" } });
    const markup = renderToStaticMarkup(createElement(BrdTestPointWorkflow, {
      locale: "zh-CN",
      design: undefined,
      rulePacks: [],
      onChooseDesign: async () => undefined,
      onRestoreDesign: async () => undefined,
      onOverlayChange: () => undefined,
      onOpenAnalysis: () => undefined,
      onClose: () => undefined
    }));
    expect(markup).toContain("导入 BRD");
    expect(markup).toContain("导出 / 回导人工 CSV");
    expect(markup).toContain("批准并冻结 TP 清单");
    expect(markup).toContain("Gerber 与人工对齐复核");
    expect(markup).toContain("选择批准规则包并分析 REQUIRED TP");
    expect(markup).toContain("TP 身份、规则裁决、生产放行是三个独立结论");
  });

  it("renders actual Gerber size, binding reason, and production REVIEW in selected analysis", () => {
    vi.stubGlobal("window", { circuitInspector: { platform: "linux", openEvidence: () => undefined } });
    const analysis = {
      schema_version: 1,
      kind: "SELECTED_TEST_POINT_ANALYSIS",
      id: "selected-a",
      design_id: "gerber-a",
      design_content_hash: "design-hash",
      derived_design_id: "derived-a",
      catalog_id: "catalog-a",
      catalog_content_hash: "catalog-hash",
      selection_id: "selection-a",
      selection_content_hash: "selection-hash",
      alignment_id: "alignment-a",
      alignment_content_hash: "alignment-hash",
      rule_pack_id: "rules-a",
      rule_pack_content_hash: "rules-hash",
      geometry_analysis_id: "selected-a",
      verdict: "REVIEW",
      production_readiness_verdict: "REVIEW",
      pass_count: 0,
      fail_count: 0,
      review_count: 1,
      not_applicable_count: 0,
      required_count: 1,
      bindings: [{ candidate_id: "tp1", decision: "REQUIRED", status: "REVIEW", transformed_center: { x: 1_000_000, y: 2_000_000 }, side: "TOP", matched_feature_id: "pad1", matched_layer_id: "top.gtl", matched_net_name: "GND", matched_center: { x: 1_000_000, y: 2_000_000 }, matched_width_nm: 900_000, matched_height_nm: 800_000, message: "Solder-mask semantics are missing." }],
      violations: [], diagnostics: [], report_uri: "circuit://analysis/selected-a/report", report_path: "/tmp/report.html", elapsed_ms: 1
    } satisfies SelectedTestPointAnalysisV1;
    const markup = renderToStaticMarkup(createElement(DocumentAnalysisScreen, { analysis, locale: "zh-CN", onLocaleChange: () => undefined, onOpenDesign: () => undefined }));
    expect(markup).toContain("0.900 × 0.800 mm");
    expect(markup).toContain("Solder-mask semantics are missing.");
    expect(markup).toContain("生产放行固定为 REVIEW");
  });
});
