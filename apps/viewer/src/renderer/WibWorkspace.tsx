import {
  ArrowRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  ClipboardTextIcon,
  FileArrowDownIcon,
  FileArrowUpIcon,
  FileHtmlIcon,
  FloppyDiskIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  WarningCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { Locale } from "./i18n";
import { SchematicReview } from "./SchematicReview";
import type {
  ArtifactCatalog,
  ConnectorMapping,
  SchematicDocument,
  TableImportResult,
  TableKind,
  TestRecommendationAnalysis,
  WibConstraintDefinition,
  WibConstraintSet,
  WibInterfaceContract,
  WibWorkflowDraft,
  WiringAnalysis,
  WibQualificationAnalysis
} from "./types";

const APPROVER_KEY = "circuit-inspector.approver";

type PinRow = { connector: string; pin: string; net_name: string };
type MetricRow = { id: string; value: string | number; unit: string | null };
type MappingRow = { product_connector: string; wib_connector: string; product_pin: string; wib_pin: string };
type AliasRow = { product_net: string; wib_net: string };
type SchematicCorrectionInput = Parameters<typeof window.circuitInspector.correctSchematic>[0]["corrections"][number];
type Confirmation = { title: string; body: string; run(identity: string): Promise<void> };

interface Props {
  locale: Locale;
  catalog: ArtifactCatalog;
  initialDraftId: string | null;
  initialWiringReview: WiringAnalysis | null;
  onCatalogChanged(): void;
  onOpenAnalysis(id: string): void;
}

export function WibWorkspace({ locale, catalog, initialDraftId, initialWiringReview, onCatalogChanged, onOpenAnalysis }: Props) {
  const chinese = locale === "zh-CN";
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const [draftId, setDraftId] = useState(() => `wib-draft-${Date.now().toString(36)}`);
  const [draftTitle, setDraftTitle] = useState(chinese ? "WIB 验证草稿" : "WIB qualification draft");
  const [product, setProduct] = useState<SchematicDocument | null>(null);
  const [wib, setWib] = useState<SchematicDocument | null>(null);
  const [productPins, setProductPins] = useState<PinRow[]>([]);
  const [wibPins, setWibPins] = useState<PinRow[]>([]);
  const [productMetrics, setProductMetrics] = useState<MetricRow[]>([]);
  const [wibMetrics, setWibMetrics] = useState<MetricRow[]>([]);
  const [productRevision, setProductRevision] = useState("");
  const [wibRevision, setWibRevision] = useState("");
  const [mappingRows, setMappingRows] = useState<MappingRow[]>([]);
  const [aliases, setAliases] = useState<AliasRow[]>([]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wiring, setWiring] = useState<WiringAnalysis | null>(null);
  const [interfaceContract, setInterfaceContract] = useState<WibInterfaceContract | null>(null);
  const [interfaceTitle, setInterfaceTitle] = useState(chinese ? "产品 ↔ WIB 接口契约" : "Product ↔ WIB interface contract");
  const [interfaceRevision, setInterfaceRevision] = useState("");
  const [testPlan, setTestPlan] = useState<TestRecommendationAnalysis | null>(null);
  const [testFactory, setTestFactory] = useState("");
  const [testLine, setTestLine] = useState("");
  const [testTester, setTestTester] = useState("");
  const [testVariant, setTestVariant] = useState("");
  const [testPanel, setTestPanel] = useState("");
  const [testRulePackId, setTestRulePackId] = useState("");
  const [constraints, setConstraints] = useState<WibConstraintDefinition[]>([]);
  const [constraintSet, setConstraintSet] = useState<WibConstraintSet | null>(null);
  const [constraintTitle, setConstraintTitle] = useState(chinese ? "WIB 受控硬约束" : "Controlled WIB hard constraints");
  const [constraintRevision, setConstraintRevision] = useState("");
  const [qualification, setQualification] = useState<WibQualificationAnalysis | null>(null);
  const [approver, setApprover] = useState(() => window.localStorage.getItem(APPROVER_KEY) ?? "");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pasteTarget, setPasteTarget] = useState<{ kind: TableKind; role?: "PRODUCT" | "WIB" } | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [progress, setProgress] = useState<{ phase: string; progress: number; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tableErrors, setTableErrors] = useState<string[]>([]);
  const [focusedPath, setFocusedPath] = useState<{ role: "PRODUCT" | "WIB"; id: string } | null>(null);

  const pinoutArtifacts = catalog.artifacts.filter((artifact) => artifact.kind === "PINOUT" || artifact.kind === "SCHEMATIC");
  const constraintArtifacts = catalog.artifacts.filter((artifact) => artifact.kind === "CONSTRAINT_SET");
  const interfaceArtifacts = catalog.artifacts.filter((artifact) => artifact.kind === "INTERFACE_CONTRACT");
  const testPlanArtifacts = catalog.artifacts.filter((artifact) => artifact.analysis_kind === "MANUFACTURING_TEST_RECOMMENDATIONS");
  const approvedRulePackArtifacts = catalog.artifacts.filter((artifact) => artifact.kind === "RULE_PACK" && artifact.status === "APPROVED");
  const connectorMappings = useMemo(() => groupMappings(mappingRows), [mappingRows]);
  const steps = [
    { id: 1 as const, zh: "产品输入", en: "Product input", ready: Boolean(product && product.status !== "DRAFT") },
    { id: 2 as const, zh: "WIB 输入", en: "WIB input", ready: Boolean(wib && wib.status !== "DRAFT") },
    { id: 3 as const, zh: "接口契约", en: "Interface contract", ready: Boolean(interfaceContract) },
    { id: 4 as const, zh: "DFT 基线", en: "DFT baseline", ready: testPlan?.lifecycle_status === "APPROVED" },
    { id: 5 as const, zh: "约束审批", en: "Constraint approval", ready: Boolean(constraintSet) },
    { id: 6 as const, zh: "最终验证", en: "Final qualification", ready: Boolean(qualification) }
  ];

  useEffect(() => window.circuitInspector.onProgress((event) => setProgress(event)), []);

  useEffect(() => {
    if (!initialDraftId) return;
    setBusy(true);
    window.circuitInspector.readWibDraft(initialDraftId)
      .then(async (draft) => {
        setDraftId(draft.id);
        setDraftTitle(draft.title);
        setStep(draft.step);
        setMappingRows(flattenMappings(draft.connector_mappings));
        setAliases(draft.net_aliases);
        setCaseSensitive(draft.case_sensitive ?? false);
        setConstraints(draft.constraint_rows as WibConstraintDefinition[]);
        setConstraintTitle(draft.constraint_title ?? (chinese ? "WIB 受控硬约束" : "Controlled WIB hard constraints"));
        setConstraintRevision(draft.constraint_revision ?? "");
        const [loadedProduct, loadedWib, loadedSet, loadedContract, loadedPlan] = await Promise.all([
          (draft.product_schematic_id ?? draft.product_pinout_id) ? window.circuitInspector.readSchematic((draft.product_schematic_id ?? draft.product_pinout_id)!) : Promise.resolve(null),
          (draft.wib_schematic_id ?? draft.wib_pinout_id) ? window.circuitInspector.readSchematic((draft.wib_schematic_id ?? draft.wib_pinout_id)!) : Promise.resolve(null),
          draft.constraint_set_id ? window.circuitInspector.readConstraintSet(draft.constraint_set_id) : Promise.resolve(null),
          draft.interface_contract_id ? window.circuitInspector.readInterfaceContract(draft.interface_contract_id) : Promise.resolve(null),
          draft.test_plan_id ? window.circuitInspector.readTestPlan(draft.test_plan_id) : Promise.resolve(null)
        ]);
        if (loadedProduct) applySchematic("PRODUCT", loadedProduct);
        if (loadedWib) applySchematic("WIB", loadedWib);
        if (draft.product_edits) {
          setProductPins(draft.product_edits.pins);
          setProductMetrics(draft.product_edits.design_metrics);
          setProductRevision(draft.product_edits.revision);
        }
        if (draft.wib_edits) {
          setWibPins(draft.wib_edits.pins);
          setWibMetrics(draft.wib_edits.design_metrics);
          setWibRevision(draft.wib_edits.revision);
        }
        setConstraintSet(loadedSet);
        setInterfaceContract(loadedContract);
        if (loadedContract) {
          setInterfaceTitle(loadedContract.title);
          setInterfaceRevision(loadedContract.revision);
        }
        setTestPlan(loadedPlan);
        if (loadedPlan) applyTestPlanBaseline(loadedPlan);
      })
      .catch((cause) => setError(message(cause)))
      .finally(() => setBusy(false));
  }, [initialDraftId]);

  useEffect(() => {
    if (!initialWiringReview) return;
    setBusy(true);
    setError("");
    Promise.all([
      window.circuitInspector.readSchematic(initialWiringReview.product_pinout_id),
      window.circuitInspector.readSchematic(initialWiringReview.wib_pinout_id)
    ])
      .then(([loadedProduct, loadedWib]) => {
        applySchematic("PRODUCT", loadedProduct);
        applySchematic("WIB", loadedWib);
        setMappingRows(flattenMappings(initialWiringReview.connector_mappings));
        setAliases(initialWiringReview.net_aliases);
        setCaseSensitive(initialWiringReview.case_sensitive ?? false);
        setWiring(initialWiringReview);
        setStep(3);
      })
      .catch((cause) => setError(message(cause)))
      .finally(() => setBusy(false));
  }, [initialWiringReview?.id]);

  function applySchematic(role: "PRODUCT" | "WIB", pinout: SchematicDocument) {
    const pins = pinout.pins.map(({ connector, pin, net_name }) => ({ connector, pin, net_name }));
    const metrics = pinout.design_metrics.map(({ id, value, unit }) => ({ id, value, unit }));
    if (role === "PRODUCT") {
      setProduct(pinout);
      setProductPins(pins);
      setProductMetrics(metrics);
      setProductRevision(pinout.revision ?? "");
    } else {
      setWib(pinout);
      setWibPins(pins);
      setWibMetrics(metrics);
      setWibRevision(pinout.revision ?? "");
    }
  }

  async function chooseAndImport(role: "PRODUCT" | "WIB", revision: string) {
    const selected = await window.circuitInspector.chooseWorkbenchInput("SCHEMATIC", false, locale);
    if (!selected[0]) return;
    await run(async () => {
      const pinout = await window.circuitInspector.importSchematic({ path: selected[0]!, role, ...(revision.trim() ? { revision: revision.trim() } : {}) });
      applySchematic(role, pinout);
      onCatalogChanged();
    });
  }

  async function loadPinout(role: "PRODUCT" | "WIB", id: string) {
    if (!id) return;
    await run(async () => applySchematic(role, await window.circuitInspector.readSchematic(id)));
  }

  async function traceSchematic(role: "PRODUCT" | "WIB", candidateId: string) {
    const document = role === "PRODUCT" ? product : wib;
    if (!document) return;
    await run(async () => applySchematic(role, await window.circuitInspector.traceSchematic({ schematic_id: document.id, candidate_id: candidateId })));
  }

  async function correctSchematic(role: "PRODUCT" | "WIB", corrections: SchematicCorrectionInput[], candidateId?: string) {
    const document = role === "PRODUCT" ? product : wib;
    if (!document || !approver.trim()) return;
    await run(async () => {
      const corrected = await window.circuitInspector.correctSchematic({ schematic_id: document.id, corrected_by: approver.trim(), ...(candidateId ? { candidate_id: candidateId } : {}), corrections });
      applySchematic(role, corrected);
      onCatalogChanged();
    });
  }

  function requestPathConfirmation(role: "PRODUCT" | "WIB", candidateId: string, pathIds: string[]) {
    const document = role === "PRODUCT" ? product : wib;
    if (!document || !pathIds.length) return;
    setConfirmation({
      title: chinese ? `确认 ${role} 分析路径` : `Confirm ${role} analysis paths`,
      body: chinese ? `只确认当前选择的 ${pathIds.length} 条接口路径及其跨页证据，不会把整份 PDF 标记为完全可信。歧义路径即使确认也不会被猜测为 PASS。` : `This confirms only ${pathIds.length} selected interface path(s) and their cross-page evidence. It does not mark the complete PDF as authoritative, and ambiguous paths are never guessed into PASS.`,
      run: async (identity) => {
        const confirmed = await window.circuitInspector.confirmSchematicPaths({ schematic_id: document.id, candidate_id: candidateId, path_ids: pathIds, confirmed_by: identity });
        applySchematic(role, confirmed);
        onCatalogChanged();
      }
    });
  }

  async function compare() {
    if (!product || !wib) return;
    const errors = validateMappingRows(mappingRows, aliases, chinese);
    setTableErrors(errors);
    if (errors.length) return;
    await run(async () => {
      const result = await window.circuitInspector.compareWiring({ product_pinout_id: product.id, wib_pinout_id: wib.id, connector_mappings: connectorMappings, net_aliases: aliases.filter((row) => row.product_net && row.wib_net), case_sensitive: caseSensitive });
      setWiring(result);
      onCatalogChanged();
    });
  }

  function requestInterfaceApproval() {
    if (!product || !wib) return;
    const errors = validateMappingRows(mappingRows, aliases, chinese);
    if (!connectorMappings.length || connectorMappings.some((mapping) => !mapping.pin_map?.length)) {
      errors.push(chinese ? "接口契约必须为每个连接器提供明确的逐引脚映射，不能只依赖 NET NAME。" : "An interface contract requires explicit pin mappings for every connector; NET NAME alone is insufficient.");
    }
    setTableErrors(errors);
    if (errors.length || !interfaceTitle.trim() || !interfaceRevision.trim()) return;
    setConfirmation({
      title: chinese ? "批准产品 ↔ WIB 接口契约" : "Approve product ↔ WIB interface contract",
      body: chinese ? "将冻结两份已确认原理图的修订、完整逐引脚映射、NET 别名和内容哈希。批准代表连接意图基线，不代表实际 WIB 已通过。" : "This freezes both confirmed revisions, the complete pin map, aliases, and content hashes. Approval establishes intent; it does not pass the actual WIB.",
      run: async (identity) => {
        const contract = await window.circuitInspector.createInterfaceContract({
          title: interfaceTitle.trim(),
          revision: interfaceRevision.trim(),
          approved_by: identity,
          product_pinout_id: product.id,
          wib_pinout_id: wib.id,
          connector_mappings: connectorMappings,
          net_aliases: aliases.filter((row) => row.product_net && row.wib_net),
          case_sensitive: caseSensitive
        });
        setInterfaceContract(contract);
        onCatalogChanged();
      }
    });
  }

  async function loadInterfaceContract(id: string) {
    if (!id) return;
    await run(async () => {
      const contract = await window.circuitInspector.readInterfaceContract(id);
      setInterfaceContract(contract);
      setInterfaceTitle(contract.title);
      setInterfaceRevision(contract.revision);
      setMappingRows(flattenMappings(contract.connector_mappings));
      setAliases(contract.net_aliases);
      setCaseSensitive(contract.case_sensitive);
    });
  }

  async function recommend() {
    if (!product) return;
    await run(async () => {
      const result = await window.circuitInspector.recommendTests(product.id);
      setTestPlan(result);
      if (!constraints.length) setConstraints(connectivityConstraints(result));
      onCatalogChanged();
    });
  }

  function applyTestPlanBaseline(plan: TestRecommendationAnalysis) {
    setTestFactory(plan.baseline.factory ?? "");
    setTestLine(plan.baseline.line ?? "");
    setTestTester(plan.baseline.tester ?? "");
    setTestVariant(plan.baseline.variant ?? "");
    setTestPanel(plan.baseline.panel ?? "");
    setTestRulePackId(plan.baseline.approved_rule_pack_id ?? "");
  }

  async function loadTestPlan(id: string) {
    if (!id) return;
    await run(async () => {
      const plan = await window.circuitInspector.readTestPlan(id);
      setTestPlan(plan);
      applyTestPlanBaseline(plan);
      if (!constraints.length) setConstraints(connectivityConstraints(plan));
    });
  }

  function requestTestPlanApproval() {
    if (!testPlan || testPlan.lifecycle_status !== "DRAFT" || !testFactory.trim() || !testLine.trim() || !testTester.trim() || !testRulePackId) return;
    setConfirmation({
      title: chinese ? "批准 DFT 需求基线" : "Approve DFT requirement baseline",
      body: chinese ? `将冻结 ${testPlan.requirements.length} 项需求与 ${testPlan.method_matrix.length} 种方法的故障覆盖分配，并绑定工厂、产线、测试机和批准规则包。夹具与试产放行仍是独立门槛。` : `This freezes ${testPlan.requirements.length} requirements and the method-fault allocation, bound to factory, line, tester, and approved rule pack. Fixture and pilot release remain separate gates.`,
      run: async (identity) => {
        const approved = await window.circuitInspector.approveTestPlan({
          test_plan_id: testPlan.id,
          approved_by: identity,
          ...(testVariant.trim() ? { variant: testVariant.trim() } : {}),
          ...(testPanel.trim() ? { panel: testPanel.trim() } : {}),
          factory: testFactory.trim(),
          line: testLine.trim(),
          tester: testTester.trim(),
          approved_rule_pack_id: testRulePackId
        });
        setTestPlan(approved);
        applyTestPlanBaseline(approved);
        onCatalogChanged();
      }
    });
  }

  function requestConstraintApproval() {
    const errors = validateConstraintRows(constraints, chinese);
    setTableErrors(errors);
    if (errors.length || !constraintTitle.trim() || !constraintRevision.trim()) return;
    setConfirmation({
      title: chinese ? "确认批准 WIB 约束集" : "Confirm WIB constraint-set approval",
      body: chinese ? `将批准 ${constraints.length} 条硬约束，修订 ${constraintRevision}。工厂依赖项即使被记录，最终仍保持 REVIEW。` : `This approves ${constraints.length} hard constraints at revision ${constraintRevision}. Factory-dependent rows remain REVIEW even after being recorded.`,
      run: async (identity) => {
        const result = await window.circuitInspector.createConstraintSet({ title: constraintTitle.trim(), revision: constraintRevision.trim(), approved_by: identity, constraints });
        setConstraintSet(result);
        onCatalogChanged();
      }
    });
  }

  async function loadConstraintSet(id: string) {
    if (!id) return;
    await run(async () => {
      const result = await window.circuitInspector.readConstraintSet(id);
      setConstraintSet(result);
      setConstraints(result.constraints);
      setConstraintTitle(result.title);
      setConstraintRevision(result.revision);
    });
  }

  async function qualify() {
    if (!product || !wib || !interfaceContract || !testPlan || testPlan.lifecycle_status !== "APPROVED" || !constraintSet) return;
    await run(async () => {
      const result = await window.circuitInspector.qualifyWib({ product_pinout_id: product.id, wib_pinout_id: wib.id, interface_contract_id: interfaceContract.id, approved_test_plan_id: testPlan.id, approved_constraint_set_id: constraintSet.id });
      setQualification(result);
      onCatalogChanged();
    });
  }

  async function saveDraft() {
    const draft: WibWorkflowDraft = {
      schema_version: 1,
      id: draftId,
      title: draftTitle.trim() || (chinese ? "WIB 验证草稿" : "WIB qualification draft"),
      step,
      product_pinout_id: product?.id ?? null,
      wib_pinout_id: wib?.id ?? null,
      product_schematic_id: product?.id ?? null,
      wib_schematic_id: wib?.id ?? null,
      product_edits: { pins: productPins, design_metrics: productMetrics, revision: productRevision },
      wib_edits: { pins: wibPins, design_metrics: wibMetrics, revision: wibRevision },
      connector_mappings: connectorMappings,
      net_aliases: aliases.filter((row) => row.product_net || row.wib_net),
      case_sensitive: caseSensitive,
      constraint_set_id: constraintSet?.id ?? null,
      interface_contract_id: interfaceContract?.id ?? null,
      test_plan_id: testPlan?.id ?? null,
      constraint_title: constraintTitle,
      constraint_revision: constraintRevision,
      constraint_rows: constraints,
      updated_at: new Date().toISOString()
    };
    await run(async () => {
      const saved = await window.circuitInspector.saveWibDraft(draft);
      setDraftId(saved.id);
      onCatalogChanged();
    });
  }

  async function importTable(kind: TableKind, role?: "PRODUCT" | "WIB") {
    const selected = await window.circuitInspector.chooseWorkbenchInput("TABLE", false, locale);
    if (!selected[0]) return;
    const result = await window.circuitInspector.importTable(kind, selected[0]);
    applyImportedRows(result, role);
  }

  async function exportTable(kind: TableKind, rows: Array<Record<string, unknown>>) {
    await window.circuitInspector.exportTable(kind, rows, "CSV", locale);
  }

  function applyImportedRows(result: TableImportResult, role?: "PRODUCT" | "WIB") {
    setTableErrors(result.errors.map((item) => `${chinese ? "第" : "Row "}${item.row}${chinese ? " 行" : ""}: ${item.message}`));
    if (result.errors.length) return;
    if (result.kind === "PINOUT") {
      const rows = result.rows as PinRow[];
      role === "PRODUCT" ? setProductPins(rows) : setWibPins(rows);
    } else if (result.kind === "DESIGN_METRIC") {
      const rows = result.rows as MetricRow[];
      role === "PRODUCT" ? setProductMetrics(rows) : setWibMetrics(rows);
    } else if (result.kind === "CONNECTOR_MAPPING") setMappingRows(result.rows as MappingRow[]);
    else if (result.kind === "NET_ALIAS") setAliases(result.rows as AliasRow[]);
    else setConstraints(result.rows as unknown as WibConstraintDefinition[]);
  }

  async function applyPaste() {
    if (!pasteTarget) return;
    const result = await window.circuitInspector.parseTableText(pasteTarget.kind, pasteText);
    applyImportedRows(result, pasteTarget.role);
    if (!result.errors.length) {
      setPasteTarget(null);
      setPasteText("");
    }
  }

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      await operation();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full grid-rows-[64px_minmax(0,1fr)] overflow-hidden">
      <header className="topbar title-drag grid grid-cols-[minmax(260px,1fr)_minmax(280px,520px)_auto] items-center gap-5 px-6">
        <div className={`min-w-0 ${window.circuitInspector.platform === "darwin" ? "pl-[70px]" : ""}`}><div className="text-[14px] font-semibold">{chinese ? "WIB 闭环工作流" : "WIB closed-loop workflow"}</div><div className="mt-0.5 truncate font-mono text-[9px] text-[#737572]">{draftId}</div></div>
        <input className="title-no-drag workbench-input" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} aria-label={chinese ? "草稿标题" : "Draft title"} />
        <button className="title-no-drag secondary-button" onClick={() => void saveDraft()} disabled={busy}><FloppyDiskIcon size={15} />{chinese ? "保存草稿" : "Save draft"}</button>
      </header>

      <section className="grid min-h-0 grid-cols-[244px_minmax(0,1fr)]">
        <aside className="sidebar-surface min-h-0 overflow-y-auto border-r border-white/[0.07] p-4">
          <div className="px-2 pb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#747672]">{chinese ? "受控流程" : "Controlled workflow"}</div>
          <div className="space-y-1">{steps.map((item) => (
            <button key={item.id} className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors ${step === item.id ? "bg-[#c5a063]/[0.08] text-[#e4d3b7]" : "text-[#8a8c88] hover:bg-white/[0.03]"}`} onClick={() => setStep(item.id)}>
              <span className={`grid size-6 shrink-0 place-items-center rounded-full border font-mono text-[9px] ${item.ready ? "border-[#779166]/45 bg-[#779166]/10 text-[#9fb68a]" : step === item.id ? "border-[#c5a063]/45 text-[#d2ad70]" : "border-white/[0.1]"}`}>{item.ready ? <CheckCircleIcon size={13} weight="fill" /> : item.id}</span>
              <span className="min-w-0 flex-1 text-[11px]">{chinese ? item.zh : item.en}</span>
              <ArrowRightIcon size={12} className="text-[#5f615f]" />
            </button>
          ))}</div>
          <div className="mt-6 border-t border-white/[0.065] px-2 pt-4">
            <div className="text-[9px] uppercase tracking-[0.12em] text-[#696b68]">{chinese ? "判定门禁" : "Verdict gate"}</div>
            <p className="mt-2 text-[10px] leading-5 text-[#747672]">{chinese ? "PDF 或推断引脚在人工确认前保持 REVIEW。工厂依赖约束不会因界面确认变成自动 PASS。" : "PDF or inferred pins remain REVIEW until confirmed. Factory-dependent constraints never become automatic PASS through this UI."}</p>
          </div>
        </aside>

        <div className="relative min-h-0 overflow-y-auto px-8 py-7">
          <div className="mx-auto max-w-[1380px]">
            {error && <InlineError text={error} />}
            {tableErrors.length > 0 && <div role="alert" className="mb-5 rounded-xl border border-[#9b7a45]/35 bg-[#2c261a]/85 px-4 py-3 text-[11px] text-[#e0bd7c]"><div className="mb-1 flex items-center gap-2 font-semibold"><WarningCircleIcon size={15} />{chinese ? "请修正表格问题" : "Fix table issues"}</div>{tableErrors.slice(0, 8).map((item) => <div key={item} className="font-mono text-[9px] leading-5">{item}</div>)}</div>}

            {step === 1 && <PinoutStep role="PRODUCT" locale={locale} document={product} metrics={productMetrics} revision={productRevision} artifacts={pinoutArtifacts.filter((item) => item.title.includes("PRODUCT"))} operator={approver} focusPathId={focusedPath?.role === "PRODUCT" ? focusedPath.id : null} busy={busy} onOperator={setApprover} onRevision={setProductRevision} onImport={() => void chooseAndImport("PRODUCT", productRevision)} onLoad={(id) => void loadPinout("PRODUCT", id)} onTrace={(candidateId) => traceSchematic("PRODUCT", candidateId)} onCorrect={(corrections, candidateId) => correctSchematic("PRODUCT", corrections, candidateId)} onConfirm={(candidateId, pathIds) => requestPathConfirmation("PRODUCT", candidateId, pathIds)} />}
            {step === 2 && <PinoutStep role="WIB" locale={locale} document={wib} metrics={wibMetrics} revision={wibRevision} artifacts={pinoutArtifacts.filter((item) => item.title.includes("WIB"))} operator={approver} focusPathId={focusedPath?.role === "WIB" ? focusedPath.id : null} busy={busy} onOperator={setApprover} onRevision={setWibRevision} onImport={() => void chooseAndImport("WIB", wibRevision)} onLoad={(id) => void loadPinout("WIB", id)} onTrace={(candidateId) => traceSchematic("WIB", candidateId)} onCorrect={(corrections, candidateId) => correctSchematic("WIB", corrections, candidateId)} onConfirm={(candidateId, pathIds) => requestPathConfirmation("WIB", candidateId, pathIds)} />}
            {step === 3 && <MappingStep locale={locale} product={product} wib={wib} mappingRows={mappingRows} aliases={aliases} caseSensitive={caseSensitive} wiring={wiring} contract={interfaceContract} contractTitle={interfaceTitle} contractRevision={interfaceRevision} contractArtifacts={interfaceArtifacts} busy={busy} onMappingRows={setMappingRows} onAliases={setAliases} onCaseSensitive={setCaseSensitive} onContractTitle={setInterfaceTitle} onContractRevision={setInterfaceRevision} onApproveContract={requestInterfaceApproval} onLoadContract={(id) => void loadInterfaceContract(id)} onSuggest={() => setMappingRows(suggestMappings(product, wib))} onCompare={() => void compare()} onOpenPath={(role, id) => { setFocusedPath({ role, id }); setStep(role === "PRODUCT" ? 1 : 2); }} onOpenAnalysis={onOpenAnalysis} onImport={(kind) => void importTable(kind)} onExport={(kind, rows) => void exportTable(kind, rows)} onPaste={(kind) => setPasteTarget({ kind })} />}
            {step === 4 && <RecommendationStep locale={locale} product={product} plan={testPlan} planArtifacts={testPlanArtifacts} rulePackArtifacts={approvedRulePackArtifacts} factory={testFactory} line={testLine} tester={testTester} variant={testVariant} panel={testPanel} rulePackId={testRulePackId} busy={busy} onFactory={setTestFactory} onLine={setTestLine} onTester={setTestTester} onVariant={setTestVariant} onPanel={setTestPanel} onRulePackId={setTestRulePackId} onGenerate={() => void recommend()} onLoad={(id) => void loadTestPlan(id)} onApprove={requestTestPlanApproval} onOpenAnalysis={onOpenAnalysis} />}
            {step === 5 && <ConstraintStep locale={locale} rows={constraints} set={constraintSet} title={constraintTitle} revision={constraintRevision} artifacts={constraintArtifacts} busy={busy} onRows={setConstraints} onTitle={setConstraintTitle} onRevision={setConstraintRevision} onApprove={requestConstraintApproval} onLoad={(id) => void loadConstraintSet(id)} onImport={() => void importTable("CONSTRAINT")} onExport={() => void exportTable("CONSTRAINT", constraints as unknown as Array<Record<string, unknown>>)} onPaste={() => setPasteTarget({ kind: "CONSTRAINT" })} />}
            {step === 6 && <QualificationStep locale={locale} product={product} wib={wib} interfaceContract={interfaceContract} testPlan={testPlan} constraintSet={constraintSet} qualification={qualification} busy={busy} onRun={() => void qualify()} onOpenAnalysis={onOpenAnalysis} />}
          </div>
          {busy && <div className="pointer-events-none sticky bottom-4 mx-auto mt-5 flex max-w-[720px] items-center gap-3 rounded-xl border border-[#c5a063]/20 bg-[#1b1c1c]/95 px-4 py-3 shadow-[0_20px_55px_rgba(5,6,6,0.35)] backdrop-blur-xl"><CircleNotchIcon size={16} className="animate-spin text-[#cbaa72]" /><span className="min-w-0 flex-1 truncate text-[11px] text-[#c8c6c1]">{progress?.message ?? (chinese ? "正在处理本地数据" : "Processing local data")}</span><span className="font-mono text-[9px] text-[#9a8159]">{progress?.progress ?? 12}%</span></div>}
        </div>
      </section>

      {confirmation && <ConfirmDialog locale={locale} confirmation={confirmation} approver={approver} busy={busy} onApprover={setApprover} onCancel={() => setConfirmation(null)} onConfirm={() => void run(async () => { const identity = approver.trim(); if (!identity) return; window.localStorage.setItem(APPROVER_KEY, identity); await confirmation.run(identity); setConfirmation(null); })} />}
      {pasteTarget && <PasteDialog locale={locale} kind={pasteTarget.kind} value={pasteText} errors={tableErrors} onChange={setPasteText} onCancel={() => { setPasteTarget(null); setPasteText(""); setTableErrors([]); }} onApply={() => void applyPaste()} />}
    </div>
  );
}

function PinoutStep({ role, locale, document, metrics, revision, artifacts, operator, focusPathId, busy, onOperator, onRevision, onImport, onLoad, onTrace, onCorrect, onConfirm }: {
  role: "PRODUCT" | "WIB"; locale: Locale; document: SchematicDocument | null; metrics: MetricRow[]; revision: string; artifacts: ArtifactCatalog["artifacts"]; operator: string; focusPathId: string | null; busy: boolean;
  onOperator(value: string): void; onRevision(value: string): void; onImport(): void; onLoad(id: string): void; onTrace(candidateId: string): Promise<void>; onCorrect(corrections: SchematicCorrectionInput[], candidateId?: string): Promise<void>; onConfirm(candidateId: string, pathIds: string[]): void;
}) {
  const chinese = locale === "zh-CN";
  return <section>
    <StepHeading eyebrow={`${role} · SCHEMATIC GRAPH V2`} title={role === "PRODUCT" ? chinese ? "导入、追踪并确认产品接口" : "Import, trace, and confirm the product interface" : chinese ? "导入、追踪并确认实际 WIB 设计" : "Import, trace, and confirm the actual WIB design"} description={chinese ? "完整 PDF 会在本地构建页面、器件、引脚、网络与跨页证据图。先确认接口锚点，再审查 WIB 引脚到最终芯片引脚的路径；只确认参与分析的路径。" : "Complete PDFs are converted locally into pages, components, pins, nets, and cross-page evidence. Select the interface anchor, then review each WIB-to-chip path and confirm only the paths used by analysis."} />
    <div className="mt-6 grid grid-cols-[minmax(0,1fr)_220px_auto] items-end gap-3">
      <label><span className="form-label">{chinese ? "恢复已有原理图" : "Resume an existing schematic"}</span><select className="workbench-input" value={document?.id ?? ""} onChange={(event) => onLoad(event.target.value)}><option value="">{chinese ? "选择本地产物" : "Choose local artifact"}</option>{artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} · {artifact.status}</option>)}</select></label>
      <label><span className="form-label">{chinese ? "受控修订" : "Controlled revision"}</span><input className="workbench-input" value={revision} onChange={(event) => onRevision(event.target.value)} placeholder="REV A" /></label>
      <button className="primary-button" onClick={onImport} disabled={busy}><FileArrowUpIcon size={15} />{chinese ? "导入文件" : "Import file"}</button>
    </div>
    {document && <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-white/[0.065] py-3"><span className={`status-chip status-${document.status.toLowerCase().replaceAll("_", "-")}`}>{document.status}</span><span className="font-mono text-[9px] text-[#777a76]">{document.source_format} · {document.pages.length} PAGE(S) · {document.components.length} COMPONENT(S)</span><span className="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-[#656865]">SHA-256 {document.source_hash}</span></div>}
    {document ? <SchematicReview locale={locale} document={document} operator={operator} focusPathId={focusPathId} busy={busy} onOperator={onOperator} onTrace={onTrace} onCorrect={onCorrect} onConfirm={onConfirm} /> : <EmptyStep text={chinese ? "导入产品/WIB 完整 PDF，或兼容的 JSON/CSV 引脚映射。所有处理均在本机完成。" : "Import a complete product/WIB PDF or a compatible JSON/CSV pin mapping. Processing stays local."} />}
    {metrics.length > 0 && <div className="mt-5 rounded-xl border border-white/[0.08] bg-[#141719] p-4"><div className="font-mono text-[9px] text-[#777a76]">DESIGN METRICS · {metrics.length}</div><div className="mt-2 flex flex-wrap gap-2">{metrics.map((metric) => <span key={metric.id} className="rounded-md border border-white/[0.07] px-2 py-1 font-mono text-[9px] text-[#aaa9a4]">{metric.id}={String(metric.value)} {metric.unit ?? ""}</span>)}</div></div>}
  </section>;
}

function MappingStep({ locale, product, wib, mappingRows, aliases, caseSensitive, wiring, contract, contractTitle, contractRevision, contractArtifacts, busy, onMappingRows, onAliases, onCaseSensitive, onContractTitle, onContractRevision, onApproveContract, onLoadContract, onSuggest, onCompare, onOpenPath, onOpenAnalysis, onImport, onExport, onPaste }: {
  locale: Locale; product: SchematicDocument | null; wib: SchematicDocument | null; mappingRows: MappingRow[]; aliases: AliasRow[]; caseSensitive: boolean; wiring: WiringAnalysis | null; contract: WibInterfaceContract | null; contractTitle: string; contractRevision: string; contractArtifacts: ArtifactCatalog["artifacts"]; busy: boolean;
  onMappingRows(rows: MappingRow[]): void; onAliases(rows: AliasRow[]): void; onCaseSensitive(value: boolean): void; onContractTitle(value: string): void; onContractRevision(value: string): void; onApproveContract(): void; onLoadContract(id: string): void; onSuggest(): void; onCompare(): void; onOpenPath(role: "PRODUCT" | "WIB", id: string): void; onOpenAnalysis(id: string): void; onImport(kind: TableKind): void; onExport(kind: TableKind, rows: Array<Record<string, unknown>>): void; onPaste(kind: TableKind): void;
}) {
  const chinese = locale === "zh-CN";
  return <section><StepHeading eyebrow="DOCUMENT_BACKED · WIRING" title={chinese ? "先按 NET NAME 复核，按需升级逐引脚比较" : "Review NET NAME first; add pin mapping only when needed"} description={chinese ? "映射表可以留空：软件会直接比较两侧 NET NAME 清单并保持 REVIEW。只有要证明精确引脚对应、检测交换并输出正式 PASS/FAIL 时，才需要连接器/引脚映射。" : "Mappings are optional: with none, the software compares NET NAME inventories and stays in REVIEW. Exact correspondence is needed only to prove identity, detect swaps, and produce formal PASS/FAIL."} />
    <div className="mt-6 grid grid-cols-2 gap-3"><SourceSummary label="PRODUCT" pinout={product} /><SourceSummary label="WIB" pinout={wib} /></div>
    <TableSection title={chinese ? "可选：精确连接器与引脚映射" : "Optional: exact connector and pin mappings"} count={mappingRows.length} onAdd={() => onMappingRows([...mappingRows, { product_connector: "", wib_connector: "", product_pin: "", wib_pin: "" }])} onImport={() => onImport("CONNECTOR_MAPPING")} onExport={() => onExport("CONNECTOR_MAPPING", mappingRows as unknown as Array<Record<string, unknown>>)} onPaste={() => onPaste("CONNECTOR_MAPPING")} extra={<button className="table-tool" onClick={onSuggest}>{chinese ? "建议同名映射" : "Suggest matching names"}</button>}>
      <table className="editable-table"><thead><tr><th>PRODUCT CONNECTOR</th><th>WIB CONNECTOR</th><th>PRODUCT PIN</th><th>WIB PIN</th><th /></tr></thead><tbody>{mappingRows.map((row, index) => <tr key={index}>{(["product_connector", "wib_connector", "product_pin", "wib_pin"] as const).map((field) => <td key={field}><input value={row[field]} onChange={(event) => onMappingRows(updateRow(mappingRows, index, { [field]: event.target.value }))} /></td>)}<td><DeleteButton label={chinese ? "删除映射" : "Delete mapping"} onClick={() => onMappingRows(mappingRows.filter((_, rowIndex) => rowIndex !== index))} /></td></tr>)}</tbody></table>
    </TableSection>
    <TableSection title={chinese ? "NET 别名" : "NET aliases"} count={aliases.length} onAdd={() => onAliases([...aliases, { product_net: "", wib_net: "" }])} onImport={() => onImport("NET_ALIAS")} onExport={() => onExport("NET_ALIAS", aliases as unknown as Array<Record<string, unknown>>)} onPaste={() => onPaste("NET_ALIAS")}>
      <table className="editable-table"><thead><tr><th>PRODUCT NET</th><th>WIB NET</th><th /></tr></thead><tbody>{aliases.map((row, index) => <tr key={index}><td><input value={row.product_net} onChange={(event) => onAliases(updateRow(aliases, index, { product_net: event.target.value }))} /></td><td><input value={row.wib_net} onChange={(event) => onAliases(updateRow(aliases, index, { wib_net: event.target.value }))} /></td><td><DeleteButton label={chinese ? "删除别名" : "Delete alias"} onClick={() => onAliases(aliases.filter((_, rowIndex) => rowIndex !== index))} /></td></tr>)}</tbody></table>
    </TableSection>
    <div className="mt-6 flex items-center justify-between border-t border-white/[0.065] pt-5"><label className="flex items-center gap-2 text-[11px] text-[#858681]"><input type="checkbox" checked={caseSensitive} onChange={(event) => onCaseSensitive(event.target.checked)} />{chinese ? "NET NAME 区分大小写" : "NET NAME is case-sensitive"}</label><button className="primary-button" disabled={!product || !wib || busy} onClick={onCompare}><ShieldCheckIcon size={15} />{chinese ? "运行接线比较" : "Run wiring comparison"}</button></div>
    <div className="mt-6 rounded-xl border border-white/[0.08] bg-[#141719] p-4"><div className="grid grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)] gap-3"><label><span className="form-label">{chinese ? "接口契约标题" : "Interface-contract title"}</span><input className="workbench-input" value={contractTitle} onChange={(event) => onContractTitle(event.target.value)} /></label><label><span className="form-label">{chinese ? "契约修订" : "Contract revision"}</span><input className="workbench-input" value={contractRevision} onChange={(event) => onContractRevision(event.target.value)} placeholder="REV A" /></label><label><span className="form-label">{chinese ? "恢复已批准契约" : "Resume approved contract"}</span><select className="workbench-input" value={contract?.id ?? ""} onChange={(event) => onLoadContract(event.target.value)}><option value="">{chinese ? "选择本地产物" : "Choose local artifact"}</option>{contractArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} · {artifact.subtitle}</option>)}</select></label></div><div className="mt-4 flex items-center justify-between"><p className="max-w-[80ch] text-[10px] leading-5 text-[#7f827e]">{chinese ? "正式契约要求完整逐引脚映射并绑定两份已确认原理图修订。它冻结连接意图，不会把当前比较自动批准。" : "Formal approval requires complete explicit pin mapping and confirmed revisions. It freezes intent and does not auto-approve the current comparison."}</p><button className="primary-button" disabled={!product || !wib || !mappingRows.length || !contractTitle.trim() || !contractRevision.trim() || busy} onClick={onApproveContract}><ShieldCheckIcon size={15} />{chinese ? "批准接口契约" : "Approve interface contract"}</button></div>{contract && <div className="mt-3 rounded-lg border border-[#779166]/25 bg-[#779166]/[0.055] px-3 py-2 font-mono text-[9px] text-[#a9c595]">APPROVED · {contract.id} · SHA-256 {contract.content_hash}</div>}</div>
    {wiring && <>
      <ResultStrip locale={locale} verdict={wiring.verdict} counts={[wiring.pass_count, wiring.fail_count, wiring.review_count]} reportPath={wiring.report_path} onOpen={() => onOpenAnalysis(wiring.id)} />
      {wiring.net_name_review?.length ? (
        <div className="mt-3 overflow-x-auto rounded-xl border border-white/[0.08]"><table className="workbench-table min-w-[900px]"><thead><tr><th>STATUS</th><th>NET NAME</th><th>PRODUCT LOCATIONS</th><th>WIB LOCATIONS</th><th>{chinese ? "说明" : "DETAILS"}</th></tr></thead><tbody>{wiring.net_name_review.map((row) => <tr key={`${row.status}:${row.net_name}`}><td><span className="status-chip status-review">{row.status}</span></td><td className="font-mono">{row.net_name}</td><td className="font-mono text-[9px]">{row.product_locations.join(", ") || "-"} ({row.product_count})</td><td className="font-mono text-[9px]">{row.wib_locations.join(", ") || "-"} ({row.wib_count})</td><td className="max-w-[360px] text-[9px] leading-4 text-[#888b87]">{row.message}</td></tr>)}</tbody></table></div>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-white/[0.08]"><table className="workbench-table min-w-[960px]"><thead><tr><th>STATUS</th><th>PRODUCT PATH</th><th>PRODUCT ENDPOINT</th><th>WIB PATH</th><th>WIB ENDPOINT</th><th>{chinese ? "诊断" : "DIAGNOSTIC"}</th></tr></thead><tbody>{wiring.connections.map((connection) => <tr key={connection.id} className={connection.verdict.toLowerCase()}><td><span className={`status-chip status-${connection.verdict.toLowerCase()}`}>{connection.verdict}</span></td><td>{connection.product_path_id ? <button className="font-mono text-[9px] text-[#c5a063] underline-offset-2 hover:underline" onClick={() => onOpenPath("PRODUCT", connection.product_path_id!)}>{connection.product_connector}.{connection.product_pin}</button> : `${connection.product_connector}.${connection.product_pin}`}</td><td className="font-mono text-[9px]">{connection.product_endpoint_refs?.join(", ") || "-"}</td><td>{connection.wib_path_id ? <button className="font-mono text-[9px] text-[#c5a063] underline-offset-2 hover:underline" onClick={() => onOpenPath("WIB", connection.wib_path_id!)}>{connection.wib_connector}.{connection.wib_pin}</button> : `${connection.wib_connector}.${connection.wib_pin}`}</td><td className="font-mono text-[9px]">{connection.wib_endpoint_refs?.join(", ") || "-"}</td><td className="max-w-[360px] text-[9px] leading-4 text-[#888b87]">{connection.message}</td></tr>)}</tbody></table></div>
      )}
    </>}
  </section>;
}

function RecommendationStep({ locale, product, plan, planArtifacts, rulePackArtifacts, factory, line, tester, variant, panel, rulePackId, busy, onFactory, onLine, onTester, onVariant, onPanel, onRulePackId, onGenerate, onLoad, onApprove, onOpenAnalysis }: {
  locale: Locale; product: SchematicDocument | null; plan: TestRecommendationAnalysis | null; planArtifacts: ArtifactCatalog["artifacts"]; rulePackArtifacts: ArtifactCatalog["artifacts"]; factory: string; line: string; tester: string; variant: string; panel: string; rulePackId: string; busy: boolean;
  onFactory(value: string): void; onLine(value: string): void; onTester(value: string): void; onVariant(value: string): void; onPanel(value: string): void; onRulePackId(value: string): void; onGenerate(): void; onLoad(id: string): void; onApprove(): void; onOpenAnalysis(id: string): void;
}) {
  const chinese = locale === "zh-CN";
  return <section><StepHeading eyebrow="DRAFT → APPROVED · DFT REQUIREMENT BASELINE" title={chinese ? "审查并冻结制造测试需求基线" : "Review and freeze the manufacturing-test requirement baseline"} description={chinese ? "计划包含需求—故障—方法矩阵、访问方式、刺激/观测和残余风险。APPROVED 只冻结必须覆盖什么；夹具与生产测试方案仍需后续验证。" : "The plan controls requirement-to-fault-to-method allocation, access, stimulus/observation, and residual risk. APPROVED freezes what must be covered; fixture and production release remain later gates."} />
    <div className="mt-6 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3"><SourceSummary label="PRODUCT" pinout={product} /><label><span className="form-label">{chinese ? "恢复已有测试计划" : "Resume test plan"}</span><select className="workbench-input" value={plan?.id ?? ""} onChange={(event) => onLoad(event.target.value)}><option value="">{chinese ? "选择本地产物" : "Choose local artifact"}</option>{planArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} · {artifact.status}</option>)}</select></label><button className="primary-button" disabled={!product || busy} onClick={onGenerate}><PlusIcon size={15} />{chinese ? "生成 DRAFT" : "Generate DRAFT"}</button></div>
    {plan ? <div className="mt-6"><div className="grid grid-cols-4 divide-x divide-white/[0.065] rounded-xl border border-white/[0.08]"><MetricBlock label={chinese ? "需求" : "REQUIREMENTS"} value={plan.requirements.length} /><MetricBlock label={chinese ? "测试方法" : "METHODS"} value={plan.method_matrix.length} /><MetricBlock label={chinese ? "WIB 建议" : "WIB GUIDANCE"} value={plan.wib_design_recommendations.length} /><div className="px-5 py-4"><div className="font-mono text-[9px] text-[#70736f]">LIFECYCLE</div><div className="mt-2"><span className={`status-chip status-${plan.lifecycle_status.toLowerCase()}`}>{plan.lifecycle_status}</span></div></div></div><div className="mt-4 flex justify-end gap-2"><button className="secondary-button" onClick={() => void window.circuitInspector.openEvidence(plan.report_path)}><FileHtmlIcon size={14} />{chinese ? "打开报告" : "Open report"}</button><button className="primary-button" onClick={() => onOpenAnalysis(plan.id)}>{chinese ? "审查矩阵" : "Review matrices"}<ArrowRightIcon size={14} /></button></div>
      <div className="mt-6 rounded-xl border border-white/[0.08] bg-[#141719] p-4"><div className="grid grid-cols-3 gap-3"><label><span className="form-label">{chinese ? "工厂" : "Factory"}</span><input className="workbench-input" value={factory} disabled={plan.lifecycle_status !== "DRAFT"} onChange={(event) => onFactory(event.target.value)} /></label><label><span className="form-label">{chinese ? "产线" : "Line"}</span><input className="workbench-input" value={line} disabled={plan.lifecycle_status !== "DRAFT"} onChange={(event) => onLine(event.target.value)} /></label><label><span className="form-label">{chinese ? "测试机" : "Tester"}</span><input className="workbench-input" value={tester} disabled={plan.lifecycle_status !== "DRAFT"} onChange={(event) => onTester(event.target.value)} /></label><label><span className="form-label">Variant</span><input className="workbench-input" value={variant} disabled={plan.lifecycle_status !== "DRAFT"} onChange={(event) => onVariant(event.target.value)} /></label><label><span className="form-label">Panel</span><input className="workbench-input" value={panel} disabled={plan.lifecycle_status !== "DRAFT"} onChange={(event) => onPanel(event.target.value)} /></label><label><span className="form-label">{chinese ? "批准规则包" : "Approved rule pack"}</span><select className="workbench-input" value={rulePackId} disabled={plan.lifecycle_status !== "DRAFT"} onChange={(event) => onRulePackId(event.target.value)}><option value="">{chinese ? "选择工厂/产线规则" : "Select factory/line rules"}</option>{rulePackArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title} · {artifact.subtitle}</option>)}</select></label></div><div className="mt-4 flex items-center justify-between"><p className="max-w-[80ch] text-[10px] leading-5 text-[#7f827e]">{plan.approval?.statement ?? (chinese ? "AI 可生成和审查候选，但权威批准必须由测试工程负责人记录。" : "AI may generate and review candidates; authoritative approval must be recorded by the responsible test engineer.")}</p>{plan.lifecycle_status === "DRAFT" && <button className="primary-button" disabled={!factory.trim() || !line.trim() || !tester.trim() || !rulePackId || busy} onClick={onApprove}><ShieldCheckIcon size={15} />{chinese ? "批准 DFT 基线" : "Approve DFT baseline"}</button>}</div>{plan.approval && <div className="mt-3 font-mono text-[8px] text-[#859a79]">SHA-256 {plan.approval.content_hash} · {plan.approval.approved_by}</div>}</div>
    </div> : <EmptyStep text={chinese ? "尚未生成计划。DRAFT 可用于 AI/人工审查；只有已确认产品修订和批准规则包才能进入 APPROVED。" : "No plan yet. DRAFT supports AI/human review; confirmed product revision and an approved rule pack are required for APPROVED."} />}
  </section>;
}

function ConstraintStep({ locale, rows, set, title, revision, artifacts, busy, onRows, onTitle, onRevision, onApprove, onLoad, onImport, onExport, onPaste }: {
  locale: Locale; rows: WibConstraintDefinition[]; set: WibConstraintSet | null; title: string; revision: string; artifacts: ArtifactCatalog["artifacts"]; busy: boolean;
  onRows(rows: WibConstraintDefinition[]): void; onTitle(value: string): void; onRevision(value: string): void; onApprove(): void; onLoad(id: string): void; onImport(): void; onExport(): void; onPaste(): void;
}) {
  const chinese = locale === "zh-CN";
  return <section><StepHeading eyebrow="APPROVED · HARD CONSTRAINTS" title={chinese ? "建立受控 WIB 约束集" : "Build a controlled WIB constraint set"} description={chinese ? "要求基准由负责工程团队定义并批准；实际选型、供应商/工厂能力、偏差和实站结果统一使用 MANUAL_FACTORY_CONFIRMATION，并保持 REVIEW。" : "Responsible engineering defines and approves the baseline. Actual selection, supplier/factory capability, deviations, and station results use MANUAL_FACTORY_CONFIRMATION and remain REVIEW."} />
    <div className="mt-6 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px] gap-3"><label><span className="form-label">{chinese ? "约束集标题" : "Constraint-set title"}</span><input className="workbench-input" value={title} onChange={(event) => onTitle(event.target.value)} /></label><label><span className="form-label">{chinese ? "恢复已批准约束集" : "Resume approved set"}</span><select className="workbench-input" value={set?.id ?? ""} onChange={(event) => onLoad(event.target.value)}><option value="">{chinese ? "选择本地产物" : "Choose local artifact"}</option>{artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}</select></label><label><span className="form-label">{chinese ? "修订" : "Revision"}</span><input className="workbench-input" value={revision} onChange={(event) => onRevision(event.target.value)} placeholder="REV A" /></label></div>
    <TableSection title={chinese ? "硬约束定义" : "Hard-constraint definitions"} count={rows.length} onAdd={() => onRows([...rows, blankConstraint(rows.length + 1)])} onImport={onImport} onExport={onExport} onPaste={onPaste}>
      <div className="overflow-x-auto"><table className="editable-table min-w-[1880px]"><thead><tr><th>ID</th><th>AREA</th><th>{chinese ? "要求" : "REQUIREMENT"}</th><th>CHECK</th><th>SCOPE CONNECTOR/PIN/NET</th><th>PATH POLICY / ENDPOINTS</th><th>METRIC ID</th><th>COMPARATOR</th><th>{chinese ? "必需值" : "REQUIRED"}</th><th>UNIT</th><th>VERIFICATION</th><th>{chinese ? "来源权威" : "SOURCE AUTHORITY"}</th><th /></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td><input value={row.id} onChange={(event) => onRows(updateRow(rows, index, { id: event.target.value }))} /></td><td><input value={row.area} onChange={(event) => onRows(updateRow(rows, index, { area: event.target.value }))} /></td><td><input value={row.requirement} onChange={(event) => onRows(updateRow(rows, index, { requirement: event.target.value }))} /></td><td><select value={row.check} onChange={(event) => onRows(updateRow(rows, index, { check: event.target.value as WibConstraintDefinition["check"] }))}>{["WIRING_ONE_TO_ONE", "NET_IDENTITY", "COMPLETE_PIN_COVERAGE", "NO_UNINTENDED_INTERCONNECT", "NC_ISOLATION", "DESIGN_METRIC", "ENDPOINT_UNIQUENESS", "NO_UNRESOLVED_BRANCH", "PATH_COMPONENT_POLICY", "ENDPOINT_PIN_MATCH"].map((value) => <option key={value}>{value}</option>)}</select></td><td><input value={[row.scope?.connector ?? "", row.scope?.pin ?? "", row.scope?.net_name ?? ""].join("/")} onChange={(event) => { const [connector, pin, net_name] = event.target.value.split("/"); onRows(updateRow(rows, index, { scope: { ...(connector ? { connector } : {}), ...(pin ? { pin } : {}), ...(net_name ? { net_name } : {}) } })); }} placeholder="P1/12/WIB_SCL" /></td><td><input value={row.check === "ENDPOINT_PIN_MATCH" ? (row.expected_endpoint_refs ?? []).join(",") : row.check === "PATH_COMPONENT_POLICY" ? [...(row.allowed_component_kinds ?? []), ...(row.forbidden_component_refs ?? []).map((item) => `!${item}`)].join(",") : ""} disabled={row.check !== "ENDPOINT_PIN_MATCH" && row.check !== "PATH_COMPONENT_POLICY"} onChange={(event) => { const values = event.target.value.split(",").map((item) => item.trim()).filter(Boolean); onRows(updateRow(rows, index, row.check === "ENDPOINT_PIN_MATCH" ? { expected_endpoint_refs: values } : { allowed_component_kinds: values.filter((item) => !item.startsWith("!")) as WibConstraintDefinition["allowed_component_kinds"], forbidden_component_refs: values.filter((item) => item.startsWith("!")).map((item) => item.slice(1)) })); }} placeholder={row.check === "ENDPOINT_PIN_MATCH" ? "U7.36" : "PASSIVE,!U99"} /></td><td><input value={row.metric_id ?? ""} onChange={(event) => onRows(updateRow(rows, index, { metric_id: event.target.value || null }))} /></td><td><select value={row.comparator} onChange={(event) => onRows(updateRow(rows, index, { comparator: event.target.value as WibConstraintDefinition["comparator"], required_value: event.target.value === "RANGE" ? { min: 0, max: 0 } : row.required_value }))}>{["EXACT", "ALL", "NONE", "MAXIMUM", "MINIMUM", "RANGE"].map((value) => <option key={value}>{value}</option>)}</select></td><td>{row.comparator === "RANGE" && typeof row.required_value === "object" ? <div className="grid grid-cols-2 gap-1"><input value={row.required_value.min} onChange={(event) => onRows(updateRow(rows, index, { required_value: { ...row.required_value as { min: number; max: number }, min: Number(event.target.value) } }))} /><input value={row.required_value.max} onChange={(event) => onRows(updateRow(rows, index, { required_value: { ...row.required_value as { min: number; max: number }, max: Number(event.target.value) } }))} /></div> : <input value={String(row.required_value)} onChange={(event) => onRows(updateRow(rows, index, { required_value: numericOrText(event.target.value) }))} />}</td><td><input value={row.unit ?? ""} onChange={(event) => onRows(updateRow(rows, index, { unit: event.target.value || null }))} /></td><td><select value={row.verification_mode} onChange={(event) => onRows(updateRow(rows, index, { verification_mode: event.target.value as WibConstraintDefinition["verification_mode"] }))}><option>DOCUMENT_BACKED</option><option>MANUAL_FACTORY_CONFIRMATION</option></select></td><td><input value={row.source_authority} onChange={(event) => onRows(updateRow(rows, index, { source_authority: event.target.value }))} /></td><td><DeleteButton label={chinese ? "删除约束" : "Delete constraint"} onClick={() => onRows(rows.filter((_, rowIndex) => rowIndex !== index))} /></td></tr>)}</tbody></table></div>
    </TableSection>
    {set && <div className="mt-4 rounded-xl border border-[#779166]/25 bg-[#779166]/[0.055] px-4 py-3"><div className="flex items-center gap-2 text-[11px] text-[#a9c595]"><CheckCircleIcon size={15} />APPROVED · {set.title} · {set.revision}</div><div className="mt-1 font-mono text-[8px] text-[#697366]">SHA-256 {set.content_hash}</div></div>}
    <div className="mt-6 flex justify-end"><button className="primary-button" disabled={!rows.length || !title.trim() || !revision.trim() || busy} onClick={onApprove}><ShieldCheckIcon size={15} />{chinese ? "审查并批准约束集" : "Review and approve constraint set"}</button></div>
  </section>;
}

function QualificationStep({ locale, product, wib, interfaceContract, testPlan, constraintSet, qualification, busy, onRun, onOpenAnalysis }: { locale: Locale; product: SchematicDocument | null; wib: SchematicDocument | null; interfaceContract: WibInterfaceContract | null; testPlan: TestRecommendationAnalysis | null; constraintSet: WibConstraintSet | null; qualification: WibQualificationAnalysis | null; busy: boolean; onRun(): void; onOpenAnalysis(id: string): void }) {
  const chinese = locale === "zh-CN";
  return <section><StepHeading eyebrow="STATIC PASS ≠ PRODUCTION RELEASE" title={chinese ? "执行受控 WIB 静态设计资格检查" : "Run controlled WIB static design qualification"} description={chinese ? "检查实际接线、端点路径、电气约束，以及每项 Approved DFT requirement 的刺激/观测/WIB 责任边界。静态 PASS 后，真实 WIB、线束、测试机、带电安全、节拍和试产仍保持 REVIEW。" : "Check actual wiring, endpoint paths, electrical constraints, and each approved DFT requirement's WIB responsibility. The real WIB, harness, tester, powered safety, throughput, and pilot remain REVIEW after static PASS."} />
    <div className="mt-6 divide-y divide-white/[0.065] border-y border-white/[0.065]"><QualificationInput label="PRODUCT SCHEMATIC" value={product?.id} status={product?.status} /><QualificationInput label="ACTUAL WIB SCHEMATIC" value={wib?.id} status={wib?.status} /><QualificationInput label="INTERFACE CONTRACT" value={interfaceContract?.id} status={interfaceContract?.status} /><QualificationInput label="DFT REQUIREMENT BASELINE" value={testPlan?.id} status={testPlan?.lifecycle_status} /><QualificationInput label="WIB CONSTRAINT SET" value={constraintSet?.id} status={constraintSet?.status} /></div>
    <div className="mt-6 flex justify-end"><button className="primary-button" disabled={!product || !wib || !interfaceContract || testPlan?.lifecycle_status !== "APPROVED" || !constraintSet || busy} onClick={onRun}><ShieldCheckIcon size={15} />{chinese ? "运行静态资格检查" : "Run static qualification"}</button></div>
    {qualification ? <><ResultStrip locale={locale} verdict={qualification.verdict} counts={[qualification.pass_count, qualification.fail_count, qualification.review_count]} reportPath={qualification.report_path} onOpen={() => onOpenAnalysis(qualification.id)} /><div className="mt-3 rounded-xl border border-[#c79d57]/25 bg-[#2a2519] px-4 py-3 text-[10px] text-[#b99c69]">{chinese ? `生产就绪：${qualification.production_readiness_verdict ?? "REVIEW"} · 必须关闭真实硬件、资源、安全、节拍与试产证据。` : `Production readiness: ${qualification.production_readiness_verdict ?? "REVIEW"} · real hardware, resources, safety, throughput, and pilot evidence must still close.`}</div></> : <EmptyStep text={chinese ? "确认两份原理图，并选择 Approved 接口契约、DFT 基线和 WIB 约束集后运行。" : "Confirm both schematics and select approved interface, DFT, and WIB constraint baselines."} />}
  </section>;
}

function TableSection({ title, count, children, onAdd, onImport, onExport, onPaste, extra }: { title: string; count: number; children: React.ReactNode; onAdd(): void; onImport(): void; onExport(): void; onPaste(): void; extra?: React.ReactNode }) {
  return <div className="mt-7"><div className="mb-2 flex items-center justify-between"><div className="flex items-baseline gap-2"><h3 className="text-[11px] font-semibold text-[#d2d0cb]">{title}</h3><span className="font-mono text-[9px] text-[#666966]">{count}</span></div><div className="flex gap-1">{extra}<button className="table-tool" onClick={onPaste}><ClipboardTextIcon size={13} />PASTE</button><button className="table-tool" onClick={onImport}><FileArrowUpIcon size={13} />IMPORT</button><button className="table-tool" onClick={onExport}><FileArrowDownIcon size={13} />EXPORT</button><button className="table-tool" onClick={onAdd}><PlusIcon size={13} />ROW</button></div></div><div className="overflow-x-auto rounded-xl border border-white/[0.08]">{children}</div></div>;
}

function StepHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="border-b border-white/[0.07] pb-6"><div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#a58655]">{eyebrow}</div><h1 className="mt-3 text-[23px] font-semibold tracking-[-0.035em] text-[#ebe9e4]">{title}</h1><p className="mt-2 max-w-[78ch] text-[11px] leading-5 text-[#7e807d]">{description}</p></div>;
}

function SourceSummary({ label, pinout }: { label: string; pinout: SchematicDocument | null }) {
  return <div className="rounded-xl border border-white/[0.08] bg-[#141719] px-4 py-3"><div className="flex items-center justify-between"><span className="font-mono text-[9px] text-[#9a8159]">{label}</span>{pinout && <span className={`status-chip status-${pinout.status.toLowerCase()}`}>{pinout.status}</span>}</div><div className="mt-2 truncate text-[11px] text-[#c8c6c1]">{pinout?.source_path ?? "-"}</div><div className="mt-1 font-mono text-[9px] text-[#686a67]">{pinout ? `${pinout.pins.length} PINS · ${pinout.revision ?? "NO REVISION"}` : "NO INPUT"}</div></div>;
}

function MetricBlock({ label, value }: { label: string; value: number }) {
  return <div className="px-5 py-4"><div className="font-mono text-[9px] text-[#70736f]">{label}</div><div className="mt-2 font-mono text-[25px] text-[#ddd9d1]">{value}</div></div>;
}

function ResultStrip({ locale, verdict, counts, reportPath, onOpen }: { locale: Locale; verdict: string; counts: [number, number, number]; reportPath: string; onOpen(): void }) {
  const chinese = locale === "zh-CN";
  return <div className="mt-7 rounded-xl border border-white/[0.08] bg-[#141719] p-5"><div className="flex items-center justify-between"><div><span className={`status-chip status-${verdict.toLowerCase().replaceAll("_", "-")}`}>{verdict}</span><div className="mt-3 flex gap-5 font-mono text-[10px] text-[#7d7f7c]"><span>PASS <b className="text-[#9bb487]">{counts[0]}</b></span><span>FAIL <b className="text-[#e18c78]">{counts[1]}</b></span><span>REVIEW <b className="text-[#d3ad6d]">{counts[2]}</b></span></div></div><div className="flex gap-2"><button className="secondary-button" onClick={() => void window.circuitInspector.openEvidence(reportPath)}><FileHtmlIcon size={14} />{chinese ? "打开报告" : "Open report"}</button><button className="primary-button" onClick={onOpen}>{chinese ? "查看结果" : "Review result"}<ArrowRightIcon size={14} /></button></div></div></div>;
}

function QualificationInput({ label, value, status }: { label: string; value: string | undefined; status: string | undefined }) {
  return <div className="grid grid-cols-[190px_minmax(0,1fr)_120px] items-center gap-4 px-3 py-4"><span className="font-mono text-[9px] text-[#777a76]">{label}</span><span className="truncate text-[11px] text-[#c8c6c1]">{value ?? "-"}</span><span className={`status-chip justify-self-end status-${(status ?? "review").toLowerCase()}`}>{status ?? "MISSING"}</span></div>;
}

function EmptyStep({ text }: { text: string }) {
  return <div className="mt-7 rounded-xl border border-dashed border-white/[0.1] px-5 py-12 text-center text-[11px] leading-5 text-[#737572]">{text}</div>;
}

function InlineError({ text }: { text: string }) {
  return <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl border border-[#b76755]/35 bg-[#35231f]/75 px-4 py-3 text-[11px] leading-5 text-[#efc1b6]"><WarningCircleIcon size={16} className="mt-0.5 shrink-0" />{text}</div>;
}

function DeleteButton({ label, onClick }: { label: string; onClick(): void }) {
  return <button className="grid size-7 place-items-center rounded-md text-[#6d706c] hover:bg-[#7d3d32]/15 hover:text-[#d78573]" aria-label={label} onClick={onClick}><TrashIcon size={13} /></button>;
}

function ConfirmDialog({ locale, confirmation, approver, busy, onApprover, onCancel, onConfirm }: { locale: Locale; confirmation: Confirmation; approver: string; busy: boolean; onApprover(value: string): void; onCancel(): void; onConfirm(): void }) {
  const chinese = locale === "zh-CN";
  return <div className="fixed inset-0 grid place-items-center bg-[#0d0f10]/82 p-6 backdrop-blur-md"><div role="dialog" aria-modal="true" className="popover-surface w-full max-w-[620px] rounded-2xl p-6"><div className="flex items-start justify-between gap-6"><div><h2 className="text-[16px] font-semibold">{confirmation.title}</h2><p className="mt-2 text-[11px] leading-5 text-[#858681]">{confirmation.body}</p></div><button className="rounded-lg p-1.5 text-[#777875] hover:bg-white/5" onClick={onCancel}><XIcon size={16} /></button></div><label className="mt-5 block"><span className="form-label">{chinese ? "确认人姓名或工号" : "Confirmer name or employee ID"}</span><input className="workbench-input" value={approver} onChange={(event) => onApprover(event.target.value)} /></label><div className="mt-6 flex justify-end gap-2"><button className="secondary-button" onClick={onCancel}>{chinese ? "取消" : "Cancel"}</button><button className="primary-button" disabled={!approver.trim() || busy} onClick={onConfirm}>{busy ? <CircleNotchIcon size={14} className="animate-spin" /> : <ShieldCheckIcon size={14} />}{chinese ? "确认并记录" : "Confirm and record"}</button></div></div></div>;
}

function PasteDialog({ locale, kind, value, errors, onChange, onCancel, onApply }: { locale: Locale; kind: TableKind; value: string; errors: string[]; onChange(value: string): void; onCancel(): void; onApply(): void }) {
  const chinese = locale === "zh-CN";
  return <div className="fixed inset-0 grid place-items-center bg-[#0d0f10]/82 p-6 backdrop-blur-md"><div role="dialog" aria-modal="true" className="popover-surface w-full max-w-[760px] rounded-2xl p-6"><div className="flex items-start justify-between"><div><h2 className="text-[16px] font-semibold">{chinese ? "批量粘贴表格" : "Paste table rows"} · {kind}</h2><p className="mt-2 text-[11px] text-[#858681]">{chinese ? "粘贴带表头的 CSV 或制表符分隔数据。只有整表校验通过后才会替换当前内容。" : "Paste CSV or tab-separated data with a header. Current content is replaced only after the entire table validates."}</p></div><button className="rounded-lg p-1.5 text-[#777875] hover:bg-white/5" onClick={onCancel}><XIcon size={16} /></button></div><textarea className="mt-5 h-72 w-full resize-none rounded-xl border border-white/[0.1] bg-[#101214] p-3 font-mono text-[10px] leading-5 text-[#d2d0cb] outline-none focus:border-[#c5a063]/45" value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />{errors.length > 0 && <div className="mt-3 text-[10px] text-[#dfa071]">{errors[0]}</div>}<div className="mt-5 flex justify-end gap-2"><button className="secondary-button" onClick={onCancel}>{chinese ? "取消" : "Cancel"}</button><button className="primary-button" disabled={!value.trim()} onClick={onApply}>{chinese ? "校验并应用" : "Validate and apply"}</button></div></div></div>;
}

function updateRow<T>(rows: T[], index: number, patch: Partial<T>): T[] {
  return rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row);
}

function validateMappingRows(rows: MappingRow[], aliases: AliasRow[], chinese: boolean): string[] {
  const errors: string[] = [];
  const mappings = new Set<string>();
  rows.forEach((row, index) => {
    if (!row.product_connector.trim() || !row.wib_connector.trim()) errors.push(chinese ? `第 ${index + 1} 行映射缺少产品或 WIB 连接器。` : `Mapping row ${index + 1} is missing a product or WIB connector.`);
    if (Boolean(row.product_pin.trim()) !== Boolean(row.wib_pin.trim())) errors.push(chinese ? `第 ${index + 1} 行必须同时填写产品与 WIB 引脚。` : `Mapping row ${index + 1} must provide both product and WIB pins.`);
    const key = `${row.product_connector}\u0000${row.wib_connector}\u0000${row.product_pin}\u0000${row.wib_pin}`.toLocaleUpperCase("en-US");
    if (mappings.has(key)) errors.push(chinese ? `第 ${index + 1} 行映射重复。` : `Duplicate mapping row ${index + 1}.`);
    else mappings.add(key);
  });
  const productNets = new Set<string>();
  const wibNets = new Set<string>();
  aliases.forEach((row, index) => {
    if (!row.product_net.trim() || !row.wib_net.trim()) errors.push(chinese ? `第 ${index + 1} 行 NET 别名不完整。` : `NET alias row ${index + 1} is incomplete.`);
    const productKey = row.product_net.toLocaleUpperCase("en-US");
    const wibKey = row.wib_net.toLocaleUpperCase("en-US");
    if (productNets.has(productKey) || wibNets.has(wibKey)) errors.push(chinese ? `第 ${index + 1} 行 NET 别名不是一对一。` : `NET alias row ${index + 1} is not one-to-one.`);
    productNets.add(productKey);
    wibNets.add(wibKey);
  });
  return errors;
}

function validateConstraintRows(rows: WibConstraintDefinition[], chinese: boolean): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!row.id.trim() || !row.area.trim() || !row.requirement.trim() || !row.source_authority.trim()) errors.push(chinese ? `第 ${index + 1} 条约束缺少 ID、领域、要求或来源权威。` : `Constraint ${index + 1} is missing ID, area, requirement, or source authority.`);
    if (row.check === "DESIGN_METRIC" && !row.metric_id?.trim()) errors.push(chinese ? `约束 ${row.id || index + 1} 的 DESIGN_METRIC 缺少 metric_id。` : `Constraint ${row.id || index + 1} requires metric_id for DESIGN_METRIC.`);
    if (row.check === "DESIGN_METRIC" && !row.unit?.trim()) errors.push(chinese ? `约束 ${row.id || index + 1} 的 DESIGN_METRIC 缺少单位。` : `Constraint ${row.id || index + 1} requires a unit for DESIGN_METRIC.`);
    if (row.check === "ENDPOINT_PIN_MATCH" && !row.expected_endpoint_refs?.length) errors.push(chinese ? `约束 ${row.id || index + 1} 缺少预期芯片端点。` : `Constraint ${row.id || index + 1} requires expected chip endpoints.`);
    if (row.check === "PATH_COMPONENT_POLICY" && !row.allowed_component_kinds?.length && !row.forbidden_component_refs?.length) errors.push(chinese ? `约束 ${row.id || index + 1} 缺少允许器件类型或禁止位号。` : `Constraint ${row.id || index + 1} requires allowed component kinds or forbidden references.`);
    if (row.comparator === "RANGE" && (typeof row.required_value !== "object" || !Number.isFinite(row.required_value.min) || !Number.isFinite(row.required_value.max) || row.required_value.min > row.required_value.max)) errors.push(chinese ? `约束 ${row.id || index + 1} 的范围无效。` : `Constraint ${row.id || index + 1} has an invalid range.`);
    const key = row.id.toLocaleUpperCase("en-US");
    if (seen.has(key)) errors.push(chinese ? `约束 ID ${row.id} 重复。` : `Duplicate constraint ID ${row.id}.`);
    else seen.set(key, index);
  });
  return errors;
}

function groupMappings(rows: MappingRow[]): ConnectorMapping[] {
  const grouped = new Map<string, ConnectorMapping>();
  for (const row of rows.filter((item) => item.product_connector.trim() && item.wib_connector.trim())) {
    const productConnector = row.product_connector.trim();
    const wibConnector = row.wib_connector.trim();
    const key = `${productConnector}\u0000${wibConnector}`;
    const current = grouped.get(key) ?? { product_connector: productConnector, wib_connector: wibConnector };
    if (row.product_pin.trim() && row.wib_pin.trim()) current.pin_map = [...(current.pin_map ?? []), { product_pin: row.product_pin.trim(), wib_pin: row.wib_pin.trim() }];
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function flattenMappings(mappings: ConnectorMapping[]): MappingRow[] {
  return mappings.flatMap((mapping) => mapping.pin_map?.length ? mapping.pin_map.map((pins) => ({ product_connector: mapping.product_connector, wib_connector: mapping.wib_connector, product_pin: pins.product_pin, wib_pin: pins.wib_pin })) : [{ product_connector: mapping.product_connector, wib_connector: mapping.wib_connector, product_pin: "", wib_pin: "" }]);
}

function suggestMappings(product: SchematicDocument | null, wib: SchematicDocument | null): MappingRow[] {
  if (!product || !wib) return [];
  const productConnectors = [...new Set(product.pins.map((pin) => pin.connector))];
  const wibConnectors = [...new Set(wib.pins.map((pin) => pin.connector))];
  const connectorPairs = productConnectors.flatMap((connector) => {
    const exact = wibConnectors.find((candidate) => candidate.toLocaleUpperCase("en-US") === connector.toLocaleUpperCase("en-US"));
    return exact ? [{ product: connector, wib: exact }] : [];
  });
  if (!connectorPairs.length && productConnectors.length === 1 && wibConnectors.length === 1) connectorPairs.push({ product: productConnectors[0]!, wib: wibConnectors[0]! });
  return connectorPairs.flatMap((pair) => product.pins
    .filter((pin) => pin.connector === pair.product)
    .flatMap((productPin) => {
      const wibPin = wib.pins.find((candidate) => candidate.connector === pair.wib && candidate.pin.toLocaleUpperCase("en-US") === productPin.pin.toLocaleUpperCase("en-US"));
      return wibPin ? [{ product_connector: pair.product, wib_connector: pair.wib, product_pin: productPin.pin, wib_pin: wibPin.pin }] : [];
    }));
}

function connectivityConstraints(plan: TestRecommendationAnalysis): WibConstraintDefinition[] {
  const checks: Record<string, WibConstraintDefinition["check"]> = {
    "WIB-CONNECTIVITY-001": "WIRING_ONE_TO_ONE",
    "WIB-CONNECTIVITY-002": "NET_IDENTITY",
    "WIB-CONNECTIVITY-003": "COMPLETE_PIN_COVERAGE",
    "WIB-CONNECTIVITY-004": "NO_UNINTENDED_INTERCONNECT",
    "WIB-CONNECTIVITY-005": "NC_ISOLATION"
  };
  return plan.wib_constraints.filter((candidate) => checks[candidate.id]).map((candidate) => ({
    id: candidate.id,
    area: candidate.area,
    requirement: candidate.requirement,
    check: checks[candidate.id]!,
    metric_id: null,
    comparator: candidate.comparator as WibConstraintDefinition["comparator"],
    required_value: candidate.required_value ?? (candidate.comparator === "NONE" ? 0 : "PASS"),
    unit: candidate.unit,
    verification_mode: "DOCUMENT_BACKED",
    source_authority: candidate.source_authority ?? "Confirmed product schematic interface and approved connector mapping"
  }));
}

function blankConstraint(sequence: number): WibConstraintDefinition {
  return { id: `WIB-CUSTOM-${String(sequence).padStart(3, "0")}`, area: "ELECTRICAL", requirement: "", check: "DESIGN_METRIC", metric_id: "", comparator: "MAXIMUM", required_value: 0, unit: null, verification_mode: "DOCUMENT_BACKED", source_authority: "" };
}

function numericOrText(value: string): string | number {
  return value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
