import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentAnalysisScreen, wiringReviewGuidance } from "../src/renderer/DocumentAnalysisScreen";
import type { LayoutTestAccessAnalysis, WiringAnalysis } from "../src/renderer/types";

afterEach(() => vi.unstubAllGlobals());

describe("wiring REVIEW entry", () => {
  it("explains how NET NAME review is closed", () => {
    expect(wiringReviewGuidance("NET_NAME_REVIEW_ONLY", true)).toEqual({
      title: "补齐精确映射后重新比较",
      body: "当前只比较了两侧 NET NAME 清单，不能证明连接器/引脚一一对应，也不能检测交换。进入 WIB 工作流第 3 步补充映射；若路径仍为草稿，再回第 1/2 步确认 PDF 路径。",
      action: "进入映射与路径复核"
    });
  });

  it("renders a visible action on a REVIEW result", () => {
    vi.stubGlobal("window", { circuitInspector: { platform: "linux" } });
    const pinout = { source_path: "/tmp/input.pdf", revision: "A", status: "DRAFT", pins: [] };
    const analysis = {
      kind: "WIRING_COMPARISON",
      id: "wiring-review",
      product_pinout_id: "product",
      wib_pinout_id: "wib",
      connector_mappings: [],
      net_aliases: [],
      verdict: "REVIEW",
      verification_mode: "DOCUMENT_BACKED",
      pass_count: 0,
      fail_count: 0,
      review_count: 1,
      not_applicable_count: 0,
      product: pinout,
      wib: pinout,
      connections: [],
      net_name_review: [],
      violations: [{
        id: "scope",
        rule_id: "NET_NAME_REVIEW_ONLY",
        title: "NET NAME inventory review only",
        verdict: "REVIEW",
        severity: "WARNING",
        net_names: [],
        component_refs: [],
        layer_ids: [],
        x_nm: 0,
        y_nm: 0,
        message: "Exact pin correspondence is missing.",
        product_connector: null,
        product_pin: null,
        product_net: null,
        wib_connector: null,
        wib_pin: null,
        wib_net: null
      }],
      report_uri: "circuit://analysis/wiring-review/report",
      report_path: "/tmp/report.html",
      diagnostics: []
    } as unknown as WiringAnalysis;

    const markup = renderToStaticMarkup(createElement(DocumentAnalysisScreen, {
      analysis,
      locale: "zh-CN",
      onLocaleChange: () => undefined,
      onOpenDesign: () => undefined,
      onReviewWiring: () => undefined
    }));
    expect(markup).toContain('data-testid="wiring-review-entry"');
    expect(markup).toContain("进入映射与路径复核");
  });
});

describe("Layout DFT baseline evidence", () => {
  it("renders controlled ODB++ baseline checks separately from factory release gates", () => {
    vi.stubGlobal("window", { circuitInspector: { platform: "linux" } });
    const analysis = {
      schema_version: 1,
      kind: "LAYOUT_TEST_ACCESS_ANALYSIS",
      id: "layout-a",
      design_id: "design-a",
      design_content_hash: "design-hash",
      test_plan_id: "plan-a",
      test_plan_content_hash: "plan-hash",
      rule_pack_id: "rules-a",
      rule_pack_content_hash: "rules-hash",
      layout_baseline_confirmation_id: "layout-baseline-design-a",
      layout_baseline_content_hash: "layout-hash",
      geometry_analysis_id: "geometry-a",
      verdict: "PASS",
      production_readiness_verdict: "REVIEW",
      pass_count: 1,
      fail_count: 0,
      review_count: 0,
      not_applicable_count: 0,
      baseline_checks: [{ id: "TOP-BOTTOM-ORIENTATION", status: "PASS", verification_mode: "DOCUMENT_BACKED", requirement: "Confirm viewing convention", recorded_value: "FROM_TOP / FROM_BOTTOM", message: "Controlled orientation recorded." }],
      mappings: [],
      factory_confirmation_items: [{ id: "FACTORY-PILOT", status: "REVIEW", verification_mode: "MANUAL_FACTORY_CONFIRMATION", requirement: "Confirm pilot acceptance", closure_evidence: "Signed pilot release" }],
      diagnostics: [],
      report_uri: "circuit://analysis/layout-a/report",
      report_path: "/tmp/layout.html",
      elapsed_ms: 1
    } satisfies LayoutTestAccessAnalysis;

    const markup = renderToStaticMarkup(createElement(DocumentAnalysisScreen, {
      analysis,
      locale: "zh-CN",
      onLocaleChange: () => undefined,
      onOpenDesign: () => undefined
    }));
    expect(markup).toContain("ODB++ 基线与语义可判定性");
    expect(markup).toContain("TOP-BOTTOM-ORIENTATION");
    expect(markup).toContain("生产放行：REVIEW");
    expect(markup).toContain("Confirm pilot acceptance");
  });
});
