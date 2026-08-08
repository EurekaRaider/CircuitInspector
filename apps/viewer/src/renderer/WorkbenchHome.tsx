import {
  ArrowClockwiseIcon,
  ArrowRightIcon,
  ArchiveBoxIcon,
  CircuitryIcon,
  ClockCounterClockwiseIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon
} from "@phosphor-icons/react";
import type { WorkspaceView } from "./App";
import type { ArtifactCatalog } from "./types";
import type { Locale } from "./i18n";

interface Props {
  locale: Locale;
  catalog: ArtifactCatalog;
  busy: boolean;
  error: string;
  onNavigate(view: WorkspaceView): void;
  onOpenDesign(id: string): void;
  onOpenAnalysis(id: string): void;
  onOpenDraft(id: string): void;
  onRefresh(): void;
}

export function WorkbenchHome({ locale, catalog, busy, error, onNavigate, onOpenDesign, onOpenAnalysis, onOpenDraft, onRefresh }: Props) {
  const chinese = locale === "zh-CN";
  const recent = catalog.artifacts.slice(0, 8);
  const counts = {
    designs: catalog.artifacts.filter((item) => item.kind === "DESIGN").length,
    rules: catalog.artifacts.filter((item) => item.kind === "RULE_PACK").length,
    pinouts: catalog.artifacts.filter((item) => item.kind === "PINOUT").length,
    analyses: catalog.artifacts.filter((item) => item.kind === "ANALYSIS").length
  };
  const tasks = [
    {
      view: "PCB" as const,
      icon: CircuitryIcon,
      title: chinese ? "检查 PCB 制造数据" : "Inspect PCB manufacturing data",
      description: chinese ? "导入或恢复 ODB++、Gerber 与 IPC-356，运行确定性 DFT/DFM 分析。" : "Import or resume ODB++, Gerber, and IPC-356, then run deterministic DFT/DFM analysis.",
      metric: `${counts.designs} ${chinese ? "个设计" : "designs"}`
    },
    {
      view: "WIB" as const,
      icon: PlugsConnectedIcon,
      title: chinese ? "验证产品与 WIB" : "Qualify product and WIB",
      description: chinese ? "确认引脚、比较 NET NAME、建立受控约束并完成闭环验证。" : "Confirm pinouts, compare NET NAME values, approve constraints, and close qualification.",
      metric: `${counts.pinouts} ${chinese ? "份引脚表" : "pinouts"}`
    },
    {
      view: "RULES" as const,
      icon: ShieldCheckIcon,
      title: chinese ? "管理审查规则" : "Manage review rules",
      description: chinese ? "从受控文档抽取候选规则，核对引用与阈值后实名批准。" : "Extract cited rule candidates from controlled documents and approve verified thresholds.",
      metric: `${counts.rules} ${chinese ? "个规则包" : "rule packs"}`
    },
    {
      view: "RESULTS" as const,
      icon: ArchiveBoxIcon,
      title: chinese ? "复核证据与报告" : "Review evidence and reports",
      description: chinese ? "重新打开几何、接线、测试建议和最终验证结果。" : "Reopen geometry, wiring, test-plan, and final-qualification results.",
      metric: `${counts.analyses} ${chinese ? "次分析" : "analyses"}`
    }
  ];

  return (
    <div className="grid h-full grid-rows-[64px_minmax(0,1fr)] overflow-hidden">
      <header className="topbar title-drag flex items-center justify-between px-6">
        <div className={`min-w-0 ${window.circuitInspector.platform === "darwin" ? "pl-[70px]" : ""}`}>
          <div className="text-[14px] font-semibold tracking-[-0.018em]">{chinese ? "本地工程工作台" : "Local engineering workbench"}</div>
          <div className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-[#737572]">CIRCUITINSPECTOR · LOCAL ONLY</div>
        </div>
        <button className="title-no-drag secondary-button" onClick={onRefresh} disabled={busy}>
          <ArrowClockwiseIcon size={15} className={busy ? "animate-spin" : ""} />
          {chinese ? "刷新资料库" : "Refresh library"}
        </button>
      </header>

      <div className="min-h-0 overflow-y-auto px-[clamp(28px,4vw,64px)] py-10">
        <div className="mx-auto max-w-[1380px]">
          <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] gap-12 border-b border-white/[0.07] pb-10">
            <div>
              <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[#c5a063]">{chinese ? "选择一项工程任务" : "Choose an engineering task"}</div>
              <h1 className="max-w-[22ch] text-[30px] font-semibold leading-[1.12] tracking-[-0.045em] text-[#efeee9]">
                {chinese ? "从受控输入开始，得到可追溯的工程结论" : "Start with controlled inputs and produce traceable engineering conclusions"}
              </h1>
            </div>
            <p className="self-end text-[12px] leading-6 text-[#858681]">
              {chinese ? "Viewer 与 MCP 使用同一套本地解析、规则、证据和缓存。这里的人工操作不会降低 DRAFT、CONFIRMED 或 REVIEW 门禁。" : "The Viewer and MCP share the same local parsing, rules, evidence, and cache. Manual operation preserves every DRAFT, CONFIRMED, and REVIEW gate."}
            </p>
          </div>

          {error && <div role="alert" className="mt-6 rounded-xl border border-[#b76755]/35 bg-[#35231f]/75 px-4 py-3 text-[12px] text-[#efc1b6]">{error}</div>}

          <section className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.08]">
            {tasks.map((task, index) => {
              const Icon = task.icon;
              return (
                <button key={task.view} className="task-entry group min-h-[190px] bg-[#15181a] p-7 text-left" onClick={() => onNavigate(task.view)}>
                  <div className="flex items-start justify-between">
                    <span className="grid size-10 place-items-center rounded-xl border border-[#c5a063]/20 bg-[#c5a063]/[0.06] text-[#cbaa72]"><Icon size={20} /></span>
                    <span className="font-mono text-[9px] tracking-[0.08em] text-[#666966]">0{index + 1}</span>
                  </div>
                  <div className="mt-7 flex items-end justify-between gap-6">
                    <div>
                      <h2 className="text-[15px] font-semibold text-[#e5e3de]">{task.title}</h2>
                      <p className="mt-2 max-w-[52ch] text-[11px] leading-5 text-[#7c7f7b]">{task.description}</p>
                      <div className="mt-4 font-mono text-[9px] uppercase tracking-[0.08em] text-[#a28353]">{task.metric}</div>
                    </div>
                    <ArrowRightIcon size={16} className="shrink-0 text-[#666966] transition-transform group-hover:translate-x-1 group-hover:text-[#cbaa72]" />
                  </div>
                </button>
              );
            })}
          </section>

          <section className="mt-10">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#d8d7d2]"><ClockCounterClockwiseIcon size={15} />{chinese ? "最近产物" : "Recent artifacts"}</div>
              <span className="font-mono text-[9px] text-[#666966]">{catalog.artifacts.length} {chinese ? "项本地产物" : "local artifacts"}</span>
            </div>
            <div className="divide-y divide-white/[0.065] border-y border-white/[0.065]">
              {busy ? Array.from({ length: 4 }, (_, index) => <div key={index} className="h-[62px] animate-pulse bg-white/[0.015]" />) : recent.length ? recent.map((artifact) => (
                <button key={`${artifact.kind}:${artifact.id}`} className="flex w-full items-center gap-4 px-2 py-3.5 text-left transition-colors hover:bg-white/[0.025]" onClick={() => openArtifact(artifact.kind, artifact.id, onNavigate, onOpenDesign, onOpenAnalysis, onOpenDraft)}>
                  <span className="w-28 shrink-0 font-mono text-[9px] tracking-[0.06em] text-[#8d744c]">{artifact.kind.replaceAll("_", " ")}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-[12px] text-[#d3d1cc]">{artifact.title}</span><span className="mt-0.5 block truncate font-mono text-[9px] text-[#666966]">{artifact.subtitle}</span></span>
                  {artifact.status && <span className={`status-chip status-${artifact.status.toLowerCase().replaceAll("_", "-")}`}>{artifact.status}</span>}
                  <time className="w-32 shrink-0 text-right font-mono text-[9px] text-[#666966]">{formatTime(artifact.updated_at, locale)}</time>
                  <ArrowRightIcon size={13} className="text-[#5f615f]" />
                </button>
              )) : (
                <div className="px-5 py-12 text-center text-[12px] leading-6 text-[#777875]">{chinese ? "资料库为空。选择上方任务导入第一个受控输入。" : "The library is empty. Choose a task above to import the first controlled input."}</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function openArtifact(kind: string, id: string, onNavigate: (view: WorkspaceView) => void, onOpenDesign: (id: string) => void, onOpenAnalysis: (id: string) => void, onOpenDraft: (id: string) => void) {
  if (kind === "DESIGN") onOpenDesign(id);
  else if (kind === "ANALYSIS") onOpenAnalysis(id);
  else if (kind === "WORKFLOW_DRAFT") onOpenDraft(id);
  else if (kind === "RULE_PACK") onNavigate("RULES");
  else onNavigate("WIB");
}

function formatTime(value: string, locale: Locale): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
