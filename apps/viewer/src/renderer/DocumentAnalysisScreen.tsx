import { ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, FileHtmlIcon, FolderOpenIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { DocumentAnalysis, LayoutTestAccessAnalysis, SelectedTestPointAnalysisV1, TestRecommendationAnalysis, WibQualificationAnalysis, WiringAnalysis } from "./types";
import type { Locale } from "./i18n";

interface Props {
  analysis: DocumentAnalysis;
  locale: Locale;
  onLocaleChange(): void;
  onOpenDesign(): void;
  onBack?(): void;
  onReviewWiring?(analysis: WiringAnalysis): void;
  onLocateTestPoint?(id: string): void;
}

export function DocumentAnalysisScreen({ analysis, locale, onLocaleChange, onOpenDesign, onBack, onReviewWiring, onLocateTestPoint }: Props) {
  const chinese = locale === "zh-CN";
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    analysis.kind === "WIRING_COMPARISON" ? analysis.violations[0]?.id ?? analysis.connections[0]?.id ?? null
      : analysis.kind === "WIB_DESIGN_QUALIFICATION" ? analysis.constraint_results.find((result) => result.status !== "PASS")?.id ?? analysis.constraint_results[0]?.id ?? null
        : analysis.kind === "LAYOUT_TEST_ACCESS_ANALYSIS" ? analysis.mappings.find((result) => result.status !== "PASS")?.id ?? analysis.mappings[0]?.id ?? null
          : analysis.kind === "SELECTED_TEST_POINT_ANALYSIS" ? analysis.bindings.find((result) => result.status !== "PASS")?.candidate_id ?? analysis.bindings[0]?.candidate_id ?? null
            : analysis.recommendations[0]?.id ?? null
  );
  const title = analysis.kind === "WIRING_COMPARISON"
    ? chinese ? "产品 ↔ WIB 接线检查" : "Product ↔ WIB wiring check"
    : analysis.kind === "MANUFACTURING_TEST_RECOMMENDATIONS"
      ? chinese ? "制造测试与 WIB 设计建议" : "Manufacturing test and WIB design plan"
      : analysis.kind === "LAYOUT_TEST_ACCESS_ANALYSIS"
        ? chinese ? "Layout DFT 测试访问闭环" : "Layout DFT test-access closure"
        : analysis.kind === "SELECTED_TEST_POINT_ANALYSIS"
          ? chinese ? "人工选择 TP 的 Gerber DFT 分析" : "Selected-TP Gerber DFT analysis"
          : chinese ? "最终 WIB 设计闭环验证" : "Final WIB design qualification";

  return (
    <main className="app-shell relative grid h-full min-w-[1000px] grid-rows-[64px_minmax(0,1fr)_32px] overflow-hidden text-[#ecebe7]">
      <header className="topbar title-drag grid grid-cols-[minmax(320px,1fr)_auto] items-center px-5">
        <div className={`min-w-0 ${window.circuitInspector.platform === "darwin" ? "pl-[70px]" : ""}`}>
          <div className="text-[14px] font-semibold tracking-[-0.018em] text-[#f0efeb]">CircuitInspector</div>
          <div className="mt-0.5 truncate font-mono text-[10px] tracking-[0.025em] text-[#777875]">{title} · {analysis.id}{analysis.stale ? " · STALE" : ""}</div>
        </div>
        <div className="title-no-drag flex items-center gap-2">
          {onBack && <button className="icon-button" onClick={onBack} aria-label={chinese ? "返回结果资料库" : "Back to results"}><ArrowLeftIcon size={15} /></button>}
          <button className="icon-button min-w-9 px-2 font-mono text-[10px]" onClick={onLocaleChange}>{chinese ? "EN" : "中"}</button>
          <button className="secondary-button" onClick={() => void window.circuitInspector.openEvidence(analysis.report_path)}><FileHtmlIcon size={15} />{chinese ? "打开报告" : "Open report"}</button>
          <button className="primary-button" onClick={onOpenDesign}><FolderOpenIcon size={15} />{chinese ? "打开 PCB" : "Open PCB"}</button>
        </div>
      </header>
      {analysis.stale && <div className="pointer-events-none absolute left-0 right-0 top-16 z-30 border-b border-[#bd735f]/45 bg-[#4a241d]/95 px-5 py-2.5 font-mono text-[10px] text-[#ffd0c3] backdrop-blur-md">{chinese ? "过期分析" : "STALE ANALYSIS"} · {analysis.stale.reason} · {analysis.stale.invalidated_at}</div>}

      {analysis.kind === "WIRING_COMPARISON" ? (
        <WiringContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} {...(onReviewWiring ? { onReview: () => onReviewWiring(analysis) } : {})} chinese={chinese} />
      ) : analysis.kind === "MANUFACTURING_TEST_RECOMMENDATIONS" ? (
        <RecommendationContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} chinese={chinese} />
      ) : analysis.kind === "LAYOUT_TEST_ACCESS_ANALYSIS" ? (
        <LayoutAccessContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} {...(onLocateTestPoint ? { onLocateTestPoint } : {})} chinese={chinese} />
      ) : analysis.kind === "SELECTED_TEST_POINT_ANALYSIS" ? (
        <SelectedTpContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} chinese={chinese} />
      ) : (
        <QualificationContent analysis={analysis} selectedId={selectedId} onSelect={setSelectedId} chinese={chinese} />
      )}

      <footer className="grid grid-cols-[272px_minmax(0,1fr)_360px] items-center border-t border-white/[0.07] bg-[#131517] font-mono text-[9px] tracking-[0.02em] text-[#696a67]">
        <div className="truncate border-r border-white/[0.07] px-4">{analysis.kind}</div>
        <div className="px-4">{chinese ? "证据模式" : "EVIDENCE MODE"} · {analysis.kind === "LAYOUT_TEST_ACCESS_ANALYSIS" || analysis.kind === "SELECTED_TEST_POINT_ANALYSIS" ? "AUTOMATED_GEOMETRY + HUMAN APPROVAL" : analysis.verification_mode}</div>
        <div className="border-l border-white/[0.07] px-4 text-right">{chinese ? "仅本地 · 报告已生成" : "LOCAL ONLY · REPORT READY"}</div>
      </footer>
    </main>
  );
}

function SelectedTpContent({ analysis, selectedId, onSelect, chinese }: { analysis: SelectedTestPointAnalysisV1; selectedId: string | null; onSelect(id: string): void; chinese: boolean }) {
  const selected = analysis.bindings.find((binding) => binding.candidate_id === selectedId) ?? null;
  return <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
    <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-5">
      <SectionLabel>{chinese ? "冻结输入谱系" : "FROZEN LINEAGE"}</SectionLabel>
      {[['GERBER', analysis.design_id], ['TP SELECTION', analysis.selection_id], ['ALIGNMENT', analysis.alignment_id], ['RULE PACK', analysis.rule_pack_id]].map(([label, value]) => <div key={label} className="mb-2 rounded-lg border border-white/[0.07] bg-[#15191b] p-3"><div className="font-mono text-[9px] text-[#777e7b]">{label}</div><div className="mt-1 break-all font-mono text-[10px] text-[#c9c7c1]">{value}</div></div>)}
      <SectionLabel>{chinese ? "规则裁决" : "RULE VERDICT"}</SectionLabel>
      <div className="grid grid-cols-2 gap-2"><Metric label="PASS" value={analysis.pass_count} /><Metric label="FAIL" value={analysis.fail_count} /><Metric label="REVIEW" value={analysis.review_count} /><Metric label="N/A" value={analysis.not_applicable_count} /></div>
      <div className="mt-4 rounded-xl border border-[#c79d57]/25 bg-[#2a2519] p-3 text-[10px] leading-5 text-[#b59a69]">{chinese ? "TP 身份、DFT 规则裁决和生产放行相互独立；生产放行固定为 REVIEW。" : "TP identity, DFT verdict, and production release are independent. Production readiness remains REVIEW."}</div>
    </aside>
    <div className="canvas-stage min-h-0 overflow-y-auto p-6">
      <div className="mx-auto max-w-[1120px]">
        <div className="mb-4 flex items-center justify-between"><div><h2 className="text-[15px] font-semibold">{chinese ? `${analysis.required_count} 个 REQUIRED TP 的 Gerber 绑定` : `${analysis.required_count} REQUIRED TP Gerber bindings`}</h2><p className="mt-1 text-[11px] text-[#777e7b]">{chinese ? "实际尺寸来自唯一命中的 Gerber 几何；歧义、未命中、NET 冲突及同面屏蔽罩覆盖保持 REVIEW。" : "Actual sizes come from uniquely matched Gerber geometry; ambiguity, misses, NET conflicts, and same-side shield coverage remain REVIEW."}</p></div><Verdict verdict={analysis.verdict} /></div>
        <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#15191b]">
          <div className="grid grid-cols-[1fr_70px_76px_120px_1fr_110px_96px] gap-3 border-b border-white/[0.07] px-4 py-2 font-mono text-[9px] text-[#777e7b]"><span>TP</span><span>SIDE</span><span>STATUS</span><span>ACTUAL SIZE</span><span>GERBER FEATURE / NET</span><span>SHIELD</span><span>POSITION</span></div>
          <div className="max-h-[640px] overflow-y-auto">{analysis.bindings.map((binding) => <button key={binding.candidate_id} onClick={() => onSelect(binding.candidate_id)} className={`grid w-full grid-cols-[1fr_70px_76px_120px_1fr_110px_96px] gap-3 border-b border-white/[0.05] px-4 py-3 text-left text-[10px] ${selectedId === binding.candidate_id ? "bg-[#c5a063]/[0.08]" : "hover:bg-white/[0.025]"}`}><span className="font-mono text-[#d2d0ca]">{binding.candidate_id}</span><span>{binding.side}</span><Verdict verdict={binding.status} compact /><span className="font-mono text-[#858b88]">{binding.matched_width_nm != null && binding.matched_height_nm != null ? `${(binding.matched_width_nm / 1e6).toFixed(3)} × ${(binding.matched_height_nm / 1e6).toFixed(3)} mm` : "—"}</span><span className="truncate font-mono text-[#858b88]">{binding.matched_feature_id ?? "UNMATCHED"} · {binding.matched_net_name ?? "NET ?"}</span><span className={binding.shield_candidate_refdes ? "font-mono text-[#d0a65f]" : "font-mono text-[#666d69]"}>{binding.shield_candidate_refdes ? `${binding.shield_candidate_refdes} · REVIEW` : "—"}</span><span className="font-mono text-[#858b88]">{(binding.transformed_center.x / 1e6).toFixed(3)}, {(binding.transformed_center.y / 1e6).toFixed(3)}</span></button>)}</div>
        </div>
      </div>
    </div>
    <aside className="sidebar-surface min-h-0 overflow-y-auto border-l border-white/[0.07] p-5">
      <PanelHead title={chinese ? "绑定与失败证据" : "BINDING AND FAILURE EVIDENCE"} verdict={analysis.verdict} />
      {selected ? <div className="rounded-xl border border-white/[0.08] bg-[#15191b] p-4"><div className="font-mono text-[10px] text-[#c5a063]">{selected.candidate_id}</div>{selected.shield_candidate_refdes && <div className="mt-2 inline-flex rounded-md border border-[#c79d57]/30 bg-[#2a2519] px-2 py-1 font-mono text-[9px] text-[#d0a65f]">SHIELD {selected.shield_candidate_refdes} · {selected.shield_identity_confidence} · REVIEW</div>}<p className="mt-2 text-[11px] leading-5 text-[#8d9390]">{selected.message}</p><div className="mt-3 font-mono text-[9px] text-[#6f7572]">{selected.matched_layer_id ?? "NO LAYER"}</div></div> : null}
      <div className="mt-4 space-y-3">{analysis.violations.filter((violation) => !selected || violation.entity_ids?.some((id) => id.includes(selected.candidate_id))).map((violation) => <div key={violation.id} className="rounded-xl border border-[#b76755]/25 bg-[#2b1e1a] p-3"><div className="font-mono text-[9px] text-[#d58e7d]">{violation.rule_id} · {violation.verdict}</div><p className="mt-1 text-[10px] leading-4 text-[#bd9289]">{violation.message}</p></div>)}</div>
    </aside>
  </section>;
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
  const [section, setSection] = useState<"REQUIREMENTS" | "METHODS" | "TEST" | "WIB" | "CONSTRAINTS">("REQUIREMENTS");
  return (
    <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-5">
        <SectionLabel>{chinese ? "产品原理图" : "PRODUCT SCHEMATIC"}</SectionLabel>
        <SourceCard label="PRODUCT" source={analysis.product.source_path} revision={analysis.product.revision} status={analysis.product.status} count={analysis.product.pins.length} />
        <SectionLabel>{chinese ? "受控计划" : "CONTROLLED PLAN"}</SectionLabel>
        <div className="space-y-2"><Metric label="LIFECYCLE" value={analysis.lifecycle_status} /><Metric label={chinese ? "测试需求" : "REQUIREMENTS"} value={analysis.requirements.length} /><Metric label={chinese ? "方法矩阵" : "METHOD MATRIX"} value={analysis.method_matrix.length} /><Metric label={chinese ? "规则包" : "RULE PACK"} value={analysis.baseline.approved_rule_pack_id ?? "-"} /></div>
        {analysis.approval && <div className="mt-4 rounded-xl border border-[#779166]/25 bg-[#779166]/[0.055] p-3 text-[9px] leading-4 text-[#9db18f]">{analysis.approval.statement}<div className="mt-2 break-all font-mono text-[8px]">SHA-256 {analysis.approval.content_hash}</div></div>}
        <div className="mt-5 rounded-xl border border-[#c79d57]/25 bg-[#2a2519] p-3 text-[10px] leading-5 text-[#a9946b]">{chinese ? "数值硬指标无权威来源时保持 TBD/REVIEW；Viewer 不会自动补值。" : "Numeric hard metrics remain TBD/REVIEW without an applicable authority."}</div>
      </aside>
      <div className="canvas-stage min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1080px]">
          <div className="mb-5 flex flex-wrap gap-2">{(["REQUIREMENTS", "METHODS", "TEST", "WIB", "CONSTRAINTS"] as const).map((item) => <button key={item} onClick={() => setSection(item)} className={`rounded-lg px-3 py-2 text-[11px] font-medium ${section === item ? "bg-[#c5a063] text-[#241d14]" : "border border-white/[0.08] bg-[#15191b] text-[#989e9b]"}`}>{item === "REQUIREMENTS" ? chinese ? "测试需求" : "Requirements" : item === "METHODS" ? chinese ? "方法—故障矩阵" : "Method-fault matrix" : item === "TEST" ? chinese ? "候选建议" : "Candidates" : item === "WIB" ? chinese ? "WIB 设计建议" : "WIB design" : chinese ? "约束与硬指标" : "Constraints"}</button>)}</div>
          {section === "REQUIREMENTS" ? <div className="space-y-3">{analysis.requirements.map((item) => <button key={item.id} onClick={() => onSelect(item.id)} className={`grid w-full grid-cols-[90px_minmax(180px,1fr)_150px_140px] gap-3 rounded-xl border p-4 text-left ${selectedId === item.id ? "border-[#c5a063]/50 bg-[#c5a063]/[0.06]" : "border-white/[0.07] bg-[#15191b]"}`}><span className="font-mono text-[9px] text-[#c4a167]">{item.priority}</span><div><div className="font-mono text-[9px] text-[#717773]">{item.id}</div><h3 className="mt-1 text-[12px]">{item.title}</h3><p className="mt-2 text-[10px] leading-4 text-[#7f8582]">{item.fault_classes.join(" · ")}</p></div><Value label={chinese ? "访问" : "ACCESS"} value={`${item.access_strategy}${item.physical_access_required ? " · PHYSICAL" : ""}`} /><Value label={chinese ? "方法" : "METHODS"} value={item.methods.join(", ")} /></button>)}</div>
            : section === "METHODS" ? <div className="space-y-3">{analysis.method_matrix.map((item) => <div key={item.method} className="grid grid-cols-[160px_120px_1fr_1fr] gap-3 rounded-xl border border-white/[0.07] bg-[#15191b] p-4"><Value label="METHOD" value={item.method} /><Value label="DISPOSITION" value={item.disposition} /><Value label={chinese ? "目标故障" : "TARGET FAULTS"} value={item.target_fault_classes.join(", ")} /><Value label={chinese ? "残余缺口" : "RESIDUAL GAPS"} value={item.residual_gaps.join(", ")} /></div>)}</div>
            : section === "TEST" ? <div className="grid grid-cols-2 gap-4">{analysis.recommendations.map((item) => <RecommendationCard key={item.id} selected={selectedId === item.id} onClick={() => onSelect(item.id)} priority={item.priority} title={item.title} nets={item.net_names} body={item.suggested_test} foot={item.observation} />)}</div>
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

function LayoutAccessContent({ analysis, selectedId, onSelect, onLocateTestPoint, chinese }: { analysis: LayoutTestAccessAnalysis; selectedId: string | null; onSelect(id: string): void; onLocateTestPoint?: (id: string) => void; chinese: boolean }) {
  const selected = analysis.mappings.find((mapping) => mapping.id === selectedId);
  return (
    <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-5">
        <SectionLabel>{chinese ? "冻结基线" : "FROZEN BASELINES"}</SectionLabel>
        {[['PCB', analysis.design_id], ['LAYOUT BASELINE', analysis.layout_baseline_confirmation_id ?? 'MISSING'], ['DFT PLAN', analysis.test_plan_id], ['RULE PACK', analysis.rule_pack_id], ['GEOMETRY', analysis.geometry_analysis_id]].map(([label, value]) => <div key={label} className="mb-2 rounded-lg border border-white/[0.07] bg-[#15191b] p-3"><div className="font-mono text-[9px] text-[#777e7b]">{label}</div><div className="mt-1 break-all font-mono text-[10px] text-[#c9c7c1]">{value}</div></div>)}
        <SectionLabel>{chinese ? "设计裁决" : "DESIGN VERDICT"}</SectionLabel>
        <div className="grid grid-cols-2 gap-2"><Metric label="PASS" value={analysis.pass_count} /><Metric label="FAIL" value={analysis.fail_count} /><Metric label="REVIEW" value={analysis.review_count} /><Metric label="N/A" value={analysis.not_applicable_count} /></div>
        <div className="mt-4 rounded-xl border border-[#c79d57]/25 bg-[#2a2519] p-3 text-[10px] leading-5 text-[#b59a69]">{chinese ? `生产放行：${analysis.production_readiness_verdict}。夹具接触、板弯、资源、带电安全、节拍和试产证据不由静态 Layout PASS 代替。` : `Production release: ${analysis.production_readiness_verdict}. Static Layout PASS does not replace fixture, safety, throughput, or pilot evidence.`}</div>
      </aside>
      <div className="canvas-stage min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1120px]">
          <div className="mb-5 flex items-center justify-between"><div><h2 className="text-[16px] font-semibold">{chinese ? "Approved Requirement → TestAccessMapping" : "Approved Requirement → TestAccessMapping"}</h2><p className="mt-1 text-[11px] text-[#7d8380]">{chinese ? "物理探针与连接器、边界扫描、烧录、BIST/FCT 分开裁决；启发式身份只能 REVIEW。" : "Physical probes and virtual methods are adjudicated separately; inferred identity remains REVIEW."}</p></div><Verdict verdict={analysis.verdict} /></div>
          <div className="mb-5 rounded-xl border border-white/[0.07] bg-[#121618]"><div className="border-b border-white/[0.06] px-4 py-3 font-mono text-[9px] text-[#8a908d]">{chinese ? "ODB++ 基线与语义可判定性" : "ODB++ BASELINE AND SEMANTIC DETERMINACY"}</div>{(analysis.baseline_checks ?? []).map((check) => <div key={check.id} className="grid grid-cols-[82px_160px_minmax(0,1fr)] gap-3 border-b border-white/[0.05] px-4 py-3"><Verdict verdict={check.status} compact /><div><div className="font-mono text-[9px] text-[#777e7b]">{check.id}</div><div className="mt-1 break-all text-[9px] text-[#9aa19e]">{check.recorded_value}</div></div><div><div className="text-[10px] text-[#d0cfca]">{check.requirement}</div><p className="mt-1 text-[9px] leading-4 text-[#777e7b]">{check.message}</p></div></div>)}</div>
          <div className="space-y-3">{analysis.mappings.map((mapping) => <button key={mapping.id} onClick={() => { onSelect(mapping.id); const point = mapping.matched_test_points[0]; if (point) onLocateTestPoint?.(point.id); }} className={`grid w-full grid-cols-[92px_minmax(190px,1fr)_140px_120px] items-start gap-3 rounded-xl border p-4 text-left ${selectedId === mapping.id ? "border-[#c5a063]/55 bg-[#c5a063]/[0.06]" : "border-white/[0.07] bg-[#15191b]"}`}><Verdict verdict={mapping.status} compact /><div><div className="font-mono text-[9px] text-[#777e7b]">{mapping.requirement_id}</div><div className="mt-1 text-[11px] leading-5 text-[#d3d2cd]">{mapping.message}</div><div className="mt-2 font-mono text-[9px] text-[#82938d]">{mapping.target_net_names.join(", ") || mapping.target_functions?.join(", ") || "NO NET / FUNCTION"}</div></div><Value label={chinese ? "访问方式" : "ACCESS"} value={mapping.access_strategy} /><Value label={chinese ? "匹配目标" : "TARGETS"} value={`${mapping.matched_test_points.length}${mapping.matched_test_points.length ? (chinese ? " · 点击定位" : " · CLICK TO LOCATE") : ""}`} /></button>)}</div>
          {selected && <div className="mt-5 rounded-xl border border-white/[0.08] bg-[#111416] p-4"><div className="font-mono text-[9px] text-[#c5a063]">{selected.verification_mode} · {selected.geometry_violation_ids.length} geometry finding(s)</div><p className="mt-2 text-[12px] leading-5 text-[#969c99]">{selected.evidence.join(" · ") || (chinese ? "无证据链接" : "No evidence links")}</p></div>}
        </div>
      </div>
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-l border-white/[0.07]">
        <PanelHead title={chinese ? "工厂关闭项" : "FACTORY CLOSURE"} verdict="REVIEW" />
        {analysis.factory_confirmation_items.map((item) => <div key={item.id} className="border-b border-white/[0.06] px-4 py-4"><div className="flex items-center gap-2"><Verdict verdict="REVIEW" compact /><span className="text-[10px] font-medium">{item.requirement}</span></div><p className="mt-2 text-[10px] leading-4 text-[#777e7b]">{item.closure_evidence}</p></div>)}
      </aside>
    </section>
  );
}

function QualificationContent({ analysis, selectedId, onSelect, chinese }: { analysis: WibQualificationAnalysis; selectedId: string | null; onSelect(id: string): void; chinese: boolean }) {
  const selected = analysis.constraint_results.find((result) => result.id === selectedId);
  const selectedRequirement = analysis.requirement_results?.find((result) => result.id === selectedId);
  return (
    <section className="grid min-h-0 grid-cols-[272px_minmax(0,1fr)_360px]">
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-5">
        <SectionLabel>{chinese ? "闭环输入" : "CLOSED-LOOP INPUTS"}</SectionLabel>
        {[['PRODUCT', analysis.product_pinout_id], ['WIB', analysis.wib_pinout_id], ['INTERFACE', analysis.interface_contract_id], ['DFT PLAN', analysis.test_plan_id], ['CONSTRAINTS', analysis.constraint_set_id]].map(([label, value]) => <div key={label} className="mb-2 rounded-lg border border-white/[0.07] bg-[#15191b] p-3"><div className="font-mono text-[9px] text-[#777e7b]">{label}</div><div className="mt-1 break-all font-mono text-[10px] text-[#c9c7c1]">{value ?? "MISSING"}</div></div>)}
        <SectionLabel>{chinese ? "裁决" : "VERDICT"}</SectionLabel>
        <div className="grid grid-cols-2 gap-2"><Metric label="PASS" value={analysis.pass_count} /><Metric label="FAIL" value={analysis.fail_count} /><Metric label="REVIEW" value={analysis.review_count} /><Metric label="WIRING" value={analysis.wiring_verdict} /></div>
        {analysis.production_readiness_verdict && <div className="mt-3 rounded-xl border border-[#c79d57]/25 bg-[#2a2519] p-3 text-[10px] text-[#b99c69]">PRODUCTION READINESS · {analysis.production_readiness_verdict}</div>}
      </aside>
      <div className="canvas-stage min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-[1080px]">
          <div className="mb-5 flex items-center justify-between"><div><h2 className="text-[16px] font-semibold">{chinese ? "WIB 硬约束逐条验证" : "WIB hard-constraint qualification"}</h2><p className="mt-1 text-[11px] text-[#7d8380]">{chinese ? "只有全部适用约束有证据且通过，最终状态才是 PASS。" : "Final PASS requires supported evidence and PASS for every applicable constraint."}</p></div><Verdict verdict={analysis.verdict} /></div>
          <div className="space-y-3">{analysis.constraint_results.map((result) => <button key={result.id} onClick={() => onSelect(result.id)} className={`grid w-full grid-cols-[100px_1fr_160px_160px] items-start gap-3 rounded-xl border p-4 text-left ${selectedId === result.id ? "border-[#c5a063]/55 bg-[#c5a063]/[0.06]" : "border-white/[0.07] bg-[#15191b]"}`}><Verdict verdict={result.status} compact /><div><div className="font-mono text-[9px] text-[#777e7b]">{result.constraint_id} · {result.area}</div><div className="mt-1 text-[12px] leading-5 text-[#d3d2cd]">{result.requirement}</div></div><Value label={chinese ? "要求" : "REQUIRED"} value={formatRequired(result.required_value, result.unit)} /><Value label={chinese ? "实际" : "ACTUAL"} value={result.actual_value == null ? "MISSING" : `${result.actual_value}${result.unit ? ` ${result.unit}` : ""}`} /></button>)}</div>
          {selected && <div className="mt-5 rounded-xl border border-white/[0.08] bg-[#111416] p-4"><div className="font-mono text-[9px] text-[#c5a063]">{selected.verification_mode}</div><p className="mt-2 text-[12px] leading-5 text-[#969c99]">{selected.message}</p></div>}
          {analysis.requirement_results && <><h2 className="mb-3 mt-8 text-[15px] font-semibold">{chinese ? "Approved DFT Requirement → WIB 路径" : "Approved DFT Requirement → WIB path"}</h2><div className="space-y-3">{analysis.requirement_results.map((result) => <button key={result.id} onClick={() => onSelect(result.id)} className={`grid w-full grid-cols-[100px_1fr_160px] items-start gap-3 rounded-xl border p-4 text-left ${selectedId === result.id ? "border-[#c5a063]/55 bg-[#c5a063]/[0.06]" : "border-white/[0.07] bg-[#15191b]"}`}><Verdict verdict={result.status} compact /><div><div className="font-mono text-[9px] text-[#777e7b]">{result.requirement_id} · {result.access_strategy}</div><div className="mt-1 text-[11px] leading-5 text-[#d3d2cd]">{result.message}</div><div className="mt-2 font-mono text-[9px] text-[#82938d]">{result.target_net_names.join(", ")}</div></div><Value label={chinese ? "责任边界" : "RESPONSIBILITY"} value={result.responsibility_boundary} /></button>)}</div></>}
          {selectedRequirement && <div className="mt-5 rounded-xl border border-white/[0.08] bg-[#111416] p-4"><div className="font-mono text-[9px] text-[#c5a063]">{selectedRequirement.verification_mode}</div><p className="mt-2 text-[12px] leading-5 text-[#969c99]">{selectedRequirement.evidence.join(" · ")}</p></div>}
        </div>
      </div>
      <aside className="sidebar-surface min-h-0 overflow-y-auto border-l border-white/[0.07]">
        <PanelHead title={chinese ? "未关闭项" : "OPEN FINDINGS"} verdict={analysis.verdict} />
        {analysis.violations.length ? analysis.violations.map((finding) => <FindingButton key={finding.id} id={finding.id} selected={selectedId === finding.id} verdict={finding.status} title={finding.constraint_id} message={finding.message} onSelect={onSelect} />) : <PassState chinese={chinese} />}
        {(analysis.factory_confirmation_items ?? []).map((item) => <div key={item.id} className="border-t border-white/[0.06] px-4 py-3"><div className="flex items-center gap-2"><Verdict verdict="REVIEW" compact /><span className="text-[10px]">{item.requirement}</span></div><p className="mt-2 text-[9px] leading-4 text-[#747a77]">{item.closure_evidence}</p></div>)}
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
