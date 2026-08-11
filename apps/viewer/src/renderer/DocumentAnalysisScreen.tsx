import { ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, FileHtmlIcon, FolderOpenIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { DocumentAnalysis, TestRecommendationAnalysis, WibQualificationAnalysis, WiringAnalysis } from "./types";
import type { Locale } from "./i18n";

interface Props {
  analysis: DocumentAnalysis;
  locale: Locale;
  onLocaleChange(): void;
  onOpenDesign(): void;
  onBack?(): void;
  onReviewWiring?(analysis: WiringAnalysis): void;
}

export function DocumentAnalysisScreen({ analysis, locale, onLocaleChange, onOpenDesign, onBack, onReviewWiring }: Props) {
  const chinese = locale === "zh-CN";
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    analysis.kind === "WIRING_COMPARISON" ? analysis.violations[0]?.id ?? analysis.connections[0]?.id ?? null
      : analysis.kind === "WIB_DESIGN_QUALIFICATION" ? analysis.constraint_results.find((result) => result.status !== "PASS")?.id ?? analysis.constraint_results[0]?.id ?? null
        : analysis.recommendations[0]?.id ?? null
  );
  const title = analysis.kind === "WIRING_COMPARISON"
    ? chinese ? "产品 ↔ WIB 接线检查" : "Product ↔ WIB wiring check"
    : analysis.kind === "MANUFACTURING_TEST_RECOMMENDATIONS"
      ? chinese ? "制造测试与 WIB 设计建议" : "Manufacturing test and WIB design plan"
      : chinese ? "最终 WIB 设计闭环验证" : "Final WIB design qualification";

  return (
    <main className="app-shell grid h-full min-w-[1000px] grid-rows-[64px_minmax(0,1fr)_32px] overflow-hidden text-[#ecebe7]">
      <header className="topbar title-drag grid grid-cols-[minmax(320px,1fr)_auto] items-center px-5">
        <div className={`min-w-0 ${window.circuitInspector.platform === "darwin" ? "pl-[70px]" : ""}`}>
          <div className="text-[14px] font-semibold tracking-[-0.018em] text-[#f0efeb]">CircuitInspector</div>
          <div className="mt-0.5 truncate font-mono text-[10px] tracking-[0.025em] text-[#777875]">{title} · {analysis.id}</div>
        </div>
        <div className="title-no-drag flex items-center gap-2">
          {onBack && <button className="icon-button" onClick={onBack} aria-label={chinese ? "返回结果资料库" : "Back to results"}><ArrowLeftIcon size={15} /></button>}
          <button className="icon-button min-w-9 px-2 font-mono text-[10px]" onClick={onLocaleChange}>{chinese ? "EN" : "中"}</button>
          <button className="secondary-button" onClick={() => void window.circuitInspector.openEvidence(analysis.report_path)}><FileHtmlIcon size={15} />{chinese ? "打开报告" : "Open report"}</button>
          <button className="primary-button" onClick={onOpenDesign}><FolderOpenIcon size={15} />{chinese ? "打开 PCB" : "Open PCB"}</button>
        </div>
      </header>

      {analysis.kind === "WIRING_COMPARISON" ? (
        <WiringContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} {...(onReviewWiring ? { onReview: () => onReviewWiring(analysis) } : {})} chinese={chinese} />
      ) : analysis.kind === "MANUFACTURING_TEST_RECOMMENDATIONS" ? (
        <RecommendationContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} chinese={chinese} />
      ) : (
        <QualificationContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} chinese={chinese} />
      )}

      <footer className="grid grid-cols-[272px_minmax(0,1fr)_360px] items-center border-t border-white/[0.07] bg-[#131517] font-mono text-[9px] tracking-[0.02em] text-[#696a67]">
        <div className="truncate border-r border-white/[0.07] px-4">{analysis.kind}</div>
        <div className="px-4">{chinese ? "证据模式" : "EVIDENCE MODE"} · {analysis.verification_mode}</div>
        <div className="border-l border-white/[0.07] px-4 text-right">{chinese ? "仅本地 · 报告已生成" : "LOCAL ONLY · REPORT READY"}</div>
      </footer>
    </main>
  );
}

function WiringContent({ analysis, selectedId, onSelect, onReview, chinese }: { analysis: WiringAnalysis; selectedId: string | null; onSelect(id: string): void; onReview?: () => void; chinese: boolean }) {
  const selectedFinding = analysis.violations.find((finding) => finding.id === selectedId);
  const selectedConnectionId = selectedFinding?.id.replace(/^finding-/, "") ?? selectedId;
  return (
    <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-5">
        <SectionLabel>{chinese ? "受控输入" : "CONTROLLED INPUTS"}</SectionLabel>
        <SourceCard label="PRODUCT" source={analysis.product.source_path} revision={analysis.product.revision} status={analysis.product.status} count={analysis.product.pins.length} />
        <SourceCard label="WIB" source={analysis.wib.source_path} revision={analysis.wib.revision} status={analysis.wib.status} count={analysis.wib.pins.length} />
        <SectionLabel>{chinese ? "结果统计" : "RESULT COUNTS"}</SectionLabel>
        <div className="grid grid-cols-2 gap-2"><Metric label="PASS" value={analysis.pass_count} /><Metric label="FAIL" value={analysis.fail_count} /><Metric label="REVIEW" value={analysis.review_count} /><Metric label="N/A" value={analysis.not_applicable_count} /></div>
      </aside>

      <div className="canvas-stage min-h-0 overflow-auto p-6">
        <div className="mx-auto min-w-[720px] max-w-[1080px] rounded-2xl border border-white/[0.08] bg-[#101315] p-5">
          <div className="mb-4 flex items-center justify-between"><div><h2 className="text-[15px] font-semibold">{chinese ? "逐引脚接线标注" : "Pin-by-pin wiring annotation"}</h2><p className="mt-1 text-[11px] text-[#777e7b]">{chinese ? "红色为错接/漏接，黄色为待确认，绿色为匹配。" : "Red marks mismatches, amber marks review, and green marks confirmed matches."}</p></div><Verdict verdict={analysis.verdict} /></div>
          <div className="grid grid-cols-[1fr_160px_1fr] border-b border-white/[0.08] pb-2 font-mono text-[10px] text-[#797f7d]"><span>PRODUCT</span><span className="text-center">STATUS</span><span className="text-right">WIB</span></div>
          <div className="divide-y divide-white/[0.06]">
            {analysis.connections.map((connection) => {
              const selected = selectedConnectionId === connection.id;
              return <button key={connection.id} onClick={() => onSelect(connection.id)} className={`grid w-full grid-cols-[1fr_160px_1fr] items-center gap-3 px-2 py-3 text-left transition-colors ${selected ? "bg-[#c5a063]/[0.07]" : "hover:bg-white/[0.025]"}`}>
                <Pin label={`${connection.product_connector}.${connection.product_pin}`} net={connection.product_net} />
                <div className="relative text-center"><div className={`absolute left-0 right-0 top-1/2 h-px ${lineColor(connection.verdict)}`} /><span className="relative rounded-md bg-[#141719] px-2 py-1 font-mono text-[9px]"><Verdict verdict={connection.verdict} compact /></span></div>
                <Pin label={`${connection.wib_connector}.${connection.wib_pin}`} net={connection.wib_net} right />
              </button>;
            })}
          </div>
          {selectedFinding && <div className="mt-5 rounded-xl border border-[#b76755]/30 bg-[#2b1e1a] p-4 text-[12px] leading-5 text-[#e3b5aa]"><strong>{selectedFinding.rule_id}</strong><p className="mt-1 text-[#bd9289]">{selectedFinding.message}</p></div>}
        </div>
      </div>

      <aside className="sidebar-surface flex min-h-0 flex-col overflow-hidden border-l border-white/[0.07]">
        <PanelHead title={chinese ? "接线问题" : "WIRING FINDINGS"} verdict={analysis.verdict} />
        {analysis.verdict === "REVIEW" && <WiringReviewEntry ruleId={selectedFinding?.rule_id ?? analysis.violations[0]?.rule_id} chinese={chinese} {...(onReview ? { onReview } : {})} />}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {analysis.violations.length ? analysis.violations.map((finding) => <FindingButton key={finding.id} id={finding.id} selected={selectedId === finding.id} verdict={finding.verdict} title={finding.title} message={finding.message} onSelect={onSelect} />) : <PassState chinese={chinese} />}
        </div>
      </aside>
    </section>
  );
}

function WiringReviewEntry({ ruleId, chinese, onReview }: { ruleId: string | undefined; chinese: boolean; onReview?: () => void }) {
  const guidance = wiringReviewGuidance(ruleId, chinese);
  return <div className="m-3 shrink-0 rounded-xl border border-[#c5a063]/25 bg-[#c5a063]/[0.055] p-3">
    <div className="text-[11px] font-semibold text-[#d9b575]">{guidance.title}</div>
    <p className="mt-1.5 text-[10px] leading-4 text-[#8f8d87]">{guidance.body}</p>
    <button data-testid="wiring-review-entry" className="secondary-button mt-3 h-8 w-full px-2 text-[10px]" disabled={!onReview} onClick={onReview}>{guidance.action}<ArrowRightIcon size={13} /></button>
  </div>;
}

export function wiringReviewGuidance(ruleId: string | undefined, chinese: boolean) {
  if (ruleId === "NET_NAME_REVIEW_ONLY") return chinese
    ? { title: "补齐精确映射后重新比较", body: "当前只比较了两侧 NET NAME 清单，不能证明连接器/引脚一一对应，也不能检测交换。进入 WIB 工作流第 3 步补充映射；若路径仍为草稿，再回第 1/2 步确认 PDF 路径。", action: "进入映射与路径复核" }
    : { title: "Add exact mappings and compare again", body: "Only NET NAME inventories were compared. Connector/pin identity and swaps remain unproven. Add mappings in WIB workflow step 3, and confirm PDF paths in steps 1/2 when they remain draft.", action: "Review mappings and paths" };
  return chinese
    ? { title: "回到证据源关闭 REVIEW", body: "进入 WIB 工作流核对产品与 WIB 的原理图路径、连接器/引脚映射和 NET 别名；只有精确且已确认的对应关系才能重新裁决。", action: "进入接线复核" }
    : { title: "Return to the source evidence", body: "Review product/WIB schematic paths, connector and pin mappings, and NET aliases in the WIB workflow. Only exact confirmed correspondence can be adjudicated again.", action: "Open wiring review" };
}

function RecommendationContent({ analysis, selectedId, onSelect, chinese }: { analysis: TestRecommendationAnalysis; selectedId: string | null; onSelect(id: string): void; chinese: boolean }) {
  const [section, setSection] = useState<"TEST" | "WIB" | "CONSTRAINTS">("TEST");
  return (
    <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-5">
        <SectionLabel>{chinese ? "产品原理图" : "PRODUCT SCHEMATIC"}</SectionLabel>
        <SourceCard label="PRODUCT" source={analysis.product.source_path} revision={analysis.product.revision} status={analysis.product.status} count={analysis.product.pins.length} />
        <SectionLabel>{chinese ? "输出清单" : "OUTPUT LISTS"}</SectionLabel>
        <div className="space-y-2"><Metric label={chinese ? "制造测试" : "LINE TESTS"} value={analysis.recommendations.length} /><Metric label={chinese ? "WIB 设计" : "WIB DESIGN"} value={analysis.wib_design_recommendations.length} /><Metric label={chinese ? "硬约束" : "HARD CONSTRAINTS"} value={analysis.wib_constraints.length} /></div>
        <div className="mt-5 rounded-xl border border-[#c79d57]/25 bg-[#2a2519] p-3 text-[10px] leading-5 text-[#a9946b]">{chinese ? "数值硬指标无权威来源时保持 TBD/REVIEW；Viewer 不会自动补值。" : "Numeric hard metrics remain TBD/REVIEW without an applicable authority."}</div>
      </aside>
      <div className="canvas-stage min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1080px]">
          <div className="mb-5 flex gap-2">{(["TEST", "WIB", "CONSTRAINTS"] as const).map((item) => <button key={item} onClick={() => setSection(item)} className={`rounded-lg px-3 py-2 text-[11px] font-medium ${section === item ? "bg-[#c5a063] text-[#241d14]" : "border border-white/[0.08] bg-[#15191b] text-[#989e9b]"}`}>{item === "TEST" ? chinese ? "制造测试建议" : "Manufacturing tests" : item === "WIB" ? chinese ? "WIB 设计建议" : "WIB design" : chinese ? "约束与硬指标" : "Constraints"}</button>)}</div>
          {section === "TEST" ? <div className="grid grid-cols-2 gap-4">{analysis.recommendations.map((item) => <RecommendationCard key={item.id} selected={selectedId === item.id} onClick={() => onSelect(item.id)} priority={item.priority} title={item.title} nets={item.net_names} body={item.suggested_test} foot={item.observation} />)}</div>
            : section === "WIB" ? <div className="grid grid-cols-2 gap-4">{analysis.wib_design_recommendations.map((item) => <RecommendationCard key={item.id} selected={selectedId === item.id} onClick={() => onSelect(item.id)} priority={item.priority} title={item.title} nets={item.related_net_names} body={item.recommendation} foot={item.validation_needed} />)}</div>
              : <div className="space-y-3">{analysis.wib_constraints.map((item) => <button key={item.id} onClick={() => onSelect(item.id)} className={`w-full rounded-xl border p-4 text-left ${selectedId === item.id ? "border-[#c5a063]/50 bg-[#c5a063]/[0.06]" : "border-white/[0.07] bg-[#15191b]"}`}><div className="flex items-center justify-between"><span className="font-mono text-[10px] text-[#c4a167]">{item.id}</span><span className="font-mono text-[9px] text-[#787e7b]">{item.verification_mode}</span></div><h3 className="mt-2 text-[13px] font-medium">{item.requirement}</h3><div className="mt-3 grid grid-cols-3 gap-3 text-[10px] text-[#7f8683]"><span>{item.area}</span><span>{item.comparator}</span><span className={item.required_value == null ? "text-[#cba45e]" : "text-[#9cb18c]"}>{item.required_value == null ? "TBD" : `${item.required_value}${item.unit ? ` ${item.unit}` : ""}`}</span></div></button>)}</div>}
        </div>
      </div>
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-l border-white/[0.07] p-5">
        <PanelHead title={chinese ? "范围与证据缺口" : "SCOPE AND EVIDENCE GAPS"} verdict="REVIEW" />
        <div className="space-y-3">{analysis.diagnostics.map((item) => <div key={item.code} className="rounded-lg border border-white/[0.07] bg-[#15191b] p-3"><div className="font-mono text-[9px] text-[#c5a063]">{item.code}</div><p className="mt-1 text-[11px] leading-5 text-[#858b88]">{item.message}</p></div>)}</div>
      </aside>
    </section>
  );
}

function QualificationContent({ analysis, selectedId, onSelect, chinese }: { analysis: WibQualificationAnalysis; selectedId: string | null; onSelect(id: string): void; chinese: boolean }) {
  const selected = analysis.constraint_results.find((result) => result.id === selectedId);
  return (
    <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-5">
        <SectionLabel>{chinese ? "闭环输入" : "CLOSED-LOOP INPUTS"}</SectionLabel>
        {[['PRODUCT', analysis.product_pinout_id], ['WIB', analysis.wib_pinout_id], ['CONSTRAINTS', analysis.constraint_set_id]].map(([label, value]) => <div key={label} className="mb-2 rounded-lg border border-white/[0.07] bg-[#15191b] p-3"><div className="font-mono text-[9px] text-[#777e7b]">{label}</div><div className="mt-1 break-all font-mono text-[10px] text-[#c9c7c1]">{value}</div></div>)}
        <SectionLabel>{chinese ? "裁决" : "VERDICT"}</SectionLabel>
        <div className="grid grid-cols-2 gap-2"><Metric label="PASS" value={analysis.pass_count} /><Metric label="FAIL" value={analysis.fail_count} /><Metric label="REVIEW" value={analysis.review_count} /><Metric label="WIRING" value={analysis.wiring_verdict} /></div>
      </aside>
      <div className="canvas-stage min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1080px]">
          <div className="mb-5 flex items-center justify-between"><div><h2 className="text-[16px] font-semibold">{chinese ? "WIB 硬约束逐条验证" : "WIB hard-constraint qualification"}</h2><p className="mt-1 text-[11px] text-[#7d8380]">{chinese ? "只有全部适用约束有证据且通过，最终状态才是 PASS。" : "Final PASS requires supported evidence and PASS for every applicable constraint."}</p></div><Verdict verdict={analysis.verdict} /></div>
          <div className="space-y-3">{analysis.constraint_results.map((result) => <button key={result.id} onClick={() => onSelect(result.id)} className={`grid w-full grid-cols-[100px_1fr_160px_160px] items-start gap-3 rounded-xl border p-4 text-left ${selectedId === result.id ? "border-[#c5a063]/55 bg-[#c5a063]/[0.06]" : "border-white/[0.07] bg-[#15191b]"}`}><Verdict verdict={result.status} compact /><div><div className="font-mono text-[9px] text-[#777e7b]">{result.constraint_id} · {result.area}</div><div className="mt-1 text-[12px] leading-5 text-[#d3d2cd]">{result.requirement}</div></div><Value label={chinese ? "要求" : "REQUIRED"} value={formatRequired(result.required_value, result.unit)} /><Value label={chinese ? "实际" : "ACTUAL"} value={result.actual_value == null ? "MISSING" : `${result.actual_value}${result.unit ? ` ${result.unit}` : ""}`} /></button>)}</div>
          {selected && <div className="mt-5 rounded-xl border border-white/[0.08] bg-[#111416] p-4"><div className="font-mono text-[9px] text-[#c5a063]">{selected.verification_mode}</div><p className="mt-2 text-[12px] leading-5 text-[#969c99]">{selected.message}</p></div>}
        </div>
      </div>
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-l border-white/[0.07]">
        <PanelHead title={chinese ? "未关闭项" : "OPEN FINDINGS"} verdict={analysis.verdict} />
        {analysis.violations.length ? analysis.violations.map((finding) => <FindingButton key={finding.id} id={finding.id} selected={selectedId === finding.id} verdict={finding.status} title={finding.constraint_id} message={finding.message} onSelect={onSelect} />) : <PassState chinese={chinese} />}
      </aside>
    </section>
  );
}

function RecommendationCard({ selected, onClick, priority, title, nets, body, foot }: { selected: boolean; onClick(): void; priority: string; title: string; nets: string[]; body: string; foot: string }) {
  return <button onClick={onClick} className={`rounded-xl border p-4 text-left ${selected ? "border-[#c5a063]/55 bg-[#c5a063]/[0.06]" : "border-white/[0.07] bg-[#15191b] hover:bg-white/[0.025]"}`}><div className="flex items-center justify-between"><span className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${priority === "HIGH" ? "bg-[#4a2921] text-[#ef9c87]" : "bg-[#3c321e] text-[#ddb86d]"}`}>{priority}</span><span className="font-mono text-[9px] text-[#707673]">REVIEW</span></div><h3 className="mt-3 text-[13px] font-medium leading-5">{title}</h3><div className="mt-2 flex flex-wrap gap-1">{nets.slice(0, 8).map((net) => <span key={net} className="rounded border border-white/[0.07] bg-[#101315] px-1.5 py-0.5 font-mono text-[8px] text-[#95a39e]">{net}</span>)}</div><p className="mt-3 text-[11px] leading-5 text-[#8b918e]">{body}</p><p className="mt-3 border-t border-white/[0.06] pt-3 text-[10px] leading-4 text-[#696f6c]">{foot}</p></button>;
}

function FindingButton({ id, selected, verdict, title, message, onSelect }: { id: string; selected: boolean; verdict: string; title: string; message: string; onSelect(id: string): void }) {
  return <button onClick={() => onSelect(id)} className={`w-full border-l-2 px-4 py-3.5 text-left ${selected ? "border-l-[#c5a063] bg-[#c5a063]/[0.055]" : "border-l-transparent hover:bg-white/[0.025]"}`}><div className="flex items-center gap-2"><Verdict verdict={verdict} compact /><span className="truncate text-[11px] font-medium">{title}</span></div><p className="mt-2 line-clamp-3 text-[10px] leading-4 text-[#777e7b]">{message}</p></button>;
}

function SourceCard({ label, source, revision, status, count }: { label: string; source: string; revision: string | null; status: string; count: number }) {
  return <div className="mb-3 rounded-xl border border-white/[0.07] bg-[#15191b] p-3"><div className="flex items-center justify-between font-mono text-[9px]"><span className="text-[#c5a063]">{label}</span><span className={status === "CONFIRMED" ? "text-[#8fad7d]" : "text-[#cba45e]"}>{status}</span></div><div className="mt-2 break-all text-[10px] leading-4 text-[#8b918e]">{source}</div><div className="mt-2 flex justify-between font-mono text-[9px] text-[#686e6b]"><span>REV {revision ?? "-"}</span><span>{count} PINS</span></div></div>;
}

function PanelHead({ title, verdict }: { title: string; verdict: string }) { return <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-4"><span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[#777e7b]">{title}</span><Verdict verdict={verdict} compact /></div>; }
function SectionLabel({ children }: { children: string }) { return <div className="mb-3 mt-2 font-mono text-[9px] font-semibold tracking-[0.14em] text-[#6f7572]">{children}</div>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-lg border border-white/[0.07] bg-[#15191b] p-3"><div className="font-mono text-[8px] text-[#707673]">{label}</div><div className="mt-1 text-[16px] font-semibold">{value}</div></div>; }
function Pin({ label, net, right = false }: { label: string; net: string | null; right?: boolean }) { return <div className={right ? "text-right" : ""}><div className="font-mono text-[11px] text-[#d9d8d3]">{label}</div><div className="mt-1 font-mono text-[9px] text-[#838a87]">{net ?? "MISSING"}</div></div>; }
function Value({ label, value }: { label: string; value: string }) { return <div><div className="font-mono text-[8px] text-[#6f7572]">{label}</div><div className="mt-1 break-words font-mono text-[10px] text-[#b6bbb8]">{value}</div></div>; }
function PassState({ chinese }: { chinese: boolean }) { return <div className="px-6 py-14 text-center"><CheckCircleIcon size={32} className="mx-auto text-[#8fad7d]" /><div className="mt-3 text-[12px]">{chinese ? "全部适用项已通过" : "All applicable items passed"}</div></div>; }

function Verdict({ verdict, compact = false }: { verdict: string; compact?: boolean }) {
  const tone = verdict === "PASS" ? "border-[#7fa06d]/30 bg-[#2b3927] text-[#a6c492]" : verdict === "FAIL" ? "border-[#d96852]/30 bg-[#3b231e] text-[#ed927d]" : "border-[#c79d57]/30 bg-[#352e1d] text-[#dab66d]";
  return <span className={`inline-flex items-center rounded-md border font-mono font-semibold ${tone} ${compact ? "px-1.5 py-0.5 text-[8px]" : "px-2.5 py-1 text-[10px]"}`}>{verdict}</span>;
}

function lineColor(verdict: string) { return verdict === "PASS" ? "bg-[#7fa06d]" : verdict === "FAIL" ? "bg-[#d96852]" : "bg-[#c79d57]"; }
function formatRequired(value: string | number | { min: number; max: number }, unit: string | null) { const body = typeof value === "object" ? `${value.min}..${value.max}` : value; return `${body}${unit ? ` ${unit}` : ""}`; }
