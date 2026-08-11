import {
  ArrowsOutSimpleIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CrosshairIcon,
  FolderOpenIcon,
  FunnelIcon,
  ImageSquareIcon,
  FileHtmlIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  RulerIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import brandMark from "../../assets/icon.svg";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardCanvas, type BoardCanvasHandle } from "./BoardCanvas";
import { DocumentAnalysisScreen } from "./DocumentAnalysisScreen";
import { translate, type Locale, type Translator } from "./i18n";
import { defaultLayerIds, isolatedLayerIds, layerIdsForTestPoint, layerIdsForViolation, testPointFocusZoom, violationFocusZoom, violationHasLocation } from "./pcb-layers";
import { findingVerdictCounts, inferredTestPointsForViolation, reviewRoute, type ReviewRoute } from "./pcb-review";
import { selectApprovedRulePack } from "./rule-catalog";
import type {
  AnalysisSummary,
  DocumentAnalysis,
  BoundsNm,
  DesignSummary,
  LayerSummary,
  LayoutBaselineConfirmation,
  ProgressEvent,
  RuleDefinition,
  RulePack,
  PickResult,
  SearchResult,
  TilePayload,
  TestPointCandidate,
  Violation
} from "./types";

interface Props {
  locale: Locale;
  onLocaleChange(): void;
  deepLinkUrl?: string | null;
  initialDesignId?: string | null;
  onCatalogChanged?(): void;
  onOpenRuleLibrary?(): void;
  onReviewWiring?(analysis: Extract<DocumentAnalysis, { kind: "WIRING_COMPARISON" }>): void;
}

type BusyAction = "ANALYSIS" | "TEST_POINT_REVIEW" | null;

export function PcbWorkspace({ locale, onLocaleChange, deepLinkUrl, initialDesignId, onCatalogChanged, onOpenRuleLibrary, onReviewWiring }: Props) {
  const canvasRef = useRef<BoardCanvasHandle>(null);
  const tileRequest = useRef(0);
  const lastTileRequestKey = useRef("");
  const viewportRef = useRef<{ designId: string; viewport: BoundsNm; zoom: number } | undefined>(undefined);
  const pointerRef = useRef({ xMm: 0, yMm: 0, zoom: 0 });
  const pointerPositionElementRef = useRef<HTMLSpanElement>(null);
  const pointerZoomElementRef = useRef<HTMLSpanElement>(null);
  const testPointReviewRef = useRef<HTMLDivElement>(null);
  const t = useMemo<Translator>(() => (key, variables) => translate(locale, key, variables), [locale]);
  const [design, setDesign] = useState<DesignSummary>();
  const [tile, setTile] = useState<TilePayload | null>(null);
  const [enabledLayers, setEnabledLayers] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisSummary>();
  const [initialViolationFocus, setInitialViolationFocus] = useState<Violation | null>(null);
  const [documentAnalysis, setDocumentAnalysis] = useState<DocumentAnalysis>();
  const [activeViolation, setActiveViolation] = useState<Violation | null>(null);
  const [rulePacks, setRulePacks] = useState<RulePack[]>([]);
  const [selectedRulePack, setSelectedRulePack] = useState("");
  const [approvedTestPlans, setApprovedTestPlans] = useState<Array<{ id: string; title: string }>>([]);
  const [selectedTestPlan, setSelectedTestPlan] = useState("");
  const [layoutBaseline, setLayoutBaseline] = useState<LayoutBaselineConfirmation | null>(null);
  const [layoutUnits, setLayoutUnits] = useState<"MM" | "INCH" | "MIXED">("MM");
  const [layoutOrigin, setLayoutOrigin] = useState("");
  const [panelStepRepeat, setPanelStepRepeat] = useState("");
  const [bottomMirroredInTopView, setBottomMirroredInTopView] = useState(true);
  const [layoutApprover, setLayoutApprover] = useState(() => localStorage.getItem("circuit-inspector.approver") ?? "");
  const [progress, setProgress] = useState<ProgressEvent>();
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [violationFilters, setViolationFilters] = useState({ net_name: "", component_ref: "", rule_id: "", verdict: "" });
  const [queriedViolations, setQueriedViolations] = useState<Violation[] | null>(null);
  const [picked, setPicked] = useState<PickResult | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [viewSide, setViewSide] = useState<"TOP" | "BOTTOM">("TOP");
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);
  const [testPoints, setTestPoints] = useState<TestPointCandidate[]>([]);
  const [activeTestPoint, setActiveTestPoint] = useState<TestPointCandidate | null>(null);
  const [testPointReviewer, setTestPointReviewer] = useState(() => localStorage.getItem("circuit-inspector.approver") ?? "");
  const [confirmedTestPointReport, setConfirmedTestPointReport] = useState<{ report_path: string; confirmed_count: number } | null>(null);

  const loadRules = useCallback(async () => {
    try {
      const [result, catalog] = await Promise.all([
        window.circuitInspector.listRulePacks(),
        window.circuitInspector.listArtifacts()
      ]);
      setRulePacks(result.rule_packs);
      setSelectedRulePack((current) => selectApprovedRulePack(result.rule_packs, current));
      const plans = catalog.artifacts.filter((artifact) => artifact.analysis_kind === "MANUFACTURING_TEST_RECOMMENDATIONS" && artifact.status === "APPROVED").map(({ id, title }) => ({ id, title }));
      setApprovedTestPlans(plans);
      setSelectedTestPlan((current) => plans.some((plan) => plan.id === current) ? current : plans[0]?.id ?? "");
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    void loadRules();
    const disposeProgress = window.circuitInspector.onProgress(setProgress);
    const disposeRuleCatalog = window.circuitInspector.onRuleCatalogChanged(() => void loadRules());
    const refreshOnFocus = () => void loadRules();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      disposeProgress();
      disposeRuleCatalog();
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [loadRules]);

  useEffect(() => {
    if (deepLinkUrl) void openDeepLink(deepLinkUrl);
  }, [deepLinkUrl]);

  useEffect(() => {
    if (!initialDesignId || deepLinkUrl) return;
    setBusy(true);
    window.circuitInspector.getDesignSummary(initialDesignId)
      .then((summary) => {
        setDocumentAnalysis(undefined);
        setAnalysis(undefined);
        showDesign(summary);
      })
      .catch((cause) => setError(message(cause)))
      .finally(() => setBusy(false));
  }, [deepLinkUrl, initialDesignId]);

  useEffect(() => {
    if (!design) return;
    queueMicrotask(() => {
      if (initialViolationFocus) focusViolation(initialViolationFocus, design);
      else canvasRef.current?.fit();
    });
  }, [design, initialViolationFocus]);

  function showDesign(summary: DesignSummary, focusedViolation: Violation | null = null) {
    lastTileRequestKey.current = "";
    setTile(null);
    setViewSide("TOP");
    setEnabledLayers(defaultLayerIds(summary.layers, "TOP"));
    setActiveTestPoint(null);
    setInitialViolationFocus(focusedViolation);
    setDesign(summary);
    setLayoutBaseline(null);
    void window.circuitInspector.listTestPoints(summary.id)
      .then((result) => {
        setTestPoints(result.test_points);
        setConfirmedTestPointReport(result.confirmed_test_points_report);
      })
      .catch((cause) => setError(message(cause)));
    void window.circuitInspector.readLayoutBaseline(summary.id)
      .then((baseline) => {
        setLayoutBaseline(baseline);
        if (!baseline) return;
        setLayoutUnits(baseline.source_units);
        setLayoutOrigin(baseline.coordinate_origin);
        setPanelStepRepeat(baseline.panel_step_repeat);
        setBottomMirroredInTopView(baseline.bottom_mirrored_in_top_view);
        setLayoutApprover(baseline.approved_by);
      })
      .catch((cause) => setError(message(cause)));
  }

  function switchViewSide() {
    if (!design) return;
    const side = viewSide === "TOP" ? "BOTTOM" : "TOP";
    setViewSide(side);
    setEnabledLayers(defaultLayerIds(design.layers, side));
    setActiveTestPoint(null);
  }

  function selectLayer(layer: LayerSummary, additive: boolean) {
    if (!design) return;
    setActiveTestPoint(null);
    if (layer.side === "TOP" || layer.side === "BOTTOM") setViewSide(layer.side);
    setEnabledLayers((current) => additive
      ? current.includes(layer.id) ? current.filter((id) => id !== layer.id) : [...current, layer.id]
      : isolatedLayerIds(design.layers, layer.id));
  }

  function focusTestPoint(point: TestPointCandidate) {
    if (!design) return;
    const sourceLayers = layerIdsForTestPoint(design.layers, point);
    if (sourceLayers.length) {
      setEnabledLayers(sourceLayers);
      const side = design.layers.find((layer) => sourceLayers.includes(layer.id) && (layer.side === "TOP" || layer.side === "BOTTOM"))?.side;
      if (side === "TOP" || side === "BOTTOM") setViewSide(side);
    }
    setActiveViolation(null);
    setPicked(null);
    setActiveTestPoint(point);
    canvasRef.current?.focus(point.center.x, point.center.y, testPointFocusZoom(point.radius_nm));
  }

  function focusViolation(violation: Violation, currentDesign = design) {
    setActiveViolation(violation);
    setActiveTestPoint(null);
    setPicked(null);
    if (!currentDesign || !violationHasLocation(violation)) return;
    const sourceLayers = layerIdsForViolation(currentDesign.layers, violation, testPoints);
    if (sourceLayers.length) {
      setEnabledLayers(sourceLayers);
      const side = currentDesign.layers.find((layer) => sourceLayers.includes(layer.id) && (layer.side === "TOP" || layer.side === "BOTTOM"))?.side;
      if (side === "TOP" || side === "BOTTOM") setViewSide(side);
    }
    canvasRef.current?.focus(violation.x_nm, violation.y_nm, violationFocusZoom(violation));
  }

  function openTestPointReview(violation: Violation) {
    const candidates = inferredTestPointsForViolation(violation, testPoints);
    testPointReviewRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (candidates[0]) {
      focusTestPoint(candidates[0]);
    } else {
      setError(locale === "zh-CN" ? "该 REVIEW 是测试点整体语义问题，当前没有可唯一关联的待复核测试点；请在左侧逐项核对，而不是自动跳到第一项。" : "This REVIEW concerns overall test-point semantics and has no uniquely related pending candidate. Review the candidates in the left panel instead of defaulting to the first item.");
    }
  }

  async function openDeepLink(url: string) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const analysisId = parsed.hostname === "analysis" ? parts[0] : parts.at(-1);
      if (!analysisId) return;
      setBusy(true);
      const loaded = await window.circuitInspector.readAnalysis(analysisId);
      if ("kind" in loaded) {
        setDesign(undefined);
        setAnalysis(undefined);
        setActiveViolation(null);
        setDocumentAnalysis(loaded);
        return;
      }
      const summary = await window.circuitInspector.getDesignSummary(loaded.design_id);
      setDocumentAnalysis(undefined);
      const issue = parsed.searchParams.get("issue");
      const selected = loaded.violations.find((violation) => violation.id === issue) ?? loaded.violations[0] ?? null;
      showDesign(summary, selected);
      setAnalysis(loaded);
      setQueriedViolations(null);
      if (!selected) setActiveViolation(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function chooseDesign() {
    const source = await window.circuitInspector.chooseDesign(locale);
    if (!source) return;
    setBusy(true);
    setError("");
    setAnalysis(undefined);
    setQueriedViolations(null);
    setDocumentAnalysis(undefined);
    setActiveViolation(null);
    try {
      showDesign(await window.circuitInspector.importDesign(source));
      onCatalogChanged?.();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const requestTile = useCallback(
    async (viewport: BoundsNm, zoom: number) => {
      if (!design) return;
      const lod = zoom < 8 ? 2 : zoom < 30 ? 1 : 0;
      const requestKey = [
        design.id,
        viewport.min_x,
        viewport.min_y,
        viewport.max_x,
        viewport.max_y,
        enabledLayers.join(","),
        lod
      ].join(":");
      if (requestKey === lastTileRequestKey.current) return;
      lastTileRequestKey.current = requestKey;
      const request = ++tileRequest.current;
      try {
        const payload = await window.circuitInspector.getTile({
          design_id: design.id,
          viewport,
          layer_ids: enabledLayers,
          lod,
          max_features: 500_000
        });
        if (request === tileRequest.current) setTile(payload);
      } catch (cause) {
        if (request === tileRequest.current) {
          lastTileRequestKey.current = "";
          setError(message(cause));
        }
      }
    },
    [design, enabledLayers]
  );

  const updatePointerStatus = useCallback((point: { xMm: number; yMm: number; zoom: number }) => {
    pointerRef.current = point;
    if (pointerPositionElementRef.current) {
      pointerPositionElementRef.current.textContent = `X ${point.xMm.toFixed(3)} mm  Y ${point.yMm.toFixed(3)} mm`;
    }
    if (pointerZoomElementRef.current) {
      pointerZoomElementRef.current.textContent = `${t("zoom")} ${point.zoom.toFixed(1)} px/mm`;
    }
  }, [t]);

  const handleViewportChange = useCallback((viewport: BoundsNm, zoom: number) => {
    if (design) viewportRef.current = { designId: design.id, viewport, zoom };
    updatePointerStatus({ ...pointerRef.current, zoom });
    void requestTile(viewport, zoom);
  }, [design, requestTile, updatePointerStatus]);

  useEffect(() => {
    const current = viewportRef.current;
    if (!design || !current || current.designId !== design.id) return;
    void requestTile(current.viewport, current.zoom);
  }, [design?.id, enabledLayers, requestTile]);

  async function runAnalysis() {
    if (!design || !selectedRulePack) return;
    setBusy(true);
    setBusyAction("ANALYSIS");
    setError("");
    try {
      const result = await window.circuitInspector.runAnalysis(design.id, selectedRulePack);
      setAnalysis(result);
      setQueriedViolations(null);
      onCatalogChanged?.();
      const first = result.violations.find((violation) => violation.verdict === "FAIL") ?? result.violations[0] ?? null;
      if (first) focusViolation(first);
      else setActiveViolation(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyAction(null);
      setBusy(false);
    }
  }

  async function runTestAccessAnalysis() {
    if (!design || !selectedRulePack || !selectedTestPlan) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.circuitInspector.analyzeTestAccess({
        design_id: design.id,
        approved_test_plan_id: selectedTestPlan,
        approved_rule_pack_id: selectedRulePack
      });
      setDocumentAnalysis(result);
      onCatalogChanged?.();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function approveLayoutBaseline() {
    if (!design || !selectedTestPlan || !layoutOrigin.trim() || !panelStepRepeat.trim() || !layoutApprover.trim()) return;
    setBusy(true);
    setError("");
    try {
      localStorage.setItem("circuit-inspector.approver", layoutApprover.trim());
      const baseline = await window.circuitInspector.confirmLayoutBaseline({
        design_id: design.id,
        approved_test_plan_id: selectedTestPlan,
        source_units: layoutUnits,
        coordinate_origin: layoutOrigin.trim(),
        bottom_mirrored_in_top_view: bottomMirroredInTopView,
        panel_step_repeat: panelStepRepeat.trim(),
        approved_by: layoutApprover.trim()
      });
      setLayoutBaseline(baseline);
      onCatalogChanged?.();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch() {
    if (!design || !search.trim()) return;
    try {
      const result = await window.circuitInspector.searchDesign({ design_id: design.id, query: search.trim(), limit: 40 });
      setSearchResults(result.results);
    } catch (cause) {
      setError(message(cause));
    }
  }

  const pickObject = useCallback(async (point: { xMm: number; yMm: number }) => {
    if (!design) return;
    try {
      const toleranceNm = Math.round(Math.max(30_000, 8 / Math.max(pointerRef.current.zoom, 0.02) * 1_000_000));
      const result = await window.circuitInspector.pickDesign({
        design_id: design.id,
        point: { x: Math.round(point.xMm * 1_000_000), y: Math.round(point.yMm * 1_000_000) },
        tolerance_nm: toleranceNm
      });
      setPicked(result.results[0] ?? null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [design]);

  async function filterViolations() {
    if (!analysis) return;
    try {
      const input = Object.fromEntries(Object.entries(violationFilters).filter(([, value]) => value.trim())) as Record<string, unknown>;
      const result = await window.circuitInspector.queryViolations({ analysis_id: analysis.id, ...input, offset: 0, limit: 1000 });
      setQueriedViolations(result.violations);
      if (result.violations[0]) focusViolation(result.violations[0]);
      else setActiveViolation(null);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function generateEvidence() {
    if (!analysis) return;
    setBusy(true);
    setError("");
    try {
      const ids = violationHasLocation(activeViolation)
        ? [activeViolation!.id]
        : violations.filter(violationHasLocation).map((violation) => violation.id);
      if (ids.length === 0) throw new Error(locale === "zh-CN" ? "这些 REVIEW 只有语义缺失说明，没有可渲染的板上坐标。" : "These REVIEW findings have no renderable board location.");
      const result = await window.circuitInspector.renderEvidence({ analysis_id: analysis.id, violation_ids: ids, width: 1600, height: 1200 });
      onCatalogChanged?.();
      if (result.evidence[0]) await window.circuitInspector.openEvidence(result.evidence[0].png_path);
      const refreshed = await window.circuitInspector.readAnalysis(analysis.id);
      if (!("kind" in refreshed)) setAnalysis(refreshed);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function reviewTestPoints(confirmIds: string[] = [], rejectIds: string[] = [], additions: Array<{ source_kind: "COMPONENT" | "FEATURE"; source_id: string }> = []) {
    if (!design || !testPointReviewer.trim()) {
      setError(locale === "zh-CN" ? "确认测试点前请输入复核人。" : "Enter a reviewer before confirming test points.");
      return;
    }
    setBusy(true);
    setBusyAction("TEST_POINT_REVIEW");
    setError("");
    const priorRulePackId = analysis?.rule_pack_id ?? null;
    try {
      localStorage.setItem("circuit-inspector.approver", testPointReviewer.trim());
      const result = await window.circuitInspector.reviewTestPoints({
        design_id: design.id,
        reviewed_by: testPointReviewer.trim(),
        confirm_ids: confirmIds,
        reject_ids: rejectIds,
        additions
      });
      setTestPoints(result.test_points);
      setConfirmedTestPointReport(result.confirmed_test_points_report);
      showDesign(result.summary);
      if (priorRulePackId) {
        const refreshed = await window.circuitInspector.runAnalysis(result.summary.id, priorRulePackId);
        setAnalysis(refreshed);
        setQueriedViolations(null);
        setActiveViolation(refreshed.violations.find((violation) => violation.verdict === "FAIL") ?? refreshed.violations[0] ?? null);
      } else {
        setAnalysis(undefined);
        setActiveViolation(null);
      }
      setPicked(null);
      onCatalogChanged?.();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusyAction(null);
      setBusy(false);
    }
  }

  const violations = queriedViolations ?? analysis?.violations ?? [];
  const findingCounts = findingVerdictCounts(violations);
  const inferredTestPoints = testPoints.filter((point) => point.confidence === "INFERRED");
  const confirmedTestPointCount = testPoints.filter((point) => point.confidence === "EXPLICIT").length;
  const sourceName = design?.source_path.split(/[\\/]/).at(-1);
  const progressLabel = busyAction === "TEST_POINT_REVIEW"
    ? analysis
      ? locale === "zh-CN" ? "正在保存测试点复核、刷新 Markdown 并重新分析" : "Saving test-point review, refreshing Markdown, and rerunning analysis"
      : locale === "zh-CN" ? "正在保存测试点复核并刷新 Markdown" : "Saving test-point review and refreshing Markdown"
    : progress?.phase === "IMPORT"
    ? progress.progress >= 100 ? t("designIndexed") : t("validatingDesign")
    : progress?.message ?? t("processingLocalData");
  const statusLabel = busy ? progressLabel : design ? `${design.format} · ${t("layers", { count: design.layers.length })}` : t("waitingForImport");

  if (documentAnalysis) {
    return <DocumentAnalysisScreen
      analysis={documentAnalysis}
      locale={locale}
      onLocaleChange={onLocaleChange}
      onOpenDesign={() => design ? setDocumentAnalysis(undefined) : void chooseDesign()}
      onLocateTestPoint={(id) => {
        const point = testPoints.find((candidate) => candidate.id === id);
        if (!point) return;
        setDocumentAnalysis(undefined);
        window.requestAnimationFrame(() => focusTestPoint(point));
      }}
      {...(onReviewWiring ? { onReviewWiring } : {})}
    />;
  }

  return (
    <main className="app-shell grid h-full min-w-[1000px] grid-rows-[64px_minmax(0,1fr)_32px] overflow-hidden text-[#ecebe7]">
      <header className="topbar title-drag grid grid-cols-[272px_minmax(360px,1fr)_auto] items-center px-5">
        <div className={`flex min-w-0 items-center gap-3 ${window.circuitInspector.platform === "darwin" ? "pl-[70px]" : ""}`}>
          <div className="brand-emblem size-9 shrink-0">
            <img src={brandMark} alt="" aria-hidden="true" className="size-9" />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold tracking-[-0.018em] text-[#f0efeb]">CircuitInspector</div>
            <div className="mt-0.5 truncate font-mono text-[10px] tracking-[0.025em] text-[#777875]">{sourceName ?? t("localPcbReview")}</div>
          </div>
        </div>

        <form
          className="search-field title-no-drag mx-auto flex h-9 w-full max-w-[560px] items-center rounded-[10px] border border-white/[0.09] bg-[#101214]/90 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <MagnifyingGlassIcon size={16} className="mr-2.5 shrink-0 text-[#747572]" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[#d9d8d3] outline-none placeholder:text-[#666765]"
            aria-label={t("searchPlaceholder")}
          />
          <kbd className="rounded-md border border-white/[0.08] bg-white/[0.018] px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-[#656663]">Enter</kbd>
        </form>

        <div className="title-no-drag flex items-center gap-2">
          <button
            className="icon-button min-w-9 px-2 font-mono text-[10px]"
            title={locale === "zh-CN" ? t("switchToEnglish") : t("switchToChinese")}
            aria-label={locale === "zh-CN" ? t("switchToEnglish") : t("switchToChinese")}
            onClick={onLocaleChange}
          >
            {locale === "zh-CN" ? "EN" : "中"}
          </button>
          <ToolbarButton label={t("fitBoard")} onClick={() => canvasRef.current?.fit()} disabled={!design}>
            <ArrowsOutSimpleIcon size={16} />
          </ToolbarButton>
          <ToolbarButton label={t("measure")} active={measureMode} onClick={() => setMeasureMode((value) => !value)} disabled={!design}>
            <RulerIcon size={16} />
          </ToolbarButton>
          <button
            className="icon-button min-w-[3.4rem] px-2 font-mono text-[9px] tracking-[0.035em]"
            title={t("switchSide")}
            aria-label={t("switchSide")}
            disabled={!design}
            onClick={switchViewSide}
          >
            {viewSide === "TOP" ? "TOP" : "BOTTOM"}
          </button>
          <button className="primary-button ml-0.5" onClick={() => void chooseDesign()} disabled={busy}>
            <FolderOpenIcon size={16} />
            {t("openDesign")}
          </button>
        </div>
      </header>

      <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
        <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07]">
          <PanelTitle title={t("designStructure")} caption={design ? t("layers", { count: design.layers.length }) : t("noDesign")} />
          {!design ? (
            <div className="px-5 py-10 text-[12px] leading-6 text-[#777875]">{t("emptySidebar")}</div>
          ) : (
            <>
              <div className="border-b border-white/[0.065] px-5 py-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <Metric label={t("components")} value={design.component_count} />
                  <Metric label={t("nets")} value={design.net_count} />
                  <Metric label={t("testPoints")} value={design.test_point_count} />
                  <Metric label={t("drills")} value={design.drill_count} />
                </div>
              </div>
              <div className="border-b border-white/[0.065] px-3 py-3">
                <div className="mb-2 px-2 text-[9px] leading-4 text-[#696a67]">{locale === "zh-CN" ? "单击仅查看该层；Shift+单击可叠加多层。" : "Click for a single-layer view; Shift-click to stack layers."}</div>
                {design.layers.map((layer, index) => {
                  const checked = enabledLayers.includes(layer.id);
                  return (
                    <button
                      key={layer.id}
                      type="button"
                      aria-pressed={checked}
                      className={`group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.04] ${checked ? "bg-white/[0.025]" : ""}`}
                      onClick={(event) => selectLayer(layer, event.shiftKey)}
                    >
                      <span className={`grid size-3.5 place-items-center rounded-[4px] border transition-colors ${checked ? "border-[#c5a063]/70 bg-[#c5a063] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]" : "border-white/[0.18] bg-transparent"}`}>
                        {checked && <span className="size-1.5 rounded-[2px] bg-[#241d14]" />}
                      </span>
                      <span className="size-2 rounded-full" style={{ backgroundColor: layerColor(index) }} />
                      <span className="min-w-0 flex-1 truncate text-[#c9c8c3]">{layer.name}</span>
                      <span className="font-mono text-[10px] text-[#6d6e6b]">{compact(layer.feature_count)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="px-5 py-4">
                <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6e6f6c]">{t("semanticCoverage")}</div>
                <div className="space-y-2.5">
                  {Object.entries(design.semantic_coverage).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between text-[11px]">
                      <span className="text-[#8a8a86]">{coverageName(key, t)}</span>
                      <CoverageBadge value={value} />
                    </div>
                  ))}
                </div>
                <div ref={testPointReviewRef} className="mt-4 scroll-mt-4 border-t border-white/[0.065] pt-3">
                  <div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6e6f6c]"><span>{locale === "zh-CN" ? "测试点身份复核" : "Test-point identity review"}</span><span>{locale === "zh-CN" ? `待复核 ${inferredTestPoints.length} · 已确认 ${confirmedTestPointCount}` : `${inferredTestPoints.length} PENDING · ${confirmedTestPointCount} CONFIRMED`}</span></div>
                  <input className="workbench-input mb-2 h-8 w-full text-[10px]" value={testPointReviewer} onChange={(event) => setTestPointReviewer(event.target.value)} placeholder={locale === "zh-CN" ? "复核人" : "Reviewer"} />
                  {confirmedTestPointReport && <button className="secondary-button mb-2 h-8 w-full px-2 text-[9px]" onClick={() => void window.circuitInspector.openEvidence(confirmedTestPointReport.report_path)}><FileTextIcon size={13} />{locale === "zh-CN" ? `打开已确认测试点 MD · ${confirmedTestPointReport.confirmed_count}` : `Open confirmed test-point MD · ${confirmedTestPointReport.confirmed_count}`}</button>}
                  {busyAction === "TEST_POINT_REVIEW" && <div role="status" className="mb-2 flex items-center gap-2 rounded-md border border-[#c5a063]/20 bg-[#c5a063]/[0.045] px-2 py-2 text-[9px] leading-4 text-[#b99a65]"><CircleNotchIcon size={12} className="shrink-0 animate-spin" />{analysis ? (locale === "zh-CN" ? "正在保存身份结论、更新 MD，并用原规则包重新分析" : "Saving identity decisions, updating the MD, and rerunning the prior rule pack") : (locale === "zh-CN" ? "正在保存身份结论并更新 MD" : "Saving identity decisions and updating the MD")}</div>}
                  <div className="max-h-64 space-y-1 overflow-y-auto">
                    {inferredTestPoints.map((point) => (
                      <div key={point.id} className={`rounded-lg border px-2 py-2 text-[10px] text-[#9b9c98] ${activeTestPoint?.id === point.id ? "border-[#d2b173]/55 bg-[#d2b173]/[0.07]" : "border-white/[0.06]"}`}>
                        <button className="block w-full truncate text-left font-mono text-[#d2b173]" onClick={() => focusTestPoint(point)}>{point.component_ref ?? point.id}</button>
                        <div className="mt-1 truncate">{point.net_name ?? "NET -"}</div>
                        <TestPointReviewEvidence point={point} locale={locale} />
                        <div className="mt-2 grid grid-cols-2 gap-1"><button className="secondary-button h-7 px-1 text-[8px]" disabled={busy} title={locale === "zh-CN" ? "确认该候选确实是测试点；是否符合规则由重新分析决定" : "Confirm that this candidate is a test point; rule compliance is decided by reanalysis"} onClick={() => void reviewTestPoints([point.id])}>{locale === "zh-CN" ? "确认为测试点" : "Confirm identity"}</button><button className="secondary-button h-7 px-1 text-[8px]" disabled={busy} title={locale === "zh-CN" ? "确认该候选不是测试点，并从当前设计缓存移除" : "Confirm this candidate is not a test point and remove it from the current design cache"} onClick={() => { if (window.confirm(locale === "zh-CN" ? "确认该候选不是测试点？它将从当前设计缓存中移除；这不代表规则 PASS。" : "Confirm this candidate is not a test point? It will be removed from the current design cache; this does not mean the rule passes.")) void reviewTestPoints([], [point.id]); }}>{locale === "zh-CN" ? "不是测试点" : "Not a test point"}</button></div>
                      </div>
                    ))}
                    {inferredTestPoints.length === 0 && <p className="text-[10px] leading-4 text-[#70716e]">{locale === "zh-CN" ? "没有待复核候选。已确认测试点已写入上方 Markdown；测试点身份明确不等于规则 PASS。" : "No pending candidates. Confirmed test points are written to the Markdown report above; confirmed identity does not mean rule PASS."}</p>}
                  </div>
                </div>
              </div>
            </>
          )}
        </aside>

        <div className="canvas-stage relative min-h-0 overflow-hidden">
          {design ? (
            <BoardCanvas
              ref={canvasRef}
              bounds={design.bounds}
              tile={tile}
              activeViolation={violationHasLocation(activeViolation) ? activeViolation : null}
              activeTestPoint={activeTestPoint}
              mirrored={viewSide === "BOTTOM"}
              measureMode={measureMode}
              onViewportChange={handleViewportChange}
              onPointerWorld={updatePointerStatus}
              onMeasure={setMeasureDistance}
              onPick={pickObject}
            />
          ) : (
            <EmptyCanvas onOpen={() => void chooseDesign()} t={t} />
          )}
          {design && <div className="pointer-events-none absolute right-5 top-5 rounded-lg border border-white/[0.09] bg-[#101315]/90 px-3 py-2 font-mono text-[9px] text-[#b8b5ae] backdrop-blur-md">{viewSide} TEST CONTACT VIEW · {viewSide === "BOTTOM" ? (locale === "zh-CN" ? "已镜像 · 从板底外侧观看" : "MIRRORED · VIEWED FROM BOTTOM OUTSIDE") : (locale === "zh-CN" ? "未镜像 · 从板顶外侧观看" : "UNMIRRORED · VIEWED FROM TOP OUTSIDE")}</div>}
          {busy && <LoadingRail label={progressLabel} progress={progress?.progress ?? 12} />}
          {activeTestPoint && (
            <div className="popover-surface absolute left-1/2 top-5 flex max-w-[min(680px,calc(100%-40px))] -translate-x-1/2 items-center gap-3 rounded-xl px-4 py-3">
              <CrosshairIcon size={17} className="shrink-0 text-[#e0b86e]" />
              <div className="min-w-0">
                <div className="truncate text-[11px] font-medium text-[#e7e0d4]">{locale === "zh-CN" ? "测试点定位" : "Test-point focus"} · {activeTestPoint.component_ref ?? activeTestPoint.id}</div>
                <div className="mt-1 truncate font-mono text-[9px] text-[#878681]">{activeTestPoint.net_name ?? "NET -"} · X {(activeTestPoint.center.x / 1_000_000).toFixed(3)} mm · Y {(activeTestPoint.center.y / 1_000_000).toFixed(3)} mm</div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[9px] text-[#d1ad6f]">
                  <span>{locale === "zh-CN" ? "测试点直径" : "Test-point diameter"} {formatNm(activeTestPoint.radius_nm == null ? null : activeTestPoint.radius_nm * 2)}</span>
                  <span>{locale === "zh-CN" ? "最近板边净距" : "Nearest board-edge clearance"} {formatNm(activeTestPoint.review_context?.board_edge.distance_nm)}</span>
                  <span>{locale === "zh-CN" ? "最近测试点净距" : "Nearest test-point clearance"} {formatNm(activeTestPoint.review_context?.nearest_test_point?.distance_nm)}{activeTestPoint.review_context?.nearest_test_point ? ` · ${activeTestPoint.review_context.nearest_test_point.id}` : ""}</span>
                  <span>{locale === "zh-CN" ? "最近工装孔净距" : "Nearest tooling-hole clearance"} {formatNm(activeTestPoint.review_context?.nearest_tooling_hole?.distance_nm)}{activeTestPoint.review_context?.nearest_tooling_hole ? ` · ${activeTestPoint.review_context.nearest_tooling_hole.id}${activeTestPoint.review_context.nearest_tooling_hole.confidence === "INFERRED" ? " · REVIEW" : ""}` : ""}</span>
                  <span>{locale === "zh-CN" ? "最近器件净距" : "Nearest component clearance"} {formatNm(activeTestPoint.review_context?.nearest_component?.distance_nm)}{activeTestPoint.review_context?.nearest_component ? ` · ${activeTestPoint.review_context.nearest_component.id}` : ""}</span>
                  <span>{locale === "zh-CN" ? "最近屏蔽结构净距" : "Nearest shield clearance"} {formatNm(activeTestPoint.review_context?.nearest_shield?.distance_nm)}{activeTestPoint.review_context?.nearest_shield ? ` · ${activeTestPoint.review_context.nearest_shield.id} · REVIEW` : ""}</span>
                </div>
              </div>
              <button className="ml-2 rounded-md p-1 text-[#8c8b86] transition-colors hover:bg-white/5 hover:text-[#e7e0d4]" aria-label={locale === "zh-CN" ? "退出测试点定位" : "Exit test-point focus"} onClick={() => setActiveTestPoint(null)}><XIcon size={15} /></button>
            </div>
          )}
          {activeViolation && (
            <div className="popover-surface pointer-events-none absolute bottom-5 left-1/2 w-max max-w-[min(760px,calc(100%-40px))] -translate-x-1/2 rounded-xl px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <VerdictBadge verdict={activeViolation.verdict} />
                <span className="truncate text-[12px] font-medium text-[#e1e0db]">{activeViolation.title}</span>
                <span className="shrink-0 font-mono text-[9px] text-[#6e6f6c]">{activeViolation.rule_id} · #{activeViolation.id}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-[#969691]">
                <span>{t("net")} {activeViolation.net_names.join(", ") || "-"}</span>
                <span>{t("reference")} {activeViolation.component_refs.join(", ") || "-"}</span>
                {violationHasLocation(activeViolation) ? <span className="text-[#d1ad6f]">{t("measured")} {formatNm(activeViolation.measured_value_nm)} / {t("threshold")} {formatNm(activeViolation.threshold_nm)}</span> : <span className="text-[#d1ad6f]">{locale === "zh-CN" ? "仅语义复核，未执行几何测量" : "Semantic review only; no geometry measurement"}</span>}
              </div>
            </div>
          )}
          {searchResults.length > 0 && (
            <div className="popover-surface absolute left-5 top-5 w-[340px] overflow-hidden rounded-xl">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-[#777875]">
                {t("searchResults")}
                <button onClick={() => setSearchResults([])} aria-label={t("closeSearchResults")} className="rounded-md p-1 text-[#777875] transition-colors hover:bg-white/5 hover:text-[#e1e0db]"><XIcon size={14} /></button>
              </div>
              <div className="max-h-72 overflow-y-auto p-2">
                {searchResults.map((result, index) => (
                  <button
                    key={`${result.kind}:${result.id}`}
                    className="reveal-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-[12px] text-[#d1d0cb] transition-colors hover:bg-white/5 active:translate-y-px"
                    style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                    onClick={() => {
                      if (result.xNm != null && result.yNm != null) canvasRef.current?.focus(result.xNm, result.yNm);
                      setSearchResults([]);
                    }}
                  >
                    <span className="rounded-md border border-[#c5a063]/20 bg-[#c5a063]/[0.055] px-1.5 py-0.5 font-mono text-[9px] text-[#cbaa72]">{result.kind}</span>
                    <span className="truncate">{result.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {picked && searchResults.length === 0 && (
            <div className="popover-surface absolute left-5 top-5 max-w-[380px] rounded-xl px-4 py-3">
              <div className="flex items-center gap-2.5 text-[11px]"><span className="font-mono text-[9px] text-[#cbaa72]">{picked.kind}</span><span className="truncate font-medium text-[#e1e0db]">{picked.label}</span></div>
              <div className="mt-2 flex flex-wrap gap-x-4 font-mono text-[9px] text-[#81827f]"><span>{t("layer")} {picked.layer_id ?? "-"}</span><span>{t("net")} {picked.net_name ?? "-"}</span><span>{t("reference")} {picked.component_ref ?? "-"}</span></div>
              {(picked.kind === "FEATURE" || picked.kind === "COMPONENT") && <button className="secondary-button mt-3 h-8 w-full text-[10px]" onClick={() => void reviewTestPoints([], [], [{ source_kind: picked.kind as "COMPONENT" | "FEATURE", source_id: picked.id }])}>{locale === "zh-CN" ? "标记为测试点" : "Mark as test point"}</button>}
            </div>
          )}
          {error && (
            <div role="alert" className="absolute bottom-5 left-5 right-5 flex items-start gap-3 rounded-xl border border-[#b76755]/35 bg-[#35231f]/95 px-4 py-3 text-[12px] text-[#efc1b6] shadow-[0_18px_48px_rgba(6,4,3,0.35)] backdrop-blur-xl">
              <WarningCircleIcon size={17} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <button onClick={() => setError("")} aria-label={t("closeError")} className="rounded-md p-0.5 transition-colors hover:bg-white/5"><XIcon size={15} /></button>
            </div>
          )}
        </div>

        <aside className="sidebar-surface min-h-0 overflow-y-auto border-l border-white/[0.07]">
          <PanelTitle title={t("rulesAndIssues")} caption={analysis ? analysis.verdict : t("notRun")} />
          <div className="border-b border-white/[0.065] p-4">
            <label className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.13em] text-[#6e6f6c]" htmlFor="rule-pack">{t("rulePack")}</label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                id="rule-pack"
                value={selectedRulePack}
                onChange={(event) => setSelectedRulePack(event.target.value)}
                className="h-9 min-w-0 rounded-lg border border-white/[0.09] bg-[#101214] px-2.5 text-[12px] text-[#d0cfca] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-colors focus:border-[#c5a063]/45"
              >
                <option value="">{t("selectApprovedRulePack")}</option>
                {rulePacks.filter((pack) => pack.status === "APPROVED").map((pack) => <option key={pack.id} value={pack.id}>{pack.title}</option>)}
              </select>
              <button className="secondary-button" disabled={!design || !selectedRulePack || busy} onClick={() => void runAnalysis()}>
                {busyAction === "ANALYSIS" ? <CircleNotchIcon size={15} className="animate-spin" /> : <ShieldCheckIcon size={15} />}
                {t("analyze")}
              </button>
            </div>
            <div className="mt-4 border-t border-white/[0.065] pt-3">
              <label className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.13em] text-[#6e6f6c]" htmlFor="test-plan">{locale === "zh-CN" ? "Approved DFT 需求基线" : "Approved DFT baseline"}</label>
              <select id="test-plan" value={selectedTestPlan} onChange={(event) => setSelectedTestPlan(event.target.value)} className="h-9 w-full min-w-0 rounded-lg border border-white/[0.09] bg-[#101214] px-2.5 text-[11px] text-[#d0cfca]"><option value="">{locale === "zh-CN" ? "选择已批准测试计划" : "Select approved test plan"}</option>{approvedTestPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.title} · {plan.id}</option>)}</select>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <select value={layoutUnits} onChange={(event) => setLayoutUnits(event.target.value as "MM" | "INCH" | "MIXED")} className="workbench-input h-8 text-[10px]"><option value="MM">MM</option><option value="INCH">INCH</option><option value="MIXED">MIXED</option></select>
                <input value={layoutOrigin} onChange={(event) => setLayoutOrigin(event.target.value)} className="workbench-input h-8 text-[10px]" placeholder={locale === "zh-CN" ? "坐标原点定义" : "Coordinate origin"} />
                <input value={panelStepRepeat} onChange={(event) => setPanelStepRepeat(event.target.value)} className="workbench-input h-8 text-[10px]" placeholder={locale === "zh-CN" ? "Panel step-repeat / UNIT" : "Panel step-repeat / UNIT"} />
                <input value={layoutApprover} onChange={(event) => setLayoutApprover(event.target.value)} className="workbench-input h-8 text-[10px]" placeholder={locale === "zh-CN" ? "基线批准人" : "Baseline approver"} />
              </div>
              <label className="mt-2 flex items-center gap-2 text-[9px] text-[#777b77]"><input type="checkbox" checked={bottomMirroredInTopView} onChange={(event) => setBottomMirroredInTopView(event.target.checked)} />{locale === "zh-CN" ? "Bottom 在 Top 坐标视图中为镜像；Bottom 接触视图仍从 Bottom 观看" : "Bottom is mirrored in Top coordinates; contact view is still viewed from Bottom"}</label>
              <button className="secondary-button mt-2 w-full" disabled={!design || !selectedTestPlan || !layoutOrigin.trim() || !panelStepRepeat.trim() || !layoutApprover.trim() || busy} onClick={() => void approveLayoutBaseline()}><CheckCircleIcon size={15} />{layoutBaseline && layoutBaseline.design_id === design?.id && layoutBaseline.test_plan_id === selectedTestPlan ? (locale === "zh-CN" ? "Layout 基线已批准" : "Layout baseline approved") : (locale === "zh-CN" ? "批准 Layout 基线" : "Approve Layout baseline")}</button>
              <button className="primary-button mt-2 w-full" disabled={!design || !selectedRulePack || !selectedTestPlan || layoutBaseline?.design_id !== design.id || layoutBaseline.test_plan_id !== selectedTestPlan || busy} onClick={() => void runTestAccessAnalysis()}><ShieldCheckIcon size={15} />{locale === "zh-CN" ? "运行 Layout DFT 闭环" : "Run Layout DFT closure"}</button>
              <p className="mt-2 text-[9px] leading-4 text-[#70736f]">{locale === "zh-CN" ? "Viewer 默认显示当前外层接触面；分析仍读取全部层、钻孔、网络和语义。生产放行不会由静态 PASS 自动完成。" : "The Viewer defaults to the contact surface; analysis still reads all layers, drills, nets, and semantics. Static PASS never auto-releases production."}</p>
            </div>
            {rulePacks.some((pack) => pack.status === "DRAFT") && (
              <div className="mt-4 border-t border-white/[0.065] pt-3">
                <div className="mb-1.5 text-[10px] font-medium text-[#777875]">{t("pendingConfirmation")}</div>
                {rulePacks.filter((pack) => pack.status === "DRAFT").map((pack) => (
                  <div key={pack.id} className="flex w-full items-start gap-2 rounded-lg px-1.5 py-2 text-left text-[12px] text-[#cbc9c4]">
                    <WarningCircleIcon size={14} className="text-[#c79d57]" />
                    <span className="min-w-0 flex-1"><span className="block truncate">{pack.title}</span><small className="mt-1 block text-[10px] leading-4 text-[#777875]">{locale === "zh-CN" ? "请在规则库逐条确认并批准" : "Review every field and approve it in Rule library"}</small></span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {analysis ? (
            <>
              <div className="grid grid-cols-4 divide-x divide-white/[0.065] border-b border-white/[0.065]">
                <Count label={locale === "zh-CN" ? "PASS 规则" : "PASS RULES"} value={analysis.pass_count} tone="pass" />
                <Count label={locale === "zh-CN" ? "FAIL 问题" : "FAIL FINDINGS"} value={findingCounts.fail} tone="fail" />
                <Count label={locale === "zh-CN" ? "REVIEW 项" : "REVIEW FINDINGS"} value={findingCounts.review} tone="review" />
                <Count label={locale === "zh-CN" ? "N/A 规则" : "N/A RULES"} value={analysis.not_applicable_count} tone="muted" />
              </div>
              <div className="border-b border-white/[0.065] p-3">
                <div className="grid grid-cols-2 gap-2">
                  <input className="workbench-input h-8 text-[10px]" value={violationFilters.net_name} onChange={(event) => setViolationFilters((current) => ({ ...current, net_name: event.target.value }))} placeholder={locale === "zh-CN" ? "NET NAME" : "NET NAME"} />
                  <input className="workbench-input h-8 text-[10px]" value={violationFilters.component_ref} onChange={(event) => setViolationFilters((current) => ({ ...current, component_ref: event.target.value }))} placeholder={locale === "zh-CN" ? "器件位号" : "Reference"} />
                  <input className="workbench-input h-8 text-[10px]" value={violationFilters.rule_id} onChange={(event) => setViolationFilters((current) => ({ ...current, rule_id: event.target.value }))} placeholder={locale === "zh-CN" ? "规则 ID" : "Rule ID"} />
                  <select className="workbench-input h-8 text-[10px]" value={violationFilters.verdict} onChange={(event) => setViolationFilters((current) => ({ ...current, verdict: event.target.value }))}><option value="">{locale === "zh-CN" ? "全部判定" : "All verdicts"}</option><option>PASS</option><option>FAIL</option><option>REVIEW</option><option value="NOT_APPLICABLE">N/A</option></select>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <button className="secondary-button h-8 px-2 text-[10px]" onClick={() => void filterViolations()}><FunnelIcon size={13} />{locale === "zh-CN" ? "筛选" : "Filter"}</button>
                  <button className="secondary-button h-8 px-2 text-[10px]" onClick={() => void generateEvidence()} disabled={busy || !violations.some(violationHasLocation)}><ImageSquareIcon size={13} />{locale === "zh-CN" ? "生成证据" : "Evidence"}</button>
                  <button className="secondary-button h-8 px-2 text-[10px]" onClick={() => analysis.report_path && void window.circuitInspector.openEvidence(analysis.report_path)} disabled={!analysis.report_path}><FileHtmlIcon size={13} />{locale === "zh-CN" ? "报告" : "Report"}</button>
                </div>
              </div>
              <div className="divide-y divide-white/[0.06]">
                {violations.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <CheckCircleIcon size={30} className="mx-auto mb-3 text-[#93ad7c]" />
                    <div className="text-[13px] font-medium text-[#e0dfda]">{t("noViolations")}</div>
                    <p className="mt-2 text-[11px] leading-5 text-[#777875]">{t("passReportGenerated")}</p>
                  </div>
                ) : violations.map((violation, index) => {
                  const selected = activeViolation?.id === violation.id;
                  const rule = rulePacks.find((pack) => pack.id === analysis.rule_pack_id)?.rules.find((item) => item.id === violation.rule_id);
                  const route = violation.verdict === "REVIEW" ? reviewRoute(violation, rule, testPoints) : null;
                  return (
                    <div
                      key={violation.id}
                      className={`reveal-row border-l-2 transition-colors hover:bg-white/[0.035] ${selected ? "border-l-[#c5a063] bg-[#c5a063]/[0.055]" : "border-l-transparent"}`}
                      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
                    >
                      <button
                        className="w-full px-4 py-3.5 text-left"
                        onClick={() => focusViolation(violation)}
                      >
                        <div className="mb-2 flex items-center gap-2.5">
                          <VerdictBadge verdict={violation.verdict} />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[#deddd8]">{violation.title}</span>
                          <span className="font-mono text-[9px] text-[#686966]">{String(index + 1).padStart(2, "0")}</span>
                        </div>
                        <p className={`${selected ? "" : "line-clamp-2"} text-[11px] leading-[1.55] text-[#7f807d]`}>{violation.message}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {violation.net_names.length ? violation.net_names.map((net) => <Tag key={net}>{net}</Tag>) : <Tag>{locale === "zh-CN" ? "NET 未识别" : "NET unavailable"}</Tag>}
                          {violation.component_refs.map((reference) => <Tag key={reference}>{reference}</Tag>)}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-[#777875]">
                          <span>{locale === "zh-CN" ? "实测" : "MEASURED"} {formatNm(violation.measured_value_nm)}</span>
                          <span>{locale === "zh-CN" ? "阈值" : "THRESHOLD"} {formatNm(violation.threshold_nm)}</span>
                          <span>{locale === "zh-CN" ? "位置" : "LOCATION"} {violationHasLocation(violation) ? `X ${(violation.x_nm / 1_000_000).toFixed(3)} · Y ${(violation.y_nm / 1_000_000).toFixed(3)} mm` : (locale === "zh-CN" ? "不可定位" : "unavailable")}</span>
                        </div>
                      </button>
                      {selected && route && <ReviewGuidance route={route} rule={rule} locale={locale} onReviewTestPoints={() => openTestPointReview(violation)} onOpenRuleLibrary={onOpenRuleLibrary} />}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="px-5 py-10 text-[12px] leading-6 text-[#777875]">{t("analysisPrompt")}</div>
          )}
        </aside>
      </section>

      <footer className="grid grid-cols-[272px_minmax(0,1fr)_360px] items-center border-t border-white/[0.07] bg-[#131517] font-mono text-[9px] tracking-[0.02em] text-[#696a67]">
        <div className="truncate border-r border-white/[0.07] px-4">{statusLabel}</div>
        <div className="flex items-center justify-between px-4">
          <span ref={pointerPositionElementRef}>X {pointerRef.current.xMm.toFixed(3)} mm&nbsp;&nbsp;Y {pointerRef.current.yMm.toFixed(3)} mm</span>
          <span className="text-[#b9965d]">{measureDistance == null ? "" : `${t("measurement")} ${measureDistance.toFixed(3)} mm`}</span>
          <span ref={pointerZoomElementRef}>{t("zoom")} {pointerRef.current.zoom.toFixed(1)} px/mm</span>
        </div>
        <div className="border-l border-white/[0.07] px-4 text-right">{t("localOnly")}</div>
      </footer>

    </main>
  );
}

function EmptyCanvas({ onOpen, t }: { onOpen(): void; t: Translator }) {
  const title = t("emptyTitle");
  const titleSeparator = title.includes("，") ? "，" : ", ";
  const [titleLead, ...titleRest] = title.split(titleSeparator);
  const titleTail = titleRest.join(titleSeparator);

  return (
    <div className="relative flex size-full items-center overflow-hidden px-[clamp(44px,7vw,112px)] py-12">
      <div className="pointer-events-none absolute inset-0 board-grid opacity-[0.18] [mask-image:radial-gradient(circle_at_center,black,transparent_72%)]" />
      <div className="relative mx-auto grid w-full max-w-[980px] grid-cols-[1.2fr_0.8fr] items-center gap-[clamp(48px,5vw,72px)]">
        <div>
          <div className="mb-6 flex items-center gap-3">
            <div className="brand-emblem size-11">
              <img src={brandMark} alt="" aria-hidden="true" className="size-11" />
            </div>
            <span className="font-mono text-[10px] tracking-[0.11em] text-[#777875]">ODB++ · GERBER · IPC-356</span>
          </div>
          <h1 className="max-w-[22ch] text-[30px] font-semibold leading-[1.12] tracking-[-0.045em] text-[#efeee9]">
            {titleTail ? <>{titleLead}{titleSeparator.trimEnd()}<br />{titleTail}</> : title}
          </h1>
          <p className="mt-5 max-w-[52ch] text-[13px] leading-6 text-[#8a8b87]">{t("emptyDescription")}</p>
          <div className="mt-8 flex items-center gap-4">
            <button className="primary-button" onClick={onOpen}><FolderOpenIcon size={16} />{t("chooseDesign")}</button>
            <span className="font-mono text-[9px] tracking-[0.06em] text-[#656663]">{t("localOnly")}</span>
          </div>
        </div>

        <div className="empty-blueprint" aria-hidden="true">
          <div className="absolute inset-0 board-grid opacity-45" />
          <div className="absolute inset-[13%] rounded-xl border border-[#c5a063]/30">
            <div className="absolute left-[11%] top-[18%] h-px w-[45%] bg-[#c5a063]/55" />
            <div className="absolute right-[10%] top-[18%] size-2.5 rounded-full border border-[#c5a063]/70 bg-[#1a1d1f]" />
            <div className="absolute bottom-[19%] left-[18%] h-px w-[62%] bg-[#768a69]/65" />
            <div className="absolute bottom-[calc(19%_-_4px)] left-[13%] size-2.5 rounded-full border border-[#768a69]/80 bg-[#1a1d1f]" />
            <div className="absolute left-[55%] top-[18%] h-[36%] w-px bg-[#c5a063]/55" />
            <div className="absolute left-[calc(55%_-_5px)] top-[52%] size-3 rounded-full border border-[#b55e4f]/75 bg-[#1a1d1f]" />
            <div className="absolute left-[34%] top-[35%] grid size-16 place-items-center rounded-xl border border-[#c5a063]/35 bg-[#111315] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <CrosshairIcon size={25} className="text-[#c5a063]" />
            </div>
          </div>
          <div className="absolute bottom-5 left-6 right-6 flex items-center justify-between font-mono text-[8px] tracking-[0.12em] text-[#5f605e]">
            <span>VECTOR WORKSPACE</span>
            <span>LOCAL · AUDITABLE</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewGuidance({ route, rule, locale, onReviewTestPoints, onOpenRuleLibrary }: { route: ReviewRoute; rule: RuleDefinition | undefined; locale: Locale; onReviewTestPoints(): void; onOpenRuleLibrary: (() => void) | undefined }) {
  const chinese = locale === "zh-CN";
  const entities = [rule?.source, rule?.target].filter(Boolean).join(" → ") || "-";
  const content = route === "TEST_POINT_REVIEW"
    ? { title: chinese ? "先确认测试点候选" : "Confirm test-point candidates first", body: chinese ? "该规则依赖推断测试点。逐个定位、确认或排除后，重新运行分析才能得到 PASS/FAIL。" : "This rule depends on inferred test points. Locate and confirm or reject each candidate, then rerun analysis for PASS/FAIL." }
    : route === "ENTITY_IDENTITY_REVIEW"
      ? { title: chinese ? "确认目标实体身份" : "Confirm target identity", body: chinese ? "距离已由导入几何计算，但目标对象来自层名、器件信息或钻孔几何候选；确认其确为规则目标前保持 REVIEW。" : "The distance is measured from imported geometry, but the target is inferred from a layer name, component metadata, or drill geometry. Keep REVIEW until its identity is confirmed." }
    : route === "UNSUPPORTED_ENTITY"
      ? { title: chinese ? "当前版本无法关闭此 REVIEW" : "This REVIEW cannot be closed in this build", body: chinese ? "该规则依赖尚未建模的实体。请在规则库中保留为 REVIEW、修改适用对象或停用该规则；不能用盲点确认伪造成 PASS。" : "The rule depends on an entity that is not modeled yet. Keep it as REVIEW, change its scope, or disable it in the rule library; a blind confirmation cannot become PASS." }
      : route === "MISSING_SEMANTICS"
        ? { title: chinese ? "导入数据缺少目标实体" : "The imported data lacks the target entity", body: chinese ? "该条目没有可定位坐标。需要重新导入包含相应 ODB++/IPC-356 语义的数据，或在规则库调整适用对象。" : "This item has no location to inspect. Re-import data with the required ODB++/IPC-356 semantics, or adjust the rule scope." }
        : { title: chinese ? "检查板上测量证据" : "Inspect board measurement evidence", body: chinese ? "在 Viewer 中核对高亮实体、测量值、阈值和规则来源；证据不充分时继续保持 REVIEW。" : "Inspect the highlighted entities, measured value, threshold, and rule source. Keep REVIEW when evidence is insufficient." };
  return (
    <div className="mx-4 mb-4 rounded-lg border border-[#c5a063]/20 bg-[#c5a063]/[0.045] p-3">
      <div className="text-[10px] font-semibold text-[#d9b575]">{content.title}</div>
      <p className="mt-1.5 text-[10px] leading-4 text-[#8f8d87]">{content.body}</p>
      <div className="mt-2 font-mono text-[8px] text-[#6f706d]">{entities}{rule ? ` · ${rule.kind} · ${formatNm(rule.threshold_nm)}` : ""}</div>
      <div className="mt-3 flex gap-2">
        {route === "TEST_POINT_REVIEW" && <button className="secondary-button h-7 flex-1 px-2 text-[9px]" onClick={onReviewTestPoints}>{chinese ? "去复核测试点" : "Review test points"}</button>}
        {(route === "UNSUPPORTED_ENTITY" || route === "MISSING_SEMANTICS") && onOpenRuleLibrary && <button className="secondary-button h-7 flex-1 px-2 text-[9px]" onClick={onOpenRuleLibrary}>{chinese ? "打开规则库" : "Open rule library"}</button>}
      </div>
    </div>
  );
}

export function TestPointReviewEvidence({ point, locale }: { point: TestPointCandidate; locale: Locale }) {
  const chinese = locale === "zh-CN";
  const context = point.review_context;
  return <div className="mt-2 rounded-md border border-white/[0.055] bg-black/10 px-2 py-1.5 font-mono text-[8px] leading-4 text-[#8b8c88]">
    <div className="flex items-center justify-between gap-2"><span>{chinese ? "测试点直径" : "DIAMETER"}</span><span className="text-[#d1ad6f]">{formatNm(point.radius_nm == null ? null : point.radius_nm * 2)}</span></div>
    <div className="flex items-center justify-between gap-2"><span>{chinese ? "最近板边净距" : "BOARD EDGE"}</span><span className="text-[#d1ad6f]">{formatNm(context?.board_edge.distance_nm)}</span></div>
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{chinese ? "最近测试点净距" : "NEAREST TEST POINT"}{context?.nearest_test_point ? ` · ${context.nearest_test_point.id}` : ""}</span><span className="shrink-0 text-[#d1ad6f]">{formatNm(context?.nearest_test_point?.distance_nm)}</span></div>
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{chinese ? "最近工装孔净距" : "NEAREST TOOLING HOLE"}{context?.nearest_tooling_hole ? ` · ${context.nearest_tooling_hole.id}${context.nearest_tooling_hole.confidence === "INFERRED" ? " · REVIEW" : ""}` : ""}</span><span className="shrink-0 text-[#d1ad6f]">{formatNm(context?.nearest_tooling_hole?.distance_nm)}</span></div>
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{chinese ? "最近器件净距" : "NEAREST COMPONENT"}{context?.nearest_component ? ` · ${context.nearest_component.id}` : ""}</span><span className="shrink-0 text-[#d1ad6f]">{formatNm(context?.nearest_component?.distance_nm)}</span></div>
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{chinese ? "最近屏蔽结构净距" : "NEAREST SHIELD"}{context?.nearest_shield ? ` · ${context.nearest_shield.id} · REVIEW` : ""}</span><span className="shrink-0 text-[#d1ad6f]">{formatNm(context?.nearest_shield?.distance_nm)}</span></div>
    <div className="mt-0.5 text-[#626360]">{chinese ? "边缘到边缘；pad_usage 工装孔为明确语义，否则按钻孔候选实测并保持 REVIEW" : "Edge-to-edge; pad_usage tooling holes are explicit, otherwise drill candidates are measured and remain REVIEW"}</div>
  </div>;
}

function PanelTitle({ title, caption }: { title: string; caption: string }) {
  return <div className="flex h-12 items-center justify-between border-b border-white/[0.065] px-5"><span className="text-[12px] font-semibold tracking-[-0.01em] text-[#dad9d4]">{title}</span><span className="panel-caption">{caption}</span></div>;
}

function ToolbarButton({ label, children, active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <button {...props} aria-label={label} title={label} data-active={active ? "true" : "false"} className="icon-button">{children}</button>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><div className="font-mono text-[17px] leading-none tracking-[-0.03em] text-[#d8d7d2]">{value.toLocaleString()}</div><div className="mt-1.5 text-[10px] text-[#727370]">{label}</div></div>;
}

function Count({ label, value, tone }: { label: string; value: number; tone: "pass" | "fail" | "review" | "muted" }) {
  const colors = { pass: "text-[#99b681]", fail: "text-[#df7962]", review: "text-[#cfaa66]", muted: "text-[#777875]" };
  return <div className="px-2 py-3.5 text-center"><div className={`font-mono text-[16px] leading-none ${colors[tone]}`}>{value}</div><div className="mt-1.5 text-[8px] font-medium tracking-[0.08em] text-[#686966]">{label}</div></div>;
}

function CoverageBadge({ value }: { value: string }) {
  const color = value === "EXPLICIT" ? "text-[#99b681]" : value === "MISSING" ? "text-[#686966]" : value === "INFERRED" ? "text-[#cfaa66]" : "text-[#c5a063]";
  return <span className={`font-mono text-[9px] tracking-[0.035em] ${color}`}>{value}</span>;
}

function VerdictBadge({ verdict }: { verdict: Violation["verdict"] }) {
  const color = verdict === "FAIL" ? "border-[#b76755]/35 bg-[#b76755]/10 text-[#e28a76]" : verdict === "REVIEW" ? "border-[#a98243]/35 bg-[#a98243]/10 text-[#d0aa67]" : "border-white/8 text-zinc-500";
  return <span className={`rounded-md border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.04em] ${color}`}>{verdict}</span>;
}

function Tag({ children }: { children: string }) {
  return <span className="max-w-full truncate rounded-md border border-white/[0.07] bg-white/[0.025] px-1.5 py-0.5 font-mono text-[9px] text-[#777875]">{children}</span>;
}

function LoadingRail({ label, progress }: { label: string; progress: number }) {
  return <div aria-live="polite" className="popover-surface absolute left-1/2 top-5 w-[380px] -translate-x-1/2 overflow-hidden rounded-xl px-4 py-3"><div className="flex items-center gap-2.5 text-[11px] text-[#d0cfca]"><span className="loading-beacon" />{label}<span className="ml-auto font-mono text-[9px] text-[#777875]">{progress}%</span></div><div className="mt-2.5 h-0.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="loading-progress h-full rounded-full bg-[#c5a063] transition-[width] duration-300" style={{ width: `${Math.max(3, progress)}%` }} /></div></div>;
}

function compact(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
}

function formatNm(value: number | null | undefined): string {
  return value == null ? "N/A" : `${(value / 1_000_000).toFixed(3)} mm`;
}

function layerColor(index: number): string {
  return ["#8ba76f", "#5f9fa7", "#b88b4c", "#a76d63", "#8176a8", "#9fa5a8"][index % 6]!;
}

function coverageName(value: string, t: Translator): string {
  return ({ layers: t("layer"), nets: t("nets"), components: t("components"), pins: t("pins"), test_points: t("testPoints"), drills: t("drills") } as Record<string, string>)[value] ?? value;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
