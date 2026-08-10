import {
  CheckCircleIcon,
  CircleNotchIcon,
  FileArrowUpIcon,
  FileTextIcon,
  ShieldCheckIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Locale } from "./i18n";
import type { RuleDefinition, RulePack } from "./types";

const APPROVER_KEY = "circuit-inspector.approver";
const ENTITY_OPTIONS = ["TEST_POINT", "COMPONENT", "COPPER", "BOARD_EDGE", "DRILL"] as const;
const METRIC_OPTIONS = ["CENTER_TO_CENTER", "EDGE_TO_EDGE", "BODY_TO_PAD"] as const;
const SEVERITY_OPTIONS = ["ERROR", "WARNING", "INFO"] as const;

export function RuleLibrary({ locale, onCatalogChanged }: { locale: Locale; onCatalogChanged(): void }) {
  const chinese = locale === "zh-CN";
  const [packs, setPacks] = useState<RulePack[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [approver, setApprover] = useState(() => window.localStorage.getItem(APPROVER_KEY) ?? "");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [dirtyIds, setDirtyIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selected = packs.find((pack) => pack.id === selectedId) ?? packs[0];

  async function loadRules(preferredId?: string) {
    const result = await window.circuitInspector.listRulePacks();
    const normalized = result.rule_packs.map((pack) => ({ ...pack, review_items: pack.review_items ?? [] }));
    setPacks(normalized);
    const next = preferredId ?? selectedId;
    setSelectedId(normalized.some((pack) => pack.id === next) ? next : normalized.find((pack) => pack.status === "DRAFT")?.id ?? normalized[0]?.id ?? "");
    setDirtyIds([]);
  }

  useEffect(() => {
    loadRules().catch((cause) => setError(message(cause)));
  }, []);

  async function chooseDocuments() {
    const chosen = await window.circuitInspector.chooseWorkbenchInput("RULE_DOCUMENT", true, locale);
    if (chosen.length) setPaths(chosen);
  }

  async function extract() {
    if (!paths.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.circuitInspector.extractRulePack({ paths, ...(title.trim() ? { title: title.trim() } : {}) });
      setPaths([]);
      setTitle("");
      await loadRules(result.rule_pack.id);
      onCatalogChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!selected || !approver.trim()) return;
    setBusy(true);
    setError("");
    try {
      window.localStorage.setItem(APPROVER_KEY, approver.trim());
      await persistDraft(selected);
      await window.circuitInspector.approveRulePack(selected.id, approver.trim());
      setApprovalOpen(false);
      await loadRules(selected.id);
      onCatalogChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function updateRule(ruleId: string, update: Partial<RuleDefinition>) {
    if (!selected || selected.status !== "DRAFT") return;
    setPacks((current) => current.map((pack) => pack.id === selected.id ? {
      ...pack,
      rules: pack.rules.map((rule) => rule.id === ruleId ? { ...rule, ...update } : rule)
    } : pack));
    markDirty(selected.id);
  }

  function removeRule(ruleId: string) {
    if (!selected || selected.status !== "DRAFT") return;
    setPacks((current) => current.map((pack) => pack.id === selected.id ? { ...pack, rules: pack.rules.filter((rule) => rule.id !== ruleId) } : pack));
    markDirty(selected.id);
  }

  function acknowledgeReviewItem(itemId: string, acknowledged: boolean) {
    if (!selected || selected.status !== "DRAFT") return;
    setPacks((current) => current.map((pack) => pack.id === selected.id ? {
      ...pack,
      review_items: pack.review_items.map((item) => item.id === itemId ? { ...item, acknowledged } : item)
    } : pack));
    markDirty(selected.id);
  }

  function markDirty(packId: string) {
    setDirtyIds((current) => current.includes(packId) ? current : [...current, packId]);
  }

  async function persistDraft(pack: RulePack) {
    const saved = await window.circuitInspector.updateRulePack({
      rule_pack_id: pack.id,
      rules: pack.rules,
      acknowledged_review_item_ids: pack.review_items.filter((item) => item.acknowledged).map((item) => item.id)
    });
    setPacks((current) => current.map((item) => item.id === saved.id ? saved : item));
    setDirtyIds((current) => current.filter((id) => id !== saved.id));
    return saved;
  }

  async function saveDraft() {
    if (!selected || selected.status !== "DRAFT") return;
    setBusy(true);
    setError("");
    try {
      await persistDraft(selected);
      onCatalogChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const blockers = selected ? approvalBlockers(selected) : [];
  const selectedIsDirty = selected ? dirtyIds.includes(selected.id) : false;

  return (
    <div className="grid h-full grid-rows-[64px_minmax(0,1fr)] overflow-hidden">
      <header className="topbar title-drag flex items-center justify-between px-6">
        <div className={`min-w-0 ${window.circuitInspector.platform === "darwin" ? "pl-[70px]" : ""}`}>
          <div className="text-[14px] font-semibold">{chinese ? "规则库" : "Rule library"}</div>
          <div className="mt-0.5 font-mono text-[10px] text-[#737572]">DRAFT → HUMAN REVIEW → APPROVED</div>
        </div>
        <button className="title-no-drag primary-button" onClick={() => void chooseDocuments()} disabled={busy}><FileArrowUpIcon size={15} />{chinese ? "选择规则文档" : "Choose documents"}</button>
      </header>

      <section className="grid min-h-0 grid-cols-[320px_minmax(0,1fr)]">
        <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07]">
          <div className="border-b border-white/[0.07] p-5">
            <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#747672]">{chinese ? "新建候选规则包" : "New candidate rule pack"}</div>
            <label className="block text-[11px] text-[#b9b8b3]" htmlFor="rule-title">{chinese ? "规则包标题" : "Rule-pack title"}</label>
            <input id="rule-title" className="workbench-input mt-2" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={chinese ? "可选，默认使用内容哈希" : "Optional; content hash is used by default"} />
            <div className="mt-3 min-h-14 rounded-lg border border-dashed border-white/[0.1] bg-[#111315] px-3 py-2.5">
              {paths.length ? paths.map((file) => <div key={file} className="truncate font-mono text-[9px] leading-5 text-[#858681]">{file}</div>) : <div className="text-[10px] leading-5 text-[#666966]">PDF · DOCX · Markdown · TXT</div>}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button className="secondary-button" onClick={() => void chooseDocuments()} disabled={busy}>{chinese ? "选择" : "Choose"}</button>
              <button className="primary-button" onClick={() => void extract()} disabled={!paths.length || busy}>{busy ? <CircleNotchIcon size={14} className="animate-spin" /> : <FileTextIcon size={14} />}{chinese ? "抽取" : "Extract"}</button>
            </div>
          </div>

          <div className="p-3">
            <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#747672]">{chinese ? "本地规则包" : "Local rule packs"}</div>
            {packs.length ? packs.map((pack) => (
              <button key={pack.id} className={`w-full rounded-lg border-l-2 px-3 py-3 text-left transition-colors ${selected?.id === pack.id ? "border-l-[#c5a063] bg-[#c5a063]/[0.055]" : "border-l-transparent hover:bg-white/[0.03]"}`} onClick={() => setSelectedId(pack.id)}>
                <div className="flex items-center gap-2"><span className={`status-chip status-${pack.status.toLowerCase()}`}>{pack.status}</span><span className="min-w-0 flex-1 truncate text-[11px] text-[#d5d3ce]">{pack.title}</span></div>
                <div className="mt-1.5 font-mono text-[9px] text-[#666966]">{pack.version} · {pack.rules.length} RULES</div>
              </button>
            )) : <div className="px-3 py-10 text-[11px] leading-5 text-[#70726f]">{chinese ? "尚无规则包。先从受控文档抽取候选规则。" : "No rule packs yet. Extract candidates from a controlled document."}</div>}
          </div>
        </aside>

        <div className="min-h-0 overflow-y-auto px-8 py-7">
          {error && <div role="alert" className="mb-5 flex gap-2 rounded-xl border border-[#b76755]/35 bg-[#35231f]/75 px-4 py-3 text-[12px] text-[#efc1b6]"><WarningCircleIcon size={16} className="shrink-0" />{error}</div>}
          {busy && !selected ? <RuleSkeleton /> : selected ? (
            <div className="mx-auto max-w-[1280px]">
              <div className="flex items-start justify-between gap-8 border-b border-white/[0.07] pb-6">
                <div>
                  <div className="mb-2 flex items-center gap-2"><span className={`status-chip status-${selected.status.toLowerCase()}`}>{selected.status}</span><span className="font-mono text-[9px] text-[#747672]">{selected.id}</span></div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-[#e9e7e2]">{selected.title}</h1>
                  <p className="mt-2 max-w-[70ch] text-[11px] leading-5 text-[#7e807d]">{chinese ? "批准前逐条核对对象、范围、距离定义、阈值、过滤条件、违规命中后的严重度和原文证据。批准后该版本不可变。" : "Before approval, verify object, scope, metric, threshold, filters, post-hit severity, and source evidence. The approved version is immutable."}</p>
                </div>
                {selected.status === "DRAFT" ? <div className="flex shrink-0 gap-2"><button className="secondary-button" onClick={() => void saveDraft()} disabled={busy || !selectedIsDirty}>{chinese ? "保存草稿" : "Save draft"}</button><button className="primary-button" onClick={() => setApprovalOpen(true)} disabled={busy || blockers.length > 0}><ShieldCheckIcon size={15} />{chinese ? "审查并批准" : "Review and approve"}</button></div> : <div className="flex items-center gap-2 text-[11px] text-[#9fb68a]"><CheckCircleIcon size={17} />{chinese ? "已批准" : "Approved"}</div>}
              </div>

              {selected.status === "DRAFT" && blockers.length > 0 && <div role="status" className="mt-5 rounded-xl border border-[#9b7a45]/35 bg-[#2c261a]/75 px-4 py-3 text-[11px] leading-5 text-[#d9b777]">{approvalMessage(blockers, locale)}</div>}
              {selected.status === "APPROVED" && selected.version === "0.1.0-draft" && <div role="alert" className="mt-5 rounded-xl border border-[#b76755]/35 bg-[#35231f]/75 px-4 py-3 text-[11px] leading-5 text-[#efc1b6]">{chinese ? "此规则包由旧版抽取器生成，严重度可能来自自动默认值。请从原文重新抽取并审核新草稿；现有已批准内容未被静默修改。" : "This pack came from the legacy extractor and may contain automatically defaulted severities. Re-extract and review a new draft; the approved content was not silently changed."}</div>}

              {selected.review_items.length > 0 && <div className="mt-5 rounded-xl border border-white/[0.08] bg-[#111315] p-4"><div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8c8e89]">{chinese ? "抽取复核项" : "Extraction review items"}</div><div className="space-y-3">{selected.review_items.map((item) => <label key={item.id} className="flex items-start gap-3 text-[10px] leading-5 text-[#aaa9a4]"><input type="checkbox" className="mt-1" checked={item.acknowledged} disabled={selected.status !== "DRAFT"} onChange={(event) => acknowledgeReviewItem(item.id, event.target.checked)} /><span><strong className="text-[#d3ad6d]">{item.code}</strong> · {reviewMessage(item.code, item.message, locale)}<small className="mt-1 block font-mono text-[9px] text-[#666966]">{item.citation.excerpt}</small></span></label>)}</div></div>}

              <div className="mt-6 overflow-x-auto rounded-xl border border-white/[0.08]">
                <table className={`${selected.status === "DRAFT" ? "editable-table" : "workbench-table"} min-w-[1280px]`}>
                  <thead><tr><th>{chinese ? "规则" : "Rule"}</th><th>{chinese ? "对象与目标" : "Source / target"}</th><th>{chinese ? "距离定义" : "Metric"}</th><th>{chinese ? "阈值" : "Threshold"}</th><th>{chinese ? "过滤" : "Filters"}</th><th>{chinese ? "违规严重度（命中后）" : "Violation severity (when hit)"}</th><th>{chinese ? "引用证据" : "Citation"}</th>{selected.status === "DRAFT" && <th>{chinese ? "操作" : "Action"}</th>}</tr></thead>
                  <tbody>{selected.rules.map((rule) => (
                    <tr key={rule.id}>
                      <td><strong>{rule.title}</strong><code>{rule.kind}</code><small>{rule.id}</small></td>
                      <td>{selected.status === "DRAFT" ? <div className="space-y-1"><select aria-label={`${rule.id} source`} value={rule.source} onChange={(event) => updateRule(rule.id, { source: event.target.value as RuleDefinition["source"] })}>{ENTITY_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select><select aria-label={`${rule.id} target`} value={rule.target ?? ""} onChange={(event) => updateRule(rule.id, { target: (event.target.value || null) as RuleDefinition["target"] })}><option value="">-</option>{ENTITY_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></div> : <><code>{rule.source}</code><span>→</span><code>{rule.target ?? "-"}</code></>}</td>
                      <td>{selected.status === "DRAFT" ? <div className="space-y-1"><select aria-label={`${rule.id} metric`} value={rule.metric ?? ""} onChange={(event) => updateRule(rule.id, { metric: (event.target.value || null) as RuleDefinition["metric"] })}><option value="">-</option>{METRIC_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select><input aria-label={`${rule.id} layers`} value={rule.layer_functions.join(", ")} placeholder="ALL LAYERS" onChange={(event) => updateRule(rule.id, { layer_functions: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></div> : <><code>{rule.metric ?? "-"}</code><small>{rule.layer_functions.join(", ") || "ALL LAYERS"}</small></>}</td>
                      <td>{selected.status === "DRAFT" ? <div className="flex items-center gap-1"><input aria-label={`${rule.id} threshold`} type="number" min="0.001" step="0.001" value={rule.threshold_nm > 0 ? rule.threshold_nm / 1_000_000 : ""} onChange={(event) => updateRule(rule.id, { threshold_nm: Math.round(Number(event.target.value) * 1_000_000) || 0 })} /><span className="font-mono text-[9px]">mm</span></div> : <span className="font-mono text-[#d3ae70]">{(rule.threshold_nm / 1_000_000).toFixed(3)} mm</span>}</td>
                      <td>{selected.status === "DRAFT" ? <div className="space-y-1"><label className="flex items-center gap-1"><input type="checkbox" checked={rule.same_net_only} onChange={(event) => updateRule(rule.id, { same_net_only: event.target.checked, different_net_only: event.target.checked ? false : rule.different_net_only })} />SAME NET</label><label className="flex items-center gap-1"><input type="checkbox" checked={rule.different_net_only} onChange={(event) => updateRule(rule.id, { different_net_only: event.target.checked, same_net_only: event.target.checked ? false : rule.same_net_only })} />DIFFERENT NET</label></div> : <small>{rule.same_net_only ? "SAME NET" : rule.different_net_only ? "DIFFERENT NET" : "NO NET FILTER"}</small>}</td>
                      <td>{selected.status === "DRAFT" ? <select aria-label={`${rule.id} severity`} value={rule.severity ?? ""} onChange={(event) => updateRule(rule.id, { severity: (event.target.value || null) as RuleDefinition["severity"] })}><option value="">{chinese ? "待确认" : "Pending"}</option>{SEVERITY_OPTIONS.map((value) => <option key={value} value={value}>{severityLabel(value, locale)}</option>)}</select> : <span className={rule.severity ? `severity-${rule.severity.toLowerCase()}` : "severity-pending"}>{severityLabel(rule.severity, locale)}</span>}</td>
                      <td><p>{rule.citation.excerpt}</p><small>{rule.citation.source_path}{rule.citation.page ? ` · p.${rule.citation.page}` : ""}</small></td>
                      {selected.status === "DRAFT" && <td><button className="rounded-md p-1.5 text-[#9c7469] hover:bg-white/5" aria-label={`${chinese ? "删除规则" : "Delete rule"} ${rule.title}`} onClick={() => removeRule(rule.id)}><TrashIcon size={14} /></button></td>}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          ) : <div className="grid h-full place-items-center text-[12px] text-[#777875]">{chinese ? "选择或创建规则包" : "Select or create a rule pack"}</div>}
        </div>
      </section>

      {approvalOpen && selected && (
        <div className="fixed inset-0 grid place-items-center bg-[#0d0f10]/82 p-6 backdrop-blur-md">
          <div role="dialog" aria-modal="true" aria-labelledby="rule-approval-title" className="popover-surface w-full max-w-[620px] rounded-2xl p-6">
            <div className="flex items-start justify-between gap-6"><div><h2 id="rule-approval-title" className="text-[16px] font-semibold">{chinese ? "确认批准规则包" : "Confirm rule-pack approval"}</h2><p className="mt-2 text-[11px] leading-5 text-[#858681]">{selected.title} · {selected.rules.length} {chinese ? "条规则。此操作写入批准人、时间和规则内容 SHA-256。" : "rules. This records the approver, time, and rule-content SHA-256."}</p></div><button className="rounded-lg p-1.5 text-[#777875] hover:bg-white/5" onClick={() => setApprovalOpen(false)}><XIcon size={16} /></button></div>
            <label className="mt-5 block text-[11px] text-[#c8c6c1]" htmlFor="rule-approver">{chinese ? "批准人姓名或工号" : "Approver name or employee ID"}</label>
            <input id="rule-approver" className="workbench-input mt-2" value={approver} onChange={(event) => setApprover(event.target.value)} />
            <div className="mt-6 flex justify-end gap-2"><button className="secondary-button" onClick={() => setApprovalOpen(false)}>{chinese ? "取消" : "Cancel"}</button><button className="primary-button" disabled={!approver.trim() || busy} onClick={() => void approve()}>{busy ? <CircleNotchIcon size={14} className="animate-spin" /> : <ShieldCheckIcon size={14} />}{chinese ? "确认批准" : "Approve"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function RuleSkeleton() {
  return <div className="mx-auto max-w-[1200px] animate-pulse space-y-4"><div className="h-20 rounded-xl bg-white/[0.025]" /><div className="h-72 rounded-xl bg-white/[0.02]" /></div>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function approvalBlockers(pack: RulePack): string[] {
  const blockers: string[] = [];
  if (pack.rules.length === 0) blockers.push("NO_EXECUTABLE_RULES");
  if (pack.rules.some((rule) => rule.severity === null)) blockers.push("UNCONFIRMED_SEVERITY");
  if (pack.review_items.some((item) => !item.acknowledged)) blockers.push("UNACKNOWLEDGED_REVIEW_ITEM");
  if (pack.rules.some((rule) => rule.threshold_nm <= 0
    || (rule.kind === "MINIMUM_DISTANCE" && (!rule.target || !rule.metric))
    || (rule.kind === "MINIMUM_WIDTH" && (rule.source !== "COPPER" || rule.target !== null || rule.metric !== null))
    || (rule.kind === "MINIMUM_ANNULAR_RING" && (rule.source !== "DRILL" || rule.target !== "COPPER" || rule.metric !== null)))) blockers.push("INCOMPLETE_RULE");
  return blockers;
}

export function severityLabel(severity: RuleDefinition["severity"], locale: Locale): string {
  if (!severity) return locale === "zh-CN" ? "待确认" : "Pending";
  const labels = locale === "zh-CN"
    ? { ERROR: "高（ERROR）", WARNING: "中（WARNING）", INFO: "低（INFO）" }
    : { ERROR: "High (ERROR)", WARNING: "Medium (WARNING)", INFO: "Low (INFO)" };
  return labels[severity];
}

function approvalMessage(blockers: string[], locale: Locale): string {
  const chinese = locale === "zh-CN";
  const labels: Record<string, string> = chinese ? {
    NO_EXECUTABLE_RULES: "至少保留一条可执行规则",
    UNCONFIRMED_SEVERITY: "逐条确认违规命中后的严重度",
    UNACKNOWLEDGED_REVIEW_ITEM: "确认所有抽取复核项",
    INCOMPLETE_RULE: "补全对象、定义和有效阈值"
  } : {
    NO_EXECUTABLE_RULES: "Keep at least one executable rule",
    UNCONFIRMED_SEVERITY: "Confirm the post-hit severity of every rule",
    UNACKNOWLEDGED_REVIEW_ITEM: "Acknowledge every extraction review item",
    INCOMPLETE_RULE: "Complete entity, metric, and threshold fields"
  };
  return `${chinese ? "批准前必须：" : "Before approval: "}${blockers.map((blocker) => labels[blocker] ?? blocker).join(chinese ? "；" : "; ")}`;
}

function reviewMessage(code: string, fallback: string, locale: Locale): string {
  if (locale !== "zh-CN") return fallback;
  const labels: Record<string, string> = {
    RELATIVE_THRESHOLD: "原文使用相对直径公式，当前固定阈值引擎不能安全执行。",
    AMBIGUOUS_THRESHOLD: "原文包含多个尺寸，未擅自选择其中一个作为阈值。",
    NON_EXECUTABLE_GUIDANCE: "原文是尺寸或设备建议，不构成可执行的间距要求。",
    UNSUPPORTED_TARGET: "当前几何实体不能可靠表达该目标，需要人工确认。",
    LEGACY_AUTO_SEVERITY: "此严重度来自旧版自动默认值，必须重新确认。"
  };
  return labels[code] ?? fallback;
}
