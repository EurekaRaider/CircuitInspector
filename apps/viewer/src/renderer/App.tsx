import {
  ArrowsOutSimpleIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  CrosshairIcon,
  FolderOpenIcon,
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
import { LOCALE_STORAGE_KEY, resolveLocale, translate, type Locale, type Translator } from "./i18n";
import type {
  AnalysisSummary,
  DocumentAnalysis,
  BoundsNm,
  DesignSummary,
  ProgressEvent,
  RulePack,
  PickResult,
  SearchResult,
  TilePayload,
  Violation
} from "./types";

export function App() {
  const canvasRef = useRef<BoardCanvasHandle>(null);
  const tileRequest = useRef(0);
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY), window.navigator.language));
  const t = useMemo<Translator>(() => (key, variables) => translate(locale, key, variables), [locale]);
  const [design, setDesign] = useState<DesignSummary>();
  const [tile, setTile] = useState<TilePayload | null>(null);
  const [enabledLayers, setEnabledLayers] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisSummary>();
  const [documentAnalysis, setDocumentAnalysis] = useState<DocumentAnalysis>();
  const [activeViolation, setActiveViolation] = useState<Violation | null>(null);
  const [rulePacks, setRulePacks] = useState<RulePack[]>([]);
  const [selectedRulePack, setSelectedRulePack] = useState("");
  const [approvalPack, setApprovalPack] = useState<RulePack>();
  const [approver, setApprover] = useState("");
  const [progress, setProgress] = useState<ProgressEvent>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [picked, setPicked] = useState<PickResult | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [viewSide, setViewSide] = useState<"TOP" | "BOTTOM">("TOP");
  const [measureDistance, setMeasureDistance] = useState<number | null>(null);
  const [pointer, setPointer] = useState({ xMm: 0, yMm: 0, zoom: 0 });

  useEffect(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const loadRules = useCallback(async () => {
    try {
      const result = await window.circuitInspector.listRulePacks();
      setRulePacks(result.rule_packs);
      const approved = result.rule_packs.find((pack) => pack.status === "APPROVED");
      if (approved) setSelectedRulePack((current) => current || approved.id);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    void loadRules();
    const disposeProgress = window.circuitInspector.onProgress(setProgress);
    const disposeDeepLink = window.circuitInspector.onDeepLink((url) => void openDeepLink(url));
    return () => {
      disposeProgress();
      disposeDeepLink();
    };
  }, [loadRules]);

  useEffect(() => {
    if (!design) return;
    setEnabledLayers(design.layers.map((layer) => layer.id));
    queueMicrotask(() => canvasRef.current?.fit());
  }, [design?.id]);

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
      setDesign(summary);
      setAnalysis(loaded);
      const issue = parsed.searchParams.get("issue");
      const selected = loaded.violations.find((violation) => violation.id === issue) ?? loaded.violations[0] ?? null;
      setActiveViolation(selected);
      if (selected) queueMicrotask(() => canvasRef.current?.focus(selected.x_nm, selected.y_nm));
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
    setDocumentAnalysis(undefined);
    setActiveViolation(null);
    try {
      setDesign(await window.circuitInspector.importDesign(source));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const requestTile = useCallback(
    async (viewport: BoundsNm, zoom: number) => {
      if (!design) return;
      const request = ++tileRequest.current;
      try {
        const payload = await window.circuitInspector.getTile({
          design_id: design.id,
          viewport,
          layer_ids: enabledLayers,
          lod: zoom < 8 ? 2 : zoom < 30 ? 1 : 0,
          max_features: 500_000
        });
        if (request === tileRequest.current) setTile(payload);
      } catch (cause) {
        if (request === tileRequest.current) setError(message(cause));
      }
    },
    [design, enabledLayers]
  );

  useEffect(() => {
    if (!design) return;
    void requestTile(design.bounds, 1);
  }, [design?.id, enabledLayers]);

  async function runAnalysis() {
    if (!design || !selectedRulePack) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.circuitInspector.runAnalysis(design.id, selectedRulePack);
      setAnalysis(result);
      const first = result.violations.find((violation) => violation.verdict === "FAIL") ?? result.violations[0] ?? null;
      setActiveViolation(first);
      if (first) canvasRef.current?.focus(first.x_nm, first.y_nm);
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

  async function pickObject(point: { xMm: number; yMm: number }) {
    if (!design) return;
    try {
      const toleranceNm = Math.round(Math.max(30_000, 8 / Math.max(pointer.zoom, 0.02) * 1_000_000));
      const result = await window.circuitInspector.pickDesign({
        design_id: design.id,
        point: { x: Math.round(point.xMm * 1_000_000), y: Math.round(point.yMm * 1_000_000) },
        tolerance_nm: toleranceNm
      });
      setPicked(result.results[0] ?? null);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function approvePack() {
    if (!approvalPack || !approver.trim()) return;
    setBusy(true);
    try {
      await window.circuitInspector.approveRulePack(approvalPack.id, approver.trim());
      setApprovalPack(undefined);
      setApprover("");
      await loadRules();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const violations = analysis?.violations ?? [];
  const sourceName = design?.source_path.split(/[\\/]/).at(-1);
  const progressLabel = progress?.phase === "IMPORT"
    ? progress.progress >= 100 ? t("designIndexed") : t("validatingDesign")
    : progress?.message ?? t("processingLocalData");
  const statusLabel = busy ? progressLabel : design ? `${design.format} · ${t("layers", { count: design.layers.length })}` : t("waitingForImport");

  if (documentAnalysis) {
    return <DocumentAnalysisScreen
      analysis={documentAnalysis}
      locale={locale}
      onLocaleChange={() => setLocale((current) => current === "zh-CN" ? "en-US" : "zh-CN")}
      onOpenDesign={() => void chooseDesign()}
    />;
  }

  return (
    <main className="app-shell grid h-[100dvh] min-w-[1080px] grid-rows-[64px_minmax(0,1fr)_32px] overflow-hidden text-[#ecebe7]">
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
            onClick={() => setLocale((current) => current === "zh-CN" ? "en-US" : "zh-CN")}
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
            onClick={() => setViewSide((side) => side === "TOP" ? "BOTTOM" : "TOP")}
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
                {design.layers.map((layer, index) => {
                  const checked = enabledLayers.includes(layer.id);
                  return (
                    <label key={layer.id} className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-[12px] transition-colors hover:bg-white/[0.04]">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setEnabledLayers((layers) => checked ? layers.filter((id) => id !== layer.id) : [...layers, layer.id])}
                        className="sr-only"
                      />
                      <span className={`grid size-3.5 place-items-center rounded-[4px] border transition-colors ${checked ? "border-[#c5a063]/70 bg-[#c5a063] shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]" : "border-white/[0.18] bg-transparent"}`}>
                        {checked && <span className="size-1.5 rounded-[2px] bg-[#241d14]" />}
                      </span>
                      <span className="size-2 rounded-full" style={{ backgroundColor: layerColor(index) }} />
                      <span className="min-w-0 flex-1 truncate text-[#c9c8c3]">{layer.name}</span>
                      <span className="font-mono text-[10px] text-[#6d6e6b]">{compact(layer.feature_count)}</span>
                    </label>
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
              activeViolation={activeViolation}
              mirrored={viewSide === "BOTTOM"}
              measureMode={measureMode}
              onViewportChange={(viewport, zoom) => {
                setPointer((current) => ({ ...current, zoom }));
                void requestTile(viewport, zoom);
              }}
              onPointerWorld={setPointer}
              onMeasure={setMeasureDistance}
              onPick={(point) => void pickObject(point)}
            />
          ) : (
            <EmptyCanvas onOpen={() => void chooseDesign()} t={t} />
          )}
          {busy && <LoadingRail label={progressLabel} progress={progress?.progress ?? 12} />}
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
                <span className="text-[#d1ad6f]">{t("measured")} {formatNm(activeViolation.measured_value_nm)} / {t("threshold")} {formatNm(activeViolation.threshold_nm)}</span>
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
                {busy ? <CircleNotchIcon size={15} className="animate-spin" /> : <ShieldCheckIcon size={15} />}
                {t("analyze")}
              </button>
            </div>
            {rulePacks.some((pack) => pack.status === "DRAFT") && (
              <div className="mt-4 border-t border-white/[0.065] pt-3">
                <div className="mb-1.5 text-[10px] font-medium text-[#777875]">{t("pendingConfirmation")}</div>
                {rulePacks.filter((pack) => pack.status === "DRAFT").map((pack) => (
                  <button key={pack.id} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-2 text-left text-[12px] text-[#cbc9c4] transition-colors hover:bg-white/[0.035]" onClick={() => setApprovalPack(pack)}>
                    <WarningCircleIcon size={14} className="text-[#c79d57]" />
                    <span className="min-w-0 flex-1 truncate">{pack.title}</span>
                    <CaretRightIcon size={12} className="text-[#686966]" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {analysis ? (
            <>
              <div className="grid grid-cols-4 divide-x divide-white/[0.065] border-b border-white/[0.065]">
                <Count label="PASS" value={analysis.pass_count} tone="pass" />
                <Count label="FAIL" value={analysis.fail_count} tone="fail" />
                <Count label="REVIEW" value={analysis.review_count} tone="review" />
                <Count label="N/A" value={analysis.not_applicable_count} tone="muted" />
              </div>
              <div className="divide-y divide-white/[0.06]">
                {violations.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <CheckCircleIcon size={30} className="mx-auto mb-3 text-[#93ad7c]" />
                    <div className="text-[13px] font-medium text-[#e0dfda]">{t("noViolations")}</div>
                    <p className="mt-2 text-[11px] leading-5 text-[#777875]">{t("passReportGenerated")}</p>
                  </div>
                ) : violations.map((violation, index) => (
                  <button
                    key={violation.id}
                    className={`reveal-row w-full border-l-2 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.035] ${activeViolation?.id === violation.id ? "border-l-[#c5a063] bg-[#c5a063]/[0.055]" : "border-l-transparent"}`}
                    style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
                    onClick={() => {
                      setActiveViolation(violation);
                      canvasRef.current?.focus(violation.x_nm, violation.y_nm);
                    }}
                  >
                    <div className="mb-2 flex items-center gap-2.5">
                      <VerdictBadge verdict={violation.verdict} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[#deddd8]">{violation.title}</span>
                      <span className="font-mono text-[9px] text-[#686966]">{String(index + 1).padStart(2, "0")}</span>
                    </div>
                    <p className="line-clamp-2 text-[11px] leading-[1.55] text-[#7f807d]">{violation.message}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {violation.net_names.map((net) => <Tag key={net}>{net}</Tag>)}
                      {violation.component_refs.map((reference) => <Tag key={reference}>{reference}</Tag>)}
                    </div>
                  </button>
                ))}
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
          <span>X {pointer.xMm.toFixed(3)} mm&nbsp;&nbsp;Y {pointer.yMm.toFixed(3)} mm</span>
          <span className="text-[#b9965d]">{measureDistance == null ? "" : `${t("measurement")} ${measureDistance.toFixed(3)} mm`}</span>
          <span>{t("zoom")} {pointer.zoom.toFixed(1)} px/mm</span>
        </div>
        <div className="border-l border-white/[0.07] px-4 text-right">{t("localOnly")}</div>
      </footer>

      {approvalPack && (
        <div className="fixed inset-0 grid place-items-center bg-[#0d0f10]/78 p-6 backdrop-blur-md">
          <div role="dialog" aria-modal="true" aria-labelledby="approval-title" className="popover-surface w-full max-w-[580px] rounded-2xl p-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <div id="approval-title" className="text-[15px] font-semibold tracking-[-0.012em] text-[#edebe7]">{t("approveRulePack")}</div>
                <p className="mt-1.5 max-w-[52ch] text-[12px] leading-5 text-[#858681]">{t("approvalDescription")}</p>
              </div>
              <button onClick={() => setApprovalPack(undefined)} aria-label={t("closeApproval")} className="rounded-lg p-1.5 text-[#777875] transition-colors hover:bg-white/5 hover:text-[#e1e0db]"><XIcon size={16} /></button>
            </div>
            <div className="max-h-60 divide-y divide-white/[0.065] overflow-y-auto border-y border-white/[0.065]">
              {approvalPack.rules.map((rule) => (
                <div key={rule.id} className="py-3.5">
                  <div className="flex justify-between gap-4 text-[12px]"><span className="text-[#d8d7d2]">{rule.title}</span><span className="shrink-0 font-mono text-[10px] text-[#ceaa6c]">{(rule.threshold_nm / 1_000_000).toFixed(3)} mm</span></div>
                  {rule.citation?.excerpt && <p className="mt-1.5 text-[11px] leading-[1.55] text-[#797a77]">{rule.citation.excerpt}</p>}
                </div>
              ))}
            </div>
            <label htmlFor="approver" className="mt-5 block text-[12px] font-medium text-[#d0cfca]">{t("approver")}</label>
            <input id="approver" value={approver} onChange={(event) => setApprover(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-white/[0.1] bg-[#111315] px-3 text-[12px] text-[#e0dfda] transition-colors placeholder:text-[#5e5f5d] focus:border-[#c5a063]/50" placeholder={t("approverPlaceholder")} />
            <p className="mt-2 text-[10px] leading-4 text-[#686966]">{t("approvalRecord")}</p>
            <div className="mt-6 flex justify-end gap-2.5">
              <button className="secondary-button" onClick={() => setApprovalPack(undefined)}>{t("cancel")}</button>
              <button className="primary-button" disabled={!approver.trim() || busy} onClick={() => void approvePack()}><ShieldCheckIcon size={15} />{t("confirmApproval")}</button>
            </div>
          </div>
        </div>
      )}
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

function formatNm(value: number | undefined): string {
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
