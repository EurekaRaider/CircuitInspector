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
import { LOCALE_STORAGE_KEY, resolveLocale, translate, type Locale, type Translator } from "./i18n";
import type {
  AnalysisSummary,
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
      const summary = await window.circuitInspector.getDesignSummary(loaded.design_id);
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

  return (
    <main className="grid h-[100dvh] min-w-[1080px] grid-rows-[52px_minmax(0,1fr)_28px] overflow-hidden bg-[#17191b] text-zinc-100">
      <header className="title-drag grid grid-cols-[310px_minmax(360px,1fr)_auto] items-center border-b border-white/8 bg-[#1b1e20] px-4">
        <div className={`flex min-w-0 items-center gap-3 ${window.circuitInspector.platform === "darwin" ? "pl-[72px]" : ""}`}>
          <img src={brandMark} alt="" aria-hidden="true" className="size-8 shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold tracking-[-0.01em]">CircuitInspector</div>
            <div className="truncate font-mono text-[10px] text-zinc-500">{sourceName ?? t("localPcbReview")}</div>
          </div>
        </div>

        <form
          className="title-no-drag mx-auto flex h-8 w-full max-w-[520px] items-center rounded-md border border-white/8 bg-[#121416] px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-[#79a5a7]/50"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <MagnifyingGlassIcon size={15} className="mr-2 shrink-0 text-zinc-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
            aria-label={t("searchPlaceholder")}
          />
          <kbd className="rounded border border-white/8 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600">Enter</kbd>
        </form>

        <div className="title-no-drag flex items-center gap-1.5">
          <button
            className="grid h-8 min-w-9 place-items-center rounded border border-white/8 bg-white/[0.025] px-2 font-mono text-[9px] text-zinc-400 transition hover:bg-white/5 active:translate-y-px"
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
            className="grid h-8 min-w-12 place-items-center rounded border border-white/8 bg-white/[0.025] px-2 font-mono text-[9px] text-zinc-400 transition hover:bg-white/5 active:translate-y-px disabled:opacity-30"
            title={t("switchSide")}
            aria-label={t("switchSide")}
            disabled={!design}
            onClick={() => setViewSide((side) => side === "TOP" ? "BOTTOM" : "TOP")}
          >
            {viewSide === "TOP" ? "TOP" : "BOTTOM"}
          </button>
          <button className="primary-button ml-1" onClick={() => void chooseDesign()} disabled={busy}>
            <FolderOpenIcon size={16} />
            {t("openDesign")}
          </button>
        </div>
      </header>

      <section className="grid min-h-0 grid-cols-[248px_minmax(0,1fr)_336px]">
        <aside className="min-h-0 overflow-y-auto border-r border-white/8 bg-[#1a1c1e]">
          <PanelTitle title={t("designStructure")} caption={design ? t("layers", { count: design.layers.length }) : t("noDesign")} />
          {!design ? (
            <div className="px-4 py-8 text-xs leading-5 text-zinc-500">{t("emptySidebar")}</div>
          ) : (
            <>
              <div className="border-b border-white/7 px-4 py-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                  <Metric label={t("components")} value={design.component_count} />
                  <Metric label={t("nets")} value={design.net_count} />
                  <Metric label={t("testPoints")} value={design.test_point_count} />
                  <Metric label={t("drills")} value={design.drill_count} />
                </div>
              </div>
              <div className="border-b border-white/7 px-3 py-2">
                {design.layers.map((layer, index) => {
                  const checked = enabledLayers.includes(layer.id);
                  return (
                    <label key={layer.id} className="group flex cursor-pointer items-center gap-2.5 rounded px-1.5 py-1.5 text-xs hover:bg-white/[0.035]">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setEnabledLayers((layers) => checked ? layers.filter((id) => id !== layer.id) : [...layers, layer.id])}
                        className="sr-only"
                      />
                      <span className={`size-2.5 rounded-sm border ${checked ? "border-[#89a96f] bg-[#89a96f]" : "border-zinc-600 bg-transparent"}`} />
                      <span className="size-2 rounded-full" style={{ backgroundColor: layerColor(index) }} />
                      <span className="min-w-0 flex-1 truncate text-zinc-300">{layer.name}</span>
                      <span className="font-mono text-[9px] text-zinc-600">{compact(layer.feature_count)}</span>
                    </label>
                  );
                })}
              </div>
              <div className="px-4 py-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-zinc-600">{t("semanticCoverage")}</div>
                <div className="space-y-1.5">
                  {Object.entries(design.semantic_coverage).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between text-[10px]">
                      <span className="text-zinc-500">{coverageName(key, t)}</span>
                      <CoverageBadge value={value} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </aside>

        <div className="relative min-h-0 overflow-hidden bg-[#131618]">
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
            <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-[min(720px,calc(100%-32px))] -translate-x-1/2 border border-white/10 bg-[#202427]/95 px-3 py-2 shadow-xl backdrop-blur-md">
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <VerdictBadge verdict={activeViolation.verdict} />
                <span className="truncate text-zinc-200">{activeViolation.rule_id}</span>
                <span className="text-zinc-600">#{activeViolation.id}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-400">
                <span>{t("net")} {activeViolation.net_names.join(", ") || "-"}</span>
                <span>{t("reference")} {activeViolation.component_refs.join(", ") || "-"}</span>
                <span className="text-[#79b5b8]">{t("measured")} {formatNm(activeViolation.measured_value_nm)} / {t("threshold")} {formatNm(activeViolation.threshold_nm)}</span>
              </div>
            </div>
          )}
          {searchResults.length > 0 && (
            <div className="absolute left-4 top-4 w-[320px] overflow-hidden rounded-md border border-white/10 bg-[#202326]/96 shadow-[0_18px_50px_rgba(0,0,0,0.32)] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-white/8 px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                {t("searchResults")}
                <button onClick={() => setSearchResults([])} aria-label={t("closeSearchResults")} className="rounded p-1 hover:bg-white/5"><XIcon size={13} /></button>
              </div>
              <div className="max-h-72 overflow-y-auto p-1.5">
                {searchResults.map((result) => (
                  <button
                    key={`${result.kind}:${result.id}`}
                    className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs hover:bg-white/5 active:translate-y-px"
                    onClick={() => {
                      if (result.xNm != null && result.yNm != null) canvasRef.current?.focus(result.xNm, result.yNm);
                      setSearchResults([]);
                    }}
                  >
                    <span className="rounded border border-white/8 px-1 py-0.5 font-mono text-[9px] text-[#8bb7b9]">{result.kind}</span>
                    <span className="truncate">{result.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {picked && searchResults.length === 0 && (
            <div className="absolute left-4 top-4 max-w-[360px] border border-white/10 bg-[#202326]/95 px-3 py-2 shadow-lg backdrop-blur-md">
              <div className="flex items-center gap-2 font-mono text-[9px] text-[#8bb7b9]"><span>{picked.kind}</span><span className="truncate text-zinc-200">{picked.label}</span></div>
              <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[9px] text-zinc-500"><span>{t("layer")} {picked.layer_id ?? "-"}</span><span>{t("net")} {picked.net_name ?? "-"}</span><span>{t("reference")} {picked.component_ref ?? "-"}</span></div>
            </div>
          )}
          {error && (
            <div className="absolute bottom-4 left-4 right-4 flex items-start gap-3 rounded-md border border-[#b76755]/40 bg-[#3a2420]/95 px-3 py-2.5 text-xs text-[#efc1b6] shadow-lg">
              <WarningCircleIcon size={17} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <button onClick={() => setError("")} aria-label={t("closeError")}><XIcon size={15} /></button>
            </div>
          )}
        </div>

        <aside className="min-h-0 overflow-y-auto border-l border-white/8 bg-[#1a1c1e]">
          <PanelTitle title={t("rulesAndIssues")} caption={analysis ? analysis.verdict : t("notRun")} />
          <div className="border-b border-white/7 p-3">
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600" htmlFor="rule-pack">{t("rulePack")}</label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                id="rule-pack"
                value={selectedRulePack}
                onChange={(event) => setSelectedRulePack(event.target.value)}
                className="h-8 min-w-0 rounded border border-white/8 bg-[#121416] px-2 text-xs text-zinc-300 outline-none focus:border-[#79a5a7]/50"
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
              <div className="mt-3 border-t border-white/7 pt-2">
                <div className="mb-1 text-[10px] text-zinc-500">{t("pendingConfirmation")}</div>
                {rulePacks.filter((pack) => pack.status === "DRAFT").map((pack) => (
                  <button key={pack.id} className="flex w-full items-center gap-2 py-1.5 text-left text-xs text-zinc-300" onClick={() => setApprovalPack(pack)}>
                    <WarningCircleIcon size={14} className="text-[#c79d57]" />
                    <span className="min-w-0 flex-1 truncate">{pack.title}</span>
                    <CaretRightIcon size={12} className="text-zinc-600" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {analysis ? (
            <>
              <div className="grid grid-cols-4 divide-x divide-white/7 border-b border-white/7">
                <Count label="PASS" value={analysis.pass_count} tone="pass" />
                <Count label="FAIL" value={analysis.fail_count} tone="fail" />
                <Count label="REVIEW" value={analysis.review_count} tone="review" />
                <Count label="N/A" value={analysis.not_applicable_count} tone="muted" />
              </div>
              <div className="divide-y divide-white/7">
                {violations.length === 0 ? (
                  <div className="px-4 py-10 text-center">
                    <CheckCircleIcon size={28} className="mx-auto mb-3 text-[#89a96f]" />
                    <div className="text-sm font-medium">{t("noViolations")}</div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{t("passReportGenerated")}</p>
                  </div>
                ) : violations.map((violation, index) => (
                  <button
                    key={violation.id}
                    className={`w-full px-3 py-3 text-left transition-colors hover:bg-white/[0.035] ${activeViolation?.id === violation.id ? "bg-[#79a5a7]/8" : ""}`}
                    style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
                    onClick={() => {
                      setActiveViolation(violation);
                      canvasRef.current?.focus(violation.x_nm, violation.y_nm);
                    }}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <VerdictBadge verdict={violation.verdict} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">{violation.title}</span>
                      <span className="font-mono text-[9px] text-zinc-600">{index + 1}</span>
                    </div>
                    <p className="line-clamp-2 text-[11px] leading-4 text-zinc-500">{violation.message}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {violation.net_names.map((net) => <Tag key={net}>{net}</Tag>)}
                      {violation.component_refs.map((reference) => <Tag key={reference}>{reference}</Tag>)}
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="px-4 py-8 text-xs leading-5 text-zinc-500">{t("analysisPrompt")}</div>
          )}
        </aside>
      </section>

      <footer className="grid grid-cols-[248px_minmax(0,1fr)_336px] items-center border-t border-white/8 bg-[#151719] font-mono text-[9px] text-zinc-600">
        <div className="border-r border-white/8 px-3">{statusLabel}</div>
        <div className="flex items-center justify-between px-3">
          <span>X {pointer.xMm.toFixed(3)} mm&nbsp;&nbsp;Y {pointer.yMm.toFixed(3)} mm</span>
          <span>{measureDistance == null ? "" : `${t("measurement")} ${measureDistance.toFixed(3)} mm`}</span>
          <span>{t("zoom")} {pointer.zoom.toFixed(1)} px/mm</span>
        </div>
        <div className="border-l border-white/8 px-3 text-right">{t("localOnly")}</div>
      </footer>

      {approvalPack && (
        <div className="fixed inset-0 grid place-items-center bg-[#0d0f10]/75 p-6 backdrop-blur-sm">
          <div className="w-full max-w-[560px] rounded-lg border border-white/10 bg-[#202326] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.48)]">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold">{t("approveRulePack")}</div>
                <p className="mt-1 text-xs leading-5 text-zinc-500">{t("approvalDescription")}</p>
              </div>
              <button onClick={() => setApprovalPack(undefined)} aria-label={t("closeApproval")} className="rounded p-1 text-zinc-500 hover:bg-white/5"><XIcon size={16} /></button>
            </div>
            <div className="max-h-56 divide-y divide-white/7 overflow-y-auto border-y border-white/7">
              {approvalPack.rules.map((rule) => (
                <div key={rule.id} className="py-3">
                  <div className="flex justify-between gap-4 text-xs"><span>{rule.title}</span><span className="font-mono text-[#8bb7b9]">{(rule.threshold_nm / 1_000_000).toFixed(3)} mm</span></div>
                  {rule.citation?.excerpt && <p className="mt-1 text-[11px] leading-4 text-zinc-500">{rule.citation.excerpt}</p>}
                </div>
              ))}
            </div>
            <label htmlFor="approver" className="mt-4 block text-xs font-medium text-zinc-300">{t("approver")}</label>
            <input id="approver" value={approver} onChange={(event) => setApprover(event.target.value)} className="mt-2 h-9 w-full rounded border border-white/10 bg-[#141719] px-3 text-xs outline-none focus:border-[#79a5a7]/60" placeholder={t("approverPlaceholder")} />
            <p className="mt-1.5 text-[10px] text-zinc-600">{t("approvalRecord")}</p>
            <div className="mt-5 flex justify-end gap-2">
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
  return (
    <div className="grid size-full place-items-center p-12">
      <div className="grid w-full max-w-[760px] grid-cols-[1.2fr_0.8fr] overflow-hidden rounded-lg border border-white/8 bg-[#191c1e] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
        <div className="p-10">
          <div className="mb-5 flex size-10 items-center justify-center rounded-md border border-[#79a5a7]/30 bg-[#79a5a7]/8 text-[#8bb7b9]"><CrosshairIcon size={21} /></div>
          <h1 className="text-xl font-semibold tracking-[-0.03em]">{t("emptyTitle")}</h1>
          <p className="mt-3 max-w-[48ch] text-sm leading-6 text-zinc-500">{t("emptyDescription")}</p>
          <button className="primary-button mt-7" onClick={onOpen}><FolderOpenIcon size={16} />{t("chooseDesign")}</button>
        </div>
        <div className="relative border-l border-white/7 bg-[#131618] p-8">
          <div className="absolute inset-0 board-grid opacity-30" />
          <div className="relative mt-8 border-l border-t border-[#89a96f]/60 p-4">
            <div className="h-20 border-b border-r border-[#89a96f]/35" />
            <div className="absolute left-[40%] top-[48%] size-5 rounded-full border border-[#df6b53]" />
            <div className="mt-3 font-mono text-[9px] text-zinc-600">VECTOR · LOCAL · AUDITABLE</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelTitle({ title, caption }: { title: string; caption: string }) {
  return <div className="flex h-10 items-center justify-between border-b border-white/7 px-4"><span className="text-xs font-medium">{title}</span><span className="font-mono text-[9px] text-zinc-600">{caption}</span></div>;
}

function ToolbarButton({ label, children, active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <button {...props} aria-label={label} title={label} className={`grid size-8 place-items-center rounded border transition active:translate-y-px disabled:opacity-30 ${active ? "border-[#79a5a7]/45 bg-[#79a5a7]/12 text-[#8bb7b9]" : "border-white/8 bg-white/[0.025] text-zinc-400 hover:bg-white/5"}`}>{children}</button>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><div className="font-mono text-sm text-zinc-300">{value.toLocaleString()}</div><div className="text-[9px] text-zinc-600">{label}</div></div>;
}

function Count({ label, value, tone }: { label: string; value: number; tone: "pass" | "fail" | "review" | "muted" }) {
  const colors = { pass: "text-[#99b67f]", fail: "text-[#df7962]", review: "text-[#cfaa66]", muted: "text-zinc-500" };
  return <div className="px-2 py-3 text-center"><div className={`font-mono text-sm ${colors[tone]}`}>{value}</div><div className="mt-0.5 text-[8px] text-zinc-600">{label}</div></div>;
}

function CoverageBadge({ value }: { value: string }) {
  const color = value === "EXPLICIT" ? "text-[#99b67f]" : value === "MISSING" ? "text-zinc-600" : value === "INFERRED" ? "text-[#cfaa66]" : "text-[#8bb7b9]";
  return <span className={`font-mono ${color}`}>{value}</span>;
}

function VerdictBadge({ verdict }: { verdict: Violation["verdict"] }) {
  const color = verdict === "FAIL" ? "border-[#b76755]/35 bg-[#b76755]/10 text-[#e28a76]" : verdict === "REVIEW" ? "border-[#a98243]/35 bg-[#a98243]/10 text-[#d0aa67]" : "border-white/8 text-zinc-500";
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[8px] ${color}`}>{verdict}</span>;
}

function Tag({ children }: { children: string }) {
  return <span className="max-w-full truncate rounded border border-white/7 bg-white/[0.025] px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">{children}</span>;
}

function LoadingRail({ label, progress }: { label: string; progress: number }) {
  return <div className="absolute left-1/2 top-4 w-[360px] -translate-x-1/2 overflow-hidden rounded-md border border-white/10 bg-[#202326]/95 px-3 py-2 shadow-lg backdrop-blur-xl"><div className="flex items-center gap-2 text-[11px] text-zinc-300"><CircleNotchIcon size={14} className="animate-spin text-[#8bb7b9]" />{label}<span className="ml-auto font-mono text-[9px] text-zinc-600">{progress}%</span></div><div className="mt-2 h-px bg-white/7"><div className="h-px bg-[#79a5a7] transition-[width] duration-300" style={{ width: `${Math.max(3, progress)}%` }} /></div></div>;
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
