import { CheckCircleIcon, FileArrowDownIcon, FolderOpenIcon, PlayIcon, ShieldCheckIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { Locale } from "./i18n";
import type {
  BrdTestPointCatalogV1,
  DesignSummary,
  KicadCliDetectionV1,
  RulePack,
  SelectedTestPointAnalysisV1,
  TestPointAlignmentOverlay,
  TestPointAlignmentV1,
  TestPointReviewAction,
  TestPointSelectionV1
} from "./types";

type InitialReference = { kind: "catalog" | "selection" | "alignment"; id: string } | null;

interface Props {
  locale: Locale;
  design: DesignSummary | undefined;
  rulePacks: RulePack[];
  initialReference?: InitialReference;
  onChooseDesign(): Promise<void>;
  onRestoreDesign(id: string): Promise<void>;
  onOverlayChange(points: TestPointAlignmentOverlay[]): void;
  onOpenAnalysis(analysis: SelectedTestPointAnalysisV1): void;
  onCatalogChanged?(): void;
  onClose(): void;
}

const PAGE_SIZE = 500;

export function BrdTestPointWorkflow({ locale, design, rulePacks, initialReference, onChooseDesign, onRestoreDesign, onOverlayChange, onOpenAnalysis, onCatalogChanged, onClose }: Props) {
  const chinese = locale === "zh-CN";
  const [catalog, setCatalog] = useState<BrdTestPointCatalogV1 | null>(null);
  const [selection, setSelection] = useState<TestPointSelectionV1 | null>(null);
  const [alignment, setAlignment] = useState<TestPointAlignmentV1 | null>(null);
  const [analysis, setAnalysis] = useState<SelectedTestPointAnalysisV1 | null>(null);
  const [candidates, setCandidates] = useState<BrdTestPointCatalogV1["candidates"]>([]);
  const [declaredVersion, setDeclaredVersion] = useState("17.4");
  const [productRevision, setProductRevision] = useState("");
  const [operator, setOperator] = useState(() => localStorage.getItem("circuit-inspector.approver") ?? "");
  const [alignmentComment, setAlignmentComment] = useState("");
  const [rulePackId, setRulePackId] = useState(() => rulePacks.find((pack) => pack.status === "APPROVED")?.id ?? "");
  const [filters, setFilters] = useState({ decision: "ALL", side: "ALL", confidence: "ALL", match: "ALL" });
  const [anchors, setAnchors] = useState(() => [0, 1, 2].map(() => ({ candidate_id: "", x_mm: "", y_mm: "" })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kicadDetection, setKicadDetection] = useState<KicadCliDetectionV1 | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.circuitInspector.detectKiCad()
      .then((detected) => { if (!cancelled) setKicadDetection(detected); })
      .catch((cause) => {
        if (!cancelled) {
          setKicadDetection({ available: false, supported: false, version: null, executable_path: null, diagnostic: message(cause) });
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!initialReference) return;
    let cancelled = false;
    setBusy(true);
    setError("");
    const load = async () => {
      if (initialReference.kind === "catalog") {
        const loaded = await window.circuitInspector.readBrdTestPointCatalog(initialReference.id);
        if (!cancelled) setCatalog(loaded);
      } else if (initialReference.kind === "selection") {
        const loadedSelection = await window.circuitInspector.readTpSelection(initialReference.id);
        const loadedCatalog = await window.circuitInspector.readBrdTestPointCatalog(loadedSelection.catalog_id);
        if (!cancelled) { setSelection(loadedSelection); setCatalog(loadedCatalog); }
      } else {
        const loadedAlignment = await window.circuitInspector.readTpAlignment(initialReference.id);
        const loadedSelection = await window.circuitInspector.readTpSelection(loadedAlignment.selection_id);
        const loadedCatalog = await window.circuitInspector.readBrdTestPointCatalog(loadedSelection.catalog_id);
        if (!design) await onRestoreDesign(loadedAlignment.design_id);
        if (!cancelled) { setAlignment(loadedAlignment); setSelection(loadedSelection); setCatalog(loadedCatalog); }
      }
    };
    void load().catch((cause) => !cancelled && setError(message(cause))).finally(() => !cancelled && setBusy(false));
    return () => { cancelled = true; };
  }, [initialReference?.kind, initialReference?.id, onRestoreDesign]);

  useEffect(() => {
    if (!catalog) { setCandidates([]); return; }
    let cancelled = false;
    const loadAllPages = async () => {
      const loaded: BrdTestPointCatalogV1["candidates"] = [];
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      while (offset < total) {
        const result = await window.circuitInspector.queryBrdTestPoints({
          catalog_id: catalog.id,
          ...(filters.side === "ALL" ? {} : { side: filters.side as "TOP" | "BOTTOM" }),
          ...(filters.confidence === "ALL" ? {} : { confidence: filters.confidence as "EXPLICIT" | "INFERRED" }),
          offset,
          limit: PAGE_SIZE
        });
        loaded.push(...result.candidates);
        total = result.total;
        if (result.candidates.length === 0) break;
        offset += result.candidates.length;
      }
      if (!cancelled) setCandidates(loaded);
    };
    void loadAllPages().catch((cause) => { if (!cancelled) setError(message(cause)); });
    return () => { cancelled = true; };
  }, [catalog?.id, filters.side, filters.confidence]);

  useEffect(() => {
    const bindings = analysis?.bindings ?? alignment?.preview_bindings ?? [];
    onOverlayChange(bindings
      .filter((binding): binding is typeof binding & { side: "TOP" | "BOTTOM" } => binding.side === "TOP" || binding.side === "BOTTOM")
      .map((binding) => ({
        candidate_id: binding.candidate_id,
        status: binding.status,
        side: binding.side,
        brd_center: binding.transformed_center,
        gerber_center: binding.matched_center,
        gerber_width_nm: binding.matched_width_nm,
        gerber_height_nm: binding.matched_height_nm,
        shield_candidate_refdes: binding.shield_candidate_refdes,
        shield_bounds: binding.shield_bounds
      })));
  }, [alignment, analysis, onOverlayChange]);

  const decisionById = useMemo(() => new Map(selection?.decisions.map((item) => [item.candidate_id, item]) ?? []), [selection]);
  const bindingById = useMemo(() => new Map((analysis?.bindings ?? alignment?.preview_bindings ?? []).map((item) => [item.candidate_id, item])), [alignment, analysis]);
  const shownCandidates = useMemo(() => candidates.filter((candidate) => {
    const reviewAction = reviewActionFor(decisionById.get(candidate.id));
    const match = bindingById.get(candidate.id)?.status ?? "UNANALYZED";
    return (filters.decision === "ALL" || reviewAction === filters.decision) && (filters.match === "ALL" || match === filters.match);
  }), [bindingById, candidates, decisionById, filters.decision, filters.match]);
  const anchorCandidateIds = catalog?.candidates.map((candidate) => candidate.id) ?? [];

  async function execute(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  async function importBrd() {
    const source = await window.circuitInspector.chooseBrd(locale);
    if (!source) return;
    await execute(async () => {
      const loaded = await window.circuitInspector.importBrdTestPoints({ path: source, declared_allegro_version: declaredVersion, ...(productRevision.trim() ? { product_revision: productRevision.trim() } : {}) });
      setCatalog(loaded); setSelection(null); setAlignment(null); setAnalysis(null);
      setNotice(chinese ? `已生成 ${loaded.candidates.length} 个候选 TP。` : `Generated ${loaded.candidates.length} TP candidates.`);
      onCatalogChanged?.();
    });
  }

  async function exportReview() {
    if (!catalog) return;
    await execute(async () => {
      const result = await window.circuitInspector.exportTpReview(catalog.id, locale);
      if (result.ok) setNotice(chinese ? `CSV 已导出：${result.path}` : `CSV exported: ${result.path}`);
    });
  }

  async function reviewCandidate(candidateId: string, reviewAction: Exclude<TestPointReviewAction, "REVIEW">) {
    if (!catalog || !operator.trim() || selection?.lifecycle_status === "APPROVED") return;
    localStorage.setItem("circuit-inspector.approver", operator.trim());
    await execute(async () => {
      const loaded = await window.circuitInspector.saveTpReview({
        catalog_id: catalog.id,
        reviewed_by: operator.trim(),
        decisions: catalog.candidates.map((candidate) => {
          const current = decisionById.get(candidate.id);
          return {
            candidate_id: candidate.id,
            review_action: candidate.id === candidateId ? reviewAction : reviewActionFor(current),
            comment: current?.comment ?? ""
          };
        })
      });
      setSelection(loaded); setAlignment(null); setAnalysis(null);
      setNotice(chinese ? `已保存 ${reviewAction}，${loaded.unresolved_count} 行仍为 REVIEW。` : `Saved ${reviewAction}; ${loaded.unresolved_count} row(s) remain REVIEW.`);
      onCatalogChanged?.();
    });
  }

  async function approveSelection() {
    if (!selection || !operator.trim()) return;
    localStorage.setItem("circuit-inspector.approver", operator.trim());
    await execute(async () => {
      const approved = await window.circuitInspector.approveTpSelection({ selection_id: selection.id, approved_by: operator.trim() });
      setSelection(approved); setNotice(chinese ? "TP 清单已冻结批准。" : "TP selection is approved and frozen."); onCatalogChanged?.();
    });
  }

  async function proposeAlignment(useAnchors: boolean) {
    if (!selection || !design) return;
    const parsedAnchors = useAnchors ? anchors.map((anchor) => ({ candidate_id: anchor.candidate_id, design_point: { x: Math.round(Number(anchor.x_mm) * 1e6), y: Math.round(Number(anchor.y_mm) * 1e6) } })) : undefined;
    await execute(async () => {
      const proposal = await window.circuitInspector.proposeTpAlignment({ selection_id: selection.id, design_id: design.id, ...(parsedAnchors ? { anchors: parsedAnchors } : {}) });
      setAlignment(proposal); setAnalysis(null);
      setNotice(proposal.requires_manual_anchors ? (chinese ? "自动建议不唯一，请填写三组非共线锚点。" : "The suggestion is not unique; enter three non-collinear anchors.") : (chinese ? "已生成唯一排序建议，仍需人工批准。" : "A unique ranked suggestion is ready for human approval."));
      onCatalogChanged?.();
    });
  }

  async function approveAlignment() {
    if (!alignment || !operator.trim() || !alignmentComment.trim()) return;
    await execute(async () => {
      const approved = await window.circuitInspector.approveTpAlignment({ alignment_id: alignment.id, approved_by: operator.trim(), comment: alignmentComment.trim() });
      setAlignment(approved); setNotice(chinese ? "对齐已冻结批准。" : "Alignment is approved and frozen."); onCatalogChanged?.();
    });
  }

  async function runAnalysis() {
    if (!design || !selection || !alignment || !rulePackId) return;
    await execute(async () => {
      const result = await window.circuitInspector.analyzeSelectedTestPoints({ design_id: design.id, selection_id: selection.id, alignment_id: alignment.id, rule_pack_id: rulePackId });
      setAnalysis(result); setNotice(chinese ? `分析完成：${result.verdict}，生产放行仍为 REVIEW。` : `Analysis completed: ${result.verdict}; production readiness remains REVIEW.`); onCatalogChanged?.();
    });
  }

  return <div className="absolute inset-0 z-50 flex items-start justify-center bg-[#080a0b]/75 p-5 backdrop-blur-sm">
    <section className="flex max-h-full w-full max-w-[1220px] flex-col overflow-hidden rounded-2xl border border-white/[0.1] bg-[#111416] shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
        <div><h2 className="text-[15px] font-semibold text-[#eeece7]">{chinese ? "Allegro BRD → TP 清单 → Gerber DFT" : "Allegro BRD → TP list → Gerber DFT"}</h2><p className="mt-1 text-[10px] text-[#777d79]">{chinese ? "TP 身份、规则裁决、生产放行是三个独立结论" : "TP identity, rule verdict, and production release are three independent conclusions"}</p></div>
        <button className="icon-button" onClick={onClose} aria-label={chinese ? "关闭" : "Close"}><XIcon size={16} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {error && <div className="mb-4 rounded-xl border border-[#b76755]/35 bg-[#2b1e1a] p-3 text-[11px] text-[#e3b5aa]">{error}</div>}
        {notice && <div className="mb-4 rounded-xl border border-[#779166]/30 bg-[#1b251d] p-3 text-[11px] text-[#a9bd9b]">{notice}</div>}
        <div className="grid gap-4 lg:grid-cols-2">
          <Step number={1} title={chinese ? "导入 BRD" : "Import BRD"} complete={Boolean(catalog)}>
            <ArtifactLine
              label={chinese ? "KICAD（自动检测）" : "KICAD (AUTO-DETECTED)"}
              value={catalog
                ? `${catalog.converter.version} · ${catalog.converter.executable_path}`
                : kicadDetection?.supported
                  ? `${kicadDetection.version} · ${kicadDetection.executable_path}`
                  : kicadDetection?.diagnostic ?? (chinese ? "正在自动检测本机 KiCad…" : "Detecting local KiCad…")}
            />
            <div className="mt-3 grid grid-cols-2 gap-2"><Field label={chinese ? "源 BRD 版本（ALLEGRO，不是 KICAD）" : "SOURCE BRD VERSION (ALLEGRO, NOT KICAD)"}><select value={declaredVersion} onChange={(event) => setDeclaredVersion(event.target.value)} className="workflow-input"><option>17.2</option><option>17.4</option></select></Field><Field label={chinese ? "产品修订" : "PRODUCT REVISION"}><input value={productRevision} onChange={(event) => setProductRevision(event.target.value)} className="workflow-input" placeholder="REV A" /></Field></div>
            <button className="primary-button mt-3" disabled={busy} onClick={() => void importBrd()}><FolderOpenIcon size={15} />{chinese ? "选择 .brd（自动调用本机 KiCad）" : "Choose .brd (run local KiCad automatically)"}</button>
            {catalog && <ArtifactLine label="CATALOG" value={`${catalog.id} · ${catalog.candidates.length} TP`} />}
          </Step>
          <Step number={2} title={chinese ? "导出候选 CSV / 界面逐点复核" : "Export candidate CSV / review inline"} complete={selection?.unresolved_count === 0}>
            <Field label={chinese ? "操作人" : "OPERATOR"}><input value={operator} onChange={(event) => setOperator(event.target.value)} className="workflow-input" /></Field>
            <p className="mt-2 text-[10px] leading-5 text-[#858b87]">{chinese ? "无需回导 CSV；请在下方逐个选择 APPROVE、REJECT 或 IGNORE。" : "No CSV re-import is required; choose APPROVE, REJECT, or IGNORE for every candidate below."}</p>
            <button className="secondary-button mt-3" disabled={!catalog || busy} onClick={() => void exportReview()}><FileArrowDownIcon size={15} />{chinese ? "导出候选 CSV（可选）" : "Export candidate CSV (optional)"}</button>
            {selection && <ArtifactLine label="SELECTION" value={`${selection.id} · REVIEW ${selection.unresolved_count}`} />}
          </Step>
          <Step number={3} title={chinese ? "批准并冻结 TP 清单" : "Approve and freeze TP selection"} complete={selection?.lifecycle_status === "APPROVED"}>
            <p className="text-[10px] leading-5 text-[#858b87]">{chinese ? "候选全集必须完整，且下方所有行必须关闭为 APPROVE、REJECT 或 IGNORE。只有 APPROVE 会进入后续分析。" : "The complete candidate set is required and every row below must close as APPROVE, REJECT, or IGNORE. Only APPROVE enters downstream analysis."}</p>
            <button className="primary-button mt-3" disabled={!selection || selection.lifecycle_status !== "DRAFT" || selection.unresolved_count > 0 || !operator.trim() || busy} onClick={() => void approveSelection()}><ShieldCheckIcon size={15} />{chinese ? "具名批准 TP 清单" : "Approve TP selection"}</button>
            {selection?.approval && <ArtifactLine label="SHA-256" value={selection.approval.content_hash} />}
          </Step>
          <Step number={4} title={chinese ? "Gerber 与人工对齐复核" : "Gerber and alignment review"} complete={alignment?.lifecycle_status === "APPROVED"}>
            <div className="flex items-center justify-between gap-3"><ArtifactLine label="GERBER" value={design ? `${design.id} · ${design.format}` : (chinese ? "尚未导入" : "Not imported")} /><button className="secondary-button shrink-0" onClick={() => void onChooseDesign()}><FolderOpenIcon size={14} />{chinese ? "导入 Gerber" : "Import Gerber"}</button></div>
            <button className="secondary-button mt-3" disabled={!design || selection?.lifecycle_status !== "APPROVED" || busy} onClick={() => void proposeAlignment(false)}>{chinese ? "生成 8 种正交变换建议" : "Rank 8 orthogonal transforms"}</button>
            {alignment && <div className="mt-3 grid grid-cols-4 gap-2"><Metric label="UNIQUE" value={alignment.selected.unique_matches} /><Metric label="AMBIG" value={alignment.selected.ambiguous_matches} /><Metric label="MISS" value={alignment.selected.unmatched} /><Metric label="RESIDUAL" value={`${(alignment.selected.outline_residual_nm / 1e6).toFixed(3)} mm`} /></div>}
            {alignment?.requires_manual_anchors && <div className="mt-3 space-y-2 rounded-xl border border-[#c79d57]/25 bg-[#2a2519] p-3"><div className="text-[10px] text-[#b59a69]">{chinese ? "三组非共线锚点（Gerber mm）" : "Three non-collinear anchors (Gerber mm)"}</div>{anchors.map((anchor, index) => <div key={index} className="grid grid-cols-[1fr_90px_90px] gap-2"><select className="workflow-input" value={anchor.candidate_id} onChange={(event) => setAnchors((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, candidate_id: event.target.value } : item))}><option value="">TP…</option>{anchorCandidateIds.map((id) => <option key={id}>{id}</option>)}</select><input className="workflow-input" placeholder="X mm" value={anchor.x_mm} onChange={(event) => setAnchors((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, x_mm: event.target.value } : item))} /><input className="workflow-input" placeholder="Y mm" value={anchor.y_mm} onChange={(event) => setAnchors((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, y_mm: event.target.value } : item))} /></div>)}<button className="secondary-button" disabled={anchors.some((anchor) => !anchor.candidate_id || !Number.isFinite(Number(anchor.x_mm)) || !Number.isFinite(Number(anchor.y_mm)))} onClick={() => void proposeAlignment(true)}>{chinese ? "用锚点重新建议" : "Re-propose with anchors"}</button></div>}
            {alignment && !alignment.requires_manual_anchors && alignment.lifecycle_status === "DRAFT" && <div className="mt-3 grid grid-cols-[1fr_auto] gap-2"><input className="workflow-input" value={alignmentComment} onChange={(event) => setAlignmentComment(event.target.value)} placeholder={chinese ? "人工复核备注（必填）" : "Human review comment (required)"} /><button className="primary-button" disabled={!operator.trim() || !alignmentComment.trim()} onClick={() => void approveAlignment()}><CheckCircleIcon size={14} />{chinese ? "批准对齐" : "Approve"}</button></div>}
          </Step>
        </div>
        <Step number={5} title={chinese ? "选择批准规则包并分析 REQUIRED TP" : "Run approved rules for REQUIRED TP"} complete={Boolean(analysis)} wide>
          <div className="grid grid-cols-[minmax(260px,1fr)_auto_auto] gap-2"><select className="workflow-input" value={rulePackId} onChange={(event) => setRulePackId(event.target.value)}><option value="">{chinese ? "选择 APPROVED 规则包…" : "Choose APPROVED rule pack…"}</option>{rulePacks.filter((pack) => pack.status === "APPROVED" && pack.rules.some((rule) => rule.source === "TEST_POINT" || rule.target === "TEST_POINT")).map((pack) => <option key={pack.id} value={pack.id}>{pack.title} · {pack.version}</option>)}</select><button className="primary-button" disabled={!design || selection?.lifecycle_status !== "APPROVED" || alignment?.lifecycle_status !== "APPROVED" || !rulePackId || busy} onClick={() => void runAnalysis()}><PlayIcon size={14} />{chinese ? "分析" : "Analyze"}</button><button className="secondary-button" disabled={!analysis} onClick={() => analysis && onOpenAnalysis(analysis)}>{chinese ? "打开报告视图" : "Open report view"}</button></div>
          {analysis && <div className="mt-3 grid grid-cols-5 gap-2"><Metric label="VERDICT" value={analysis.verdict} /><Metric label="PASS" value={analysis.pass_count} /><Metric label="FAIL" value={analysis.fail_count} /><Metric label="REVIEW" value={analysis.review_count} /><Metric label="PRODUCTION" value="REVIEW" /></div>}
        </Step>

        {catalog && <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#101315]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3"><div><div className="text-[12px] font-semibold">{chinese ? "TP 候选与 Gerber 绑定" : "TP candidates and Gerber bindings"}</div><div className="mt-1 font-mono text-[9px] text-[#6e7470]">{shownCandidates.length} / {catalog.candidates.length} · content-visibility virtualized rows</div></div><div className="flex gap-2">{(['decision', 'side', 'confidence', 'match'] as const).map((key) => <select key={key} className="workflow-input min-w-[118px]" value={filters[key]} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.value }))}><option value="ALL">{filterLabel(key)} · ALL</option>{filterOptions(key).map((option) => <option key={option}>{option}</option>)}</select>)}</div></div>
          <div className="grid grid-cols-[minmax(150px,1fr)_105px_245px_70px_110px_minmax(230px,1.3fr)] gap-3 border-b border-white/[0.06] px-4 py-2 font-mono text-[8px] text-[#686e6a]"><span>TP / NET</span><span>IDENTITY</span><span>REVIEW ACTION</span><span>SIDE</span><span>ACTUAL SIZE</span><span>MATCH / RULE EVIDENCE</span></div>
          <div className="max-h-[360px] overflow-y-auto">{shownCandidates.map((candidate) => {
            const reviewAction = reviewActionFor(decisionById.get(candidate.id));
            const binding = bindingById.get(candidate.id);
            const violations = analysis?.violations.filter((violation) => violation.entity_ids?.some((id) => id.includes(candidate.id))) ?? [];
            return <div key={candidate.id} style={{ contentVisibility: "auto", containIntrinsicSize: "0 64px" }} className="grid grid-cols-[minmax(150px,1fr)_105px_245px_70px_110px_minmax(230px,1.3fr)] gap-3 border-b border-white/[0.045] px-4 py-3 text-[10px]"><div className="min-w-0"><div className="truncate font-mono text-[#d3d0c9]">{candidate.refdes ?? candidate.id}</div><div className="mt-1 truncate text-[#717773]">{candidate.net_name ?? "NET ?"}</div></div><span className={candidate.identity_confidence === "INFERRED" ? "text-[#d0a65f]" : "text-[#95b083]"}>{candidate.source_kind} · {candidate.identity_confidence}</span><TpCandidateReviewControls action={reviewAction} locale={locale} disabled={busy || !operator.trim() || selection?.lifecycle_status === "APPROVED"} onChoose={(action) => void reviewCandidate(candidate.id, action)} /><span>{candidate.side}</span><span className="font-mono">{binding?.matched_width_nm != null && binding.matched_height_nm != null ? `${(binding.matched_width_nm / 1e6).toFixed(3)} × ${(binding.matched_height_nm / 1e6).toFixed(3)} mm` : "—"}</span><div><div className={binding?.status === "PASS" ? "text-[#95b083]" : "text-[#d0a65f]"}>{binding ? `${binding.status} · ${binding.shield_candidate_refdes ? `SHIELD ${binding.shield_candidate_refdes}` : binding.matched_feature_id ?? "UNMATCHED"}` : "UNANALYZED"}</div><div className="mt-1 text-[#737975]">{violations[0] ? `${violations[0].rule_id} · ${formatThreshold(violations[0].measured_value_nm)} / ${formatThreshold(violations[0].threshold_nm)} · ${violations[0].message}` : binding?.message ?? candidate.source_evidence.join(" · ")}</div></div></div>;
          })}</div>
        </div>}
      </div>
    </section>
  </div>;
}

function Step({ number, title, complete, wide, children }: { number: number; title: string; complete: boolean; wide?: boolean; children: React.ReactNode }) {
  return <section className={`rounded-2xl border p-4 ${wide ? "mt-4" : ""} ${complete ? "border-[#779166]/30 bg-[#182019]" : "border-white/[0.08] bg-[#15191b]"}`}><div className="mb-3 flex items-center gap-2"><span className={`grid size-6 place-items-center rounded-full font-mono text-[10px] ${complete ? "bg-[#779166] text-[#10150f]" : "bg-[#262a2c] text-[#a8aaa6]"}`}>{complete ? "✓" : number}</span><h3 className="text-[12px] font-semibold">{title}</h3></div>{children}</section>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1 block font-mono text-[8px] text-[#6f7571]">{label}</span>{children}</label>; }
function ArtifactLine({ label, value }: { label: string; value: string }) { return <div className="mt-3 min-w-0 rounded-lg border border-white/[0.06] bg-[#101315] px-3 py-2"><div className="font-mono text-[8px] text-[#686e6a]">{label}</div><div className="mt-1 truncate font-mono text-[9px] text-[#a4a7a1]" title={value}>{value}</div></div>; }
function Metric({ label, value }: { label: string; value: string | number }) { return <div className="rounded-lg border border-white/[0.06] bg-[#101315] px-3 py-2"><div className="font-mono text-[8px] text-[#686e6a]">{label}</div><div className="mt-1 font-mono text-[11px] text-[#d0cec8]">{value}</div></div>; }
export function TpCandidateReviewControls({ action, locale, disabled, onChoose }: { action: TestPointReviewAction; locale: Locale; disabled: boolean; onChoose(action: Exclude<TestPointReviewAction, "REVIEW">): void }) {
  const chinese = locale === "zh-CN";
  const options = ["APPROVE", "REJECT", "IGNORE"] as const;
  return <div><div className={`mb-1 font-mono text-[8px] ${action === "REVIEW" ? "text-[#d0a65f]" : "text-[#858b87]"}`}>{action === "REVIEW" ? (chinese ? "REVIEW · 请选择" : "REVIEW · choose") : action}</div><div className="grid grid-cols-3 gap-1">{options.map((option) => <button key={option} type="button" aria-pressed={action === option} title={reviewActionTitle(option, chinese)} disabled={disabled} onClick={() => onChoose(option)} className={`h-7 rounded-md border px-1 font-mono text-[7px] transition ${action === option ? option === "APPROVE" ? "border-[#779166]/60 bg-[#779166]/20 text-[#b9cdaa]" : option === "REJECT" ? "border-[#b76755]/60 bg-[#b76755]/15 text-[#e0a295]" : "border-[#8b8476]/55 bg-[#8b8476]/15 text-[#c8c0b0]" : "border-white/[0.08] bg-white/[0.025] text-[#737975] hover:bg-white/[0.06]"}`}>{option}</button>)}</div></div>;
}
function reviewActionFor(decision: TestPointSelectionV1["decisions"][number] | undefined): TestPointReviewAction { return decision?.review_action ?? (decision?.decision === "REQUIRED" ? "APPROVE" : decision?.decision === "NOT_REQUIRED" ? "REJECT" : "REVIEW"); }
function reviewActionTitle(action: Exclude<TestPointReviewAction, "REVIEW">, chinese: boolean) { return action === "APPROVE" ? (chinese ? "确认该候选为需要分析的 TP" : "Select this candidate as a required TP") : action === "REJECT" ? (chinese ? "否决该 TP 候选身份" : "Reject this TP candidate identity") : (chinese ? "有意排除该候选，不进入分析" : "Intentionally exclude this candidate from analysis"); }
function filterLabel(key: "decision" | "side" | "confidence" | "match") { return key === "decision" ? "REVIEW" : key.toUpperCase(); }
function filterOptions(key: "decision" | "side" | "confidence" | "match") { return key === "decision" ? ["APPROVE", "REJECT", "IGNORE", "REVIEW"] : key === "side" ? ["TOP", "BOTTOM"] : key === "confidence" ? ["EXPLICIT", "INFERRED"] : ["PASS", "REVIEW", "UNANALYZED"]; }
function formatThreshold(value: number | null) { return value == null ? "?" : `${(value / 1e6).toFixed(3)} mm`; }
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
