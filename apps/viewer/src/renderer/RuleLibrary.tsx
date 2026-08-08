import {
  CheckCircleIcon,
  CircleNotchIcon,
  FileArrowUpIcon,
  FileTextIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { Locale } from "./i18n";
import type { RulePack } from "./types";

const APPROVER_KEY = "circuit-inspector.approver";

export function RuleLibrary({ locale, onCatalogChanged }: { locale: Locale; onCatalogChanged(): void }) {
  const chinese = locale === "zh-CN";
  const [packs, setPacks] = useState<RulePack[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [approver, setApprover] = useState(() => window.localStorage.getItem(APPROVER_KEY) ?? "");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selected = packs.find((pack) => pack.id === selectedId) ?? packs[0];

  async function loadRules(preferredId?: string) {
    const result = await window.circuitInspector.listRulePacks();
    setPacks(result.rule_packs);
    const next = preferredId ?? selectedId;
    setSelectedId(result.rule_packs.some((pack) => pack.id === next) ? next : result.rule_packs.find((pack) => pack.status === "DRAFT")?.id ?? result.rule_packs[0]?.id ?? "");
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
                  <p className="mt-2 max-w-[70ch] text-[11px] leading-5 text-[#7e807d]">{chinese ? "批准前逐条核对对象、范围、距离定义、比较器、阈值、单位、过滤条件、严重度和原文证据。批准后该版本不可变。" : "Before approval, verify object, scope, metric, comparator, threshold, unit, filters, severity, and source evidence. The approved version is immutable."}</p>
                </div>
                {selected.status === "DRAFT" ? <button className="primary-button shrink-0" onClick={() => setApprovalOpen(true)}><ShieldCheckIcon size={15} />{chinese ? "审查并批准" : "Review and approve"}</button> : <div className="flex items-center gap-2 text-[11px] text-[#9fb68a]"><CheckCircleIcon size={17} />{chinese ? "已批准" : "Approved"}</div>}
              </div>

              <div className="mt-6 overflow-x-auto rounded-xl border border-white/[0.08]">
                <table className="workbench-table min-w-[1120px]">
                  <thead><tr><th>{chinese ? "规则" : "Rule"}</th><th>{chinese ? "对象与目标" : "Source / target"}</th><th>{chinese ? "定义" : "Metric"}</th><th>{chinese ? "阈值" : "Threshold"}</th><th>{chinese ? "过滤" : "Filters"}</th><th>{chinese ? "严重度" : "Severity"}</th><th>{chinese ? "引用证据" : "Citation"}</th></tr></thead>
                  <tbody>{selected.rules.map((rule) => (
                    <tr key={rule.id}>
                      <td><strong>{rule.title}</strong><code>{rule.kind}</code><small>{rule.id}</small></td>
                      <td><code>{rule.source}</code><span>→</span><code>{rule.target ?? "-"}</code></td>
                      <td><code>{rule.metric ?? "-"}</code><small>{rule.layer_functions.join(", ") || "ALL LAYERS"}</small></td>
                      <td className="font-mono text-[#d3ae70]">{(rule.threshold_nm / 1_000_000).toFixed(3)} mm</td>
                      <td><small>{rule.same_net_only ? "SAME NET" : rule.different_net_only ? "DIFFERENT NET" : "NO NET FILTER"}</small></td>
                      <td><span className={`severity-${rule.severity.toLowerCase()}`}>{rule.severity}</span></td>
                      <td><p>{rule.citation.excerpt}</p><small>{rule.citation.source_path}{rule.citation.page ? ` · p.${rule.citation.page}` : ""}</small></td>
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
