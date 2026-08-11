import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentAnalysisScreen, wiringReviewGuidance } from "../src/renderer/DocumentAnalysisScreen";
import type { WiringAnalysis } from "../src/renderer/types";

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
