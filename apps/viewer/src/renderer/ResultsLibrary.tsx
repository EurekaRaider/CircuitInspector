import { ArrowClockwiseIcon, ArrowRightIcon, FileHtmlIcon, FunnelIcon, TrashIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { Locale } from "./i18n";
import type { ArtifactCatalog, ArtifactKind } from "./types";

export function ResultsLibrary({ locale, catalog, busy, onOpenAnalysis, onRefresh, onDelete }: { locale: Locale; catalog: ArtifactCatalog; busy: boolean; onOpenAnalysis(id: string): void; onRefresh(): void; onDelete(kind: ArtifactKind, id: string): void }) {
  const chinese = locale === "zh-CN";
  const [kind, setKind] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [query, setQuery] = useState("");
  const analyses = useMemo(() => catalog.artifacts.filter((artifact) => artifact.kind === "ANALYSIS")
    .filter((artifact) => kind === "ALL" || artifact.analysis_kind === kind)
    .filter((artifact) => status === "ALL" || artifact.verdict === status)
    .filter((artifact) => !query.trim() || `${artifact.title} ${artifact.subtitle} ${artifact.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [catalog, kind, status, query]);

  return (
    <div className="grid h-full grid-rows-[64px_minmax(0,1fr)] overflow-hidden">
      <header className="topbar title-drag flex items-center justify-between px-6">
        <div className={`min-w-0 ${window.circuitInspector.platform === "darwin" ? "pl-[70px]" : ""}`}><div className="text-[14px] font-semibold">{chinese ? "结果资料库" : "Results library"}</div><div className="mt-0.5 font-mono text-[10px] text-[#737572]">{analyses.length} / {catalog.artifacts.filter((item) => item.kind === "ANALYSIS").length} ANALYSES</div></div>
        <button className="title-no-drag secondary-button" onClick={onRefresh} disabled={busy}><ArrowClockwiseIcon size={15} className={busy ? "animate-spin" : ""} />{chinese ? "刷新" : "Refresh"}</button>
      </header>

      <section className="min-h-0 overflow-y-auto px-8 py-7">
        <div className="mx-auto max-w-[1280px]">
          <div className="grid grid-cols-[minmax(260px,1fr)_220px_180px] gap-3 border-b border-white/[0.07] pb-6">
            <label className="block"><span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#717370]">{chinese ? "搜索" : "Search"}</span><input className="workbench-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={chinese ? "分析 ID、规则包或标题" : "Analysis ID, rule pack, or title"} /></label>
            <label className="block"><span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#717370]">{chinese ? "类型" : "Type"}</span><select className="workbench-input" value={kind} onChange={(event) => setKind(event.target.value)}><option value="ALL">{chinese ? "全部类型" : "All types"}</option><option value="GEOMETRY">PCB GEOMETRY</option><option value="WIRING_COMPARISON">WIRING</option><option value="MANUFACTURING_TEST_RECOMMENDATIONS">TEST PLAN</option><option value="WIB_DESIGN_QUALIFICATION">WIB QUALIFICATION</option></select></label>
            <label className="block"><span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#717370]">{chinese ? "判定" : "Verdict"}</span><select className="workbench-input" value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">{chinese ? "全部判定" : "All verdicts"}</option><option>PASS</option><option>FAIL</option><option>REVIEW</option><option value="NOT_APPLICABLE">N/A</option></select></label>
          </div>

          <div className="mt-5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[#747672]"><FunnelIcon size={13} />{chinese ? "筛选后的本地分析" : "Filtered local analyses"}</div>
          <div className="mt-3 divide-y divide-white/[0.065] border-y border-white/[0.065]">
            {busy ? Array.from({ length: 5 }, (_, index) => <div key={index} className="h-[78px] animate-pulse bg-white/[0.015]" />) : analyses.length ? analyses.map((analysis) => (
              <div key={analysis.id} className="grid w-full grid-cols-[minmax(0,1fr)_32px] items-center gap-2 transition-colors hover:bg-white/[0.025]">
                <button className="grid w-full grid-cols-[150px_minmax(0,1fr)_130px_24px] items-center gap-4 px-3 py-4 text-left" onClick={() => onOpenAnalysis(analysis.id)}>
                <div><span className={`status-chip status-${(analysis.verdict ?? "review").toLowerCase().replaceAll("_", "-")}`}>{analysis.verdict ?? "REVIEW"}</span><div className="mt-2 font-mono text-[8px] text-[#666966]">{analysis.analysis_kind?.replaceAll("_", " ")}</div></div>
                <div className="min-w-0"><div className="truncate text-[12px] font-medium text-[#d9d7d2]">{analysis.title}</div><div className="mt-1 truncate font-mono text-[9px] text-[#696b68]">{analysis.subtitle}</div></div>
                <div className="text-right"><time className="font-mono text-[9px] text-[#747672]">{formatTime(analysis.updated_at, locale)}</time>{analysis.source_path && <div className="mt-1 flex items-center justify-end gap-1 text-[9px] text-[#9a8159]"><FileHtmlIcon size={11} />HTML</div>}</div>
                <ArrowRightIcon size={14} className="text-[#646664]" />
                </button>
                <button className="icon-button mr-1 size-8" title={chinese ? "删除本地结果" : "Delete local result"} aria-label={chinese ? `删除 ${analysis.title}` : `Delete ${analysis.title}`} onClick={() => { if (window.confirm(chinese ? "永久删除这项本地分析结果及其证据文件？" : "Permanently delete this local analysis and its evidence files?")) onDelete("ANALYSIS", analysis.id); }}><TrashIcon size={14} /></button>
              </div>
            )) : <div className="px-6 py-16 text-center text-[12px] leading-6 text-[#747672]">{chinese ? "没有符合当前筛选条件的分析结果。" : "No analysis results match the current filters."}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

function formatTime(value: string, locale: Locale) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
