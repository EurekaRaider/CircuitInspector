import {
  ArrowsOutIcon,
  CheckSquareIcon,
  CircleNotchIcon,
  CursorClickIcon,
  MinusIcon,
  PathIcon,
  PlusIcon,
  ShieldCheckIcon,
  SquareIcon,
  TreeStructureIcon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { Locale } from "./i18n";
import type { SchematicDocument, SchematicPagePayload } from "./types";

type Correction = Parameters<typeof window.circuitInspector.correctSchematic>[0]["corrections"][number];
type OverlayKey = "components" | "pins" | "nets" | "ocr" | "anchor" | "path";
type CanvasMode = "PAN" | "ADD_WIRE" | "ADD_JUNCTION";

interface Props {
  locale: Locale;
  document: SchematicDocument;
  operator: string;
  focusPathId?: string | null;
  busy: boolean;
  onOperator(value: string): void;
  onTrace(candidateId: string): Promise<void>;
  onCorrect(corrections: Correction[], candidateId?: string): Promise<void>;
  onConfirm(candidateId: string, pathIds: string[]): void;
}

export function SchematicReview({ locale, document, operator, focusPathId, busy, onOperator, onTrace, onCorrect, onConfirm }: Props) {
  const chinese = locale === "zh-CN";
  const [pageNumber, setPageNumber] = useState(document.pages[0]?.number ?? 0);
  const [pagePayload, setPagePayload] = useState<SchematicPagePayload | null>(null);
  const [pageUrl, setPageUrl] = useState("");
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<number, string>>({});
  const [candidateId, setCandidateId] = useState(document.interface_candidates.find((item) => item.confirmed)?.id ?? document.interface_candidates[0]?.id ?? "");
  const [selectedPathId, setSelectedPathId] = useState(document.paths[0]?.id ?? "");
  const [confirmedPathIds, setConfirmedPathIds] = useState<string[]>(document.confirmed_scopes.flatMap((scope) => scope.path_ids));
  const [selectedComponentId, setSelectedComponentId] = useState(document.interface_candidates[0]?.component_id ?? document.components[0]?.id ?? "");
  const [selectedPinId, setSelectedPinId] = useState("");
  const [selectedWireId, setSelectedWireId] = useState("");
  const [selectedJunctionId, setSelectedJunctionId] = useState("");
  const [componentRefdes, setComponentRefdes] = useState("");
  const [componentKind, setComponentKind] = useState<SchematicDocument["components"][number]["kind"]>("UNKNOWN");
  const [pinNumber, setPinNumber] = useState("");
  const [pinNetId, setPinNetId] = useState("");
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [passthroughLeft, setPassthroughLeft] = useState("");
  const [passthroughRight, setPassthroughRight] = useState("");
  const [mode, setMode] = useState<CanvasMode>("PAN");
  const [wireStart, setWireStart] = useState<{ x: number; y: number } | null>(null);
  const [scaleLabel, setScaleLabel] = useState(100);
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({ components: true, pins: true, nets: true, ocr: false, anchor: true, path: true });
  const viewportRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef({ x: 20, y: 20, scale: 1 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const selectedPath = document.paths.find((item) => item.id === selectedPathId) ?? null;
  const selectedComponent = document.components.find((item) => item.id === selectedComponentId) ?? null;
  const selectedPin = document.graph_pins.find((item) => item.id === selectedPinId) ?? null;
  const candidate = document.interface_candidates.find((item) => item.id === candidateId) ?? null;
  const currentPathIds = useMemo(() => new Set(selectedPath?.node_ids ?? []), [selectedPath]);

  useEffect(() => {
    setPageNumber(document.pages[0]?.number ?? 0);
    setCandidateId(document.interface_candidates.find((item) => item.confirmed)?.id ?? document.interface_candidates[0]?.id ?? "");
  }, [document.id]);

  useEffect(() => {
    setConfirmedPathIds(document.confirmed_scopes.flatMap((scope) => scope.path_ids));
    if (!document.paths.some((item) => item.id === selectedPathId)) setSelectedPathId(document.paths[0]?.id ?? "");
  }, [document.confirmed_scopes, document.paths, selectedPathId]);

  useEffect(() => {
    if (focusPathId && document.paths.some((item) => item.id === focusPathId)) jumpToPath(focusPathId);
  }, [document.id, document.paths, focusPathId]);

  useEffect(() => {
    if (!selectedComponent) return;
    setComponentRefdes(selectedComponent.refdes);
    setComponentKind(selectedComponent.kind);
    setPassthroughLeft(selectedComponent.passthrough_pin_pairs[0]?.[0] ?? selectedComponent.pin_ids[0] ?? "");
    setPassthroughRight(selectedComponent.passthrough_pin_pairs[0]?.[1] ?? selectedComponent.pin_ids[1] ?? "");
  }, [selectedComponent]);

  useEffect(() => {
    if (!selectedPin) return;
    setPinNumber(selectedPin.number);
    setPinNetId(selectedPin.net_id ?? "");
  }, [selectedPin]);

  useEffect(() => {
    if (!pageNumber) {
      setPagePayload(null);
      setPageUrl("");
      return;
    }
    let disposed = false;
    let url = "";
    window.circuitInspector.getSchematicPage({ schematic_id: document.id, page: pageNumber }).then((payload) => {
      if (disposed) return;
      url = URL.createObjectURL(new Blob([payload.bytes], { type: "image/png" }));
      setPagePayload(payload);
      setPageUrl(url);
      requestAnimationFrame(() => fitPageTo(payload));
    }).catch(() => {
      if (!disposed) setPagePayload(null);
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [document.id, pageNumber]);

  useEffect(() => {
    let disposed = false;
    const created: string[] = [];
    setThumbnailUrls({});
    void (async () => {
      for (const page of document.pages) {
        if (disposed) break;
        const payload = await window.circuitInspector.getSchematicThumbnail({ schematic_id: document.id, page: page.number });
        if (disposed) break;
        const url = URL.createObjectURL(new Blob([payload.bytes], { type: "image/png" }));
        created.push(url);
        setThumbnailUrls((current) => ({ ...current, [payload.page]: url }));
      }
    })();
    return () => {
      disposed = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [document.id, document.pages]);

  function applyTransform(next = transformRef.current) {
    transformRef.current = next;
    if (sheetRef.current) sheetRef.current.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
    setScaleLabel(Math.round(next.scale * 100));
  }

  function fitPageTo(payload: SchematicPagePayload) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const scale = Math.min((viewport.clientWidth - 48) / payload.page.width, (viewport.clientHeight - 48) / payload.page.height);
    applyTransform({ x: (viewport.clientWidth - payload.page.width * scale) / 2, y: (viewport.clientHeight - payload.page.height * scale) / 2, scale: clamp(scale, 0.1, 6) });
  }

  function fitPage() {
    if (pagePayload) fitPageTo(pagePayload);
  }

  function fitWidth() {
    const viewport = viewportRef.current;
    if (!viewport || !pagePayload) return;
    const scale = clamp((viewport.clientWidth - 36) / pagePayload.page.width, 0.1, 6);
    applyTransform({ x: 18, y: 18, scale });
  }

  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const cursorX = (clientX ?? bounds.left + bounds.width / 2) - bounds.left;
    const cursorY = (clientY ?? bounds.top + bounds.height / 2) - bounds.top;
    const current = transformRef.current;
    const nextScale = clamp(current.scale * factor, 0.1, 6);
    applyTransform(zoomTransformAt(current, { x: cursorX, y: cursorY }, nextScale));
  }

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
  }

  function pagePoint(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = viewportRef.current!.getBoundingClientRect();
    const current = transformRef.current;
    return { x: (event.clientX - bounds.left - current.x) / current.scale, y: (event.clientY - bounds.top - current.y) / current.scale };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pagePayload) return;
    if (mode === "ADD_WIRE" || mode === "ADD_JUNCTION") {
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = pagePoint(event);
      if (mode === "ADD_JUNCTION") {
        const connected = pagePayload.wires.filter((wire) => pointToSegmentDistance(point.x, point.y, wire.x1, wire.y1, wire.x2, wire.y2) <= 9).map((wire) => wire.id);
        void onCorrect([{ operation: "ADD", entity_kind: "JUNCTION", entity_id: `junction-user-${Date.now().toString(36)}`, after: { page: pageNumber, x: point.x, y: point.y, connected_wire_ids: connected, evidence: userEvidence(document, pageNumber, point.x, point.y, "User junction") } }], candidateId || undefined);
        setMode("PAN");
        return;
      }
      if (!wireStart) {
        setWireStart(point);
      } else {
        void onCorrect([{ operation: "ADD", entity_kind: "WIRE", entity_id: `wire-user-${Date.now().toString(36)}`, after: { page: pageNumber, x1: wireStart.x, y1: wireStart.y, x2: point.x, y2: point.y, net_id: null, evidence: userEvidence(document, pageNumber, wireStart.x, wireStart.y, "User wire") } }], candidateId || undefined);
        setWireStart(null);
        setMode("PAN");
      }
      return;
    }
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: transformRef.current.x, originY: transformRef.current.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyTransform({ ...transformRef.current, x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function jumpToPath(pathId: string) {
    const pathResult = document.paths.find((item) => item.id === pathId);
    if (!pathResult) return;
    setSelectedPathId(pathId);
    const page = pathFocusPage(pathResult.endpoint_pin_ids, document.graph_pins, pathResult.evidence);
    if (page) setPageNumber(page);
  }

  async function saveComponent() {
    if (!selectedComponent || !operator.trim()) return;
    await onCorrect([{ operation: "UPDATE", entity_kind: "COMPONENT", entity_id: selectedComponent.id, after: { refdes: componentRefdes.trim(), kind: componentKind } }], candidateId || undefined);
  }

  async function savePin() {
    if (!selectedPin || !operator.trim()) return;
    await onCorrect([{ operation: "UPDATE", entity_kind: "PIN", entity_id: selectedPin.id, after: { number: pinNumber.trim(), net_id: pinNetId || null } }], candidateId || undefined);
  }

  async function splitSelectedPin() {
    if (!selectedPin || !operator.trim()) return;
    const netId = `net-user-${Date.now().toString(36)}`;
    await onCorrect([
      { operation: "ADD", entity_kind: "NET", entity_id: netId, after: { name: `${document.nets.find((item) => item.id === selectedPin.net_id)?.name ?? "NET"}_SPLIT`, pin_ids: [], wire_ids: [], label_ids: [], page_numbers: selectedPin.page ? [selectedPin.page] : [], confidence: 1, evidence: selectedPin.evidence } },
      { operation: "UPDATE", entity_kind: "PIN", entity_id: selectedPin.id, after: { net_id: netId } }
    ], candidateId || undefined);
  }

  const pageEvidenceBoxes = selectedPath?.evidence.filter((item) => item.page === pageNumber && item.bbox) ?? [];

  return <div className="mt-5 overflow-hidden rounded-xl border border-white/[0.08] bg-[#111416]">
    <div className="flex min-h-[36rem] max-h-[72vh]">
      <aside className="w-[132px] shrink-0 overflow-y-auto border-r border-white/[0.07] bg-[#15181a] p-2" aria-label={chinese ? "原理图页面" : "Schematic pages"}>
        <div className="px-1 pb-2 font-mono text-[8px] uppercase tracking-[0.12em] text-[#6f726e]">{chinese ? "页面" : "Pages"}</div>
        {document.pages.map((page) => <button key={page.number} className={`mb-2 block w-full rounded-lg border p-1 text-left ${pageNumber === page.number ? "border-[#c5a063]/55 bg-[#c5a063]/[0.08]" : "border-white/[0.07] bg-[#101214]"}`} onClick={() => setPageNumber(page.number)}>
          <div className="aspect-[3/4] overflow-hidden rounded bg-white">{thumbnailUrls[page.number] ? <img className="size-full object-contain" src={thumbnailUrls[page.number]} alt="" /> : <div className="grid size-full place-items-center"><CircleNotchIcon className="animate-spin text-[#555]" /></div>}</div>
          <div className="mt-1 flex justify-between px-0.5 font-mono text-[8px] text-[#898b87]"><span>{page.number}</span><span>{page.extraction === "OCR" ? "OCR" : "PDF"}</span></div>
        </button>)}
        {!document.pages.length && <div className="rounded-lg border border-dashed border-white/[0.09] px-2 py-8 text-center text-[9px] leading-4 text-[#6d706c]">{chinese ? "结构化映射没有 PDF 页面" : "Structured mapping has no PDF pages"}</div>}
      </aside>

      <main className="grid min-w-0 flex-1 grid-rows-[44px_minmax(0,1fr)]">
        <div className="flex items-center gap-1 border-b border-white/[0.07] bg-[#171a1c] px-2">
          <button className="icon-button !size-8" aria-label={chinese ? "缩小" : "Zoom out"} onClick={() => zoomAt(0.82)}><MinusIcon size={13} /></button>
          <button className="icon-button !size-8" aria-label={chinese ? "放大" : "Zoom in"} onClick={() => zoomAt(1.22)}><PlusIcon size={13} /></button>
          <span className="w-12 text-center font-mono text-[9px] text-[#a3a49f]">{scaleLabel}%</span>
          <button className="secondary-button !h-8 !px-2 text-[9px]" onClick={fitPage}><ArrowsOutIcon size={13} />{chinese ? "适合页面" : "Fit page"}</button>
          <button className="secondary-button !h-8 !px-2 text-[9px]" onClick={fitWidth}>{chinese ? "适合宽度" : "Fit width"}</button>
          <div className="mx-2 h-4 w-px bg-white/[0.08]" />
          <button className="secondary-button !h-8 !px-2 text-[9px]" data-active={mode === "PAN"} onClick={() => { setMode("PAN"); setWireStart(null); }}><CursorClickIcon size={13} />{chinese ? "拖拽" : "Pan"}</button>
          <button className="secondary-button !h-8 !px-2 text-[9px]" data-active={mode === "ADD_WIRE"} disabled={!operator.trim()} onClick={() => { setMode("ADD_WIRE"); setWireStart(null); }}><PathIcon size={13} />{wireStart ? (chinese ? "选择终点" : "Choose end") : (chinese ? "增添导线" : "Add wire")}</button>
          <button className="secondary-button !h-8 !px-2 text-[9px]" data-active={mode === "ADD_JUNCTION"} disabled={!operator.trim()} onClick={() => setMode("ADD_JUNCTION")}><PlusIcon size={13} />{chinese ? "连接点" : "Junction"}</button>
          <div className="ml-auto flex gap-1">{(Object.keys(overlays) as OverlayKey[]).map((key) => <button key={key} className={`rounded px-1.5 py-1 font-mono text-[8px] uppercase ${overlays[key] ? "bg-[#c5a063]/15 text-[#d0ad73]" : "text-[#626562]"}`} onClick={() => setOverlays((current) => ({ ...current, [key]: !current[key] }))}>{key}</button>)}</div>
        </div>
        <div ref={viewportRef} className={`relative min-h-0 touch-none overflow-hidden bg-[#0d1011] ${mode === "PAN" ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          {pagePayload && pageUrl ? <div ref={sheetRef} className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ width: pagePayload.page.width, height: pagePayload.page.height }}>
            <img className="absolute inset-0 size-full select-none bg-white" draggable={false} src={pageUrl} alt={`${document.role} schematic page ${pageNumber}`} />
            <svg className="absolute inset-0 size-full" viewBox={`0 0 ${pagePayload.page.width} ${pagePayload.page.height}`} aria-label={chinese ? "原理图证据覆盖层" : "Schematic evidence overlays"}>
              {overlays.nets && pagePayload.wires.map((wire) => <line key={wire.id} x1={wire.x1} y1={wire.y1} x2={wire.x2} y2={wire.y2} stroke={selectedWireId === wire.id ? "#ef835f" : "#3aa6a0"} strokeWidth={selectedWireId === wire.id ? 5 : 2} opacity={0.75} onPointerDown={(event) => { event.stopPropagation(); setSelectedWireId(wire.id); }} />)}
              {overlays.components && pagePayload.components.flatMap((component) => component.bbox ? [<rect key={component.id} x={component.bbox.x} y={component.bbox.y} width={component.bbox.width} height={component.bbox.height} fill={selectedComponentId === component.id ? "rgba(197,160,99,.15)" : "transparent"} stroke="#c5a063" strokeWidth={selectedComponentId === component.id ? 4 : 2} onPointerDown={(event) => { event.stopPropagation(); setSelectedComponentId(component.id); }} />] : [])}
              {overlays.pins && pagePayload.pins.flatMap((pin) => pin.x != null && pin.y != null ? [<circle key={pin.id} cx={pin.x} cy={pin.y} r={selectedPinId === pin.id ? 8 : 5} fill={currentPathIds.has(pin.id) ? "#ee765c" : "#62a6d5"} onPointerDown={(event) => { event.stopPropagation(); setSelectedPinId(pin.id); }} />] : [])}
              {overlays.anchor && candidate && document.components.filter((component) => component.id === candidate.component_id && component.page === pageNumber && component.bbox).map((component) => <rect key={`anchor-${component.id}`} x={component.bbox!.x - 7} y={component.bbox!.y - 7} width={component.bbox!.width + 14} height={component.bbox!.height + 14} fill="none" stroke="#e6be74" strokeWidth={5} strokeDasharray="12 7" />)}
              {overlays.path && pageEvidenceBoxes.map((evidence, index) => <rect key={`${evidence.excerpt}-${index}`} x={evidence.bbox!.x} y={evidence.bbox!.y} width={evidence.bbox!.width} height={evidence.bbox!.height} fill="rgba(238,118,92,.16)" stroke="#ee765c" strokeWidth={3} />)}
              {overlays.ocr && [...pagePayload.components.flatMap((item) => item.evidence), ...pagePayload.pins.flatMap((item) => item.evidence)].filter((item) => item.method === "OCR" && item.page === pageNumber && item.bbox).map((item, index) => <rect key={`ocr-${index}`} x={item.bbox!.x} y={item.bbox!.y} width={item.bbox!.width} height={item.bbox!.height} fill="rgba(88,182,214,.12)" stroke="#58b6d6" strokeWidth={2} />)}
              {wireStart && <circle cx={wireStart.x} cy={wireStart.y} r={8} fill="#ef835f" />}
            </svg>
          </div> : <div className="absolute inset-0 grid place-items-center text-[10px] text-[#696c68]">{document.pages.length ? <CircleNotchIcon size={20} className="animate-spin" /> : (chinese ? "结构化映射通过右侧路径面板确认" : "Confirm structured mappings in the path panel")}</div>}
        </div>
      </main>

      <aside className="w-[330px] shrink-0 overflow-y-auto border-l border-white/[0.07] bg-[#15181a] p-3">
        <label className="block"><span className="form-label">{chinese ? "操作人（用于校正审计）" : "Operator for correction audit"}</span><input className="workbench-input" value={operator} onChange={(event) => onOperator(event.target.value)} placeholder={chinese ? "姓名或工号" : "Name or employee ID"} /></label>
        {document.diagnostics.length > 0 && <div className="mt-3 space-y-1">{document.diagnostics.slice(0, 5).map((item, index) => <div key={`${item.code}-${index}`} className="rounded-lg border border-[#9b7a45]/25 bg-[#2b2519]/70 px-2 py-1.5 text-[8px] leading-4 text-[#c9a96f]"><b>{item.code}</b> · {item.message}</div>)}</div>}
        <section className="mt-4 border-t border-white/[0.07] pt-3"><div className="flex items-center gap-2 text-[10px] font-semibold text-[#d1cfc9]"><TreeStructureIcon size={14} />{chinese ? "接口候选" : "Interface candidates"}</div>
          <div className="mt-2 space-y-1">{document.interface_candidates.map((item) => { const component = document.components.find((value) => value.id === item.component_id); return <button key={item.id} className={`w-full rounded-lg border px-2.5 py-2 text-left ${candidateId === item.id ? "border-[#c5a063]/45 bg-[#c5a063]/[0.07]" : "border-white/[0.06]"}`} onClick={() => { setCandidateId(item.id); setSelectedComponentId(item.component_id); }}><div className="flex justify-between text-[10px]"><b>{component?.refdes ?? item.component_id}</b><span className="font-mono text-[#9a8159]">{item.score}</span></div><div className="mt-1 text-[8px] leading-4 text-[#737672]">{item.reasons.join(" · ")}</div></button>; })}</div>
          <button className="primary-button mt-2 w-full" disabled={!candidateId || busy} onClick={() => void onTrace(candidateId)}>{busy ? <CircleNotchIcon className="animate-spin" /> : <PathIcon size={14} />}{chinese ? "确认锚点并追踪" : "Select anchor and trace"}</button>
        </section>

        <section className="mt-4 border-t border-white/[0.07] pt-3"><div className="flex items-center justify-between"><span className="text-[10px] font-semibold">{chinese ? "接口路径" : "Interface paths"}</span><span className="font-mono text-[8px] text-[#6f726f]">{document.paths.length}</span></div>
          <div className="mt-2 space-y-1">{document.paths.map((item) => <div key={item.id} className={`rounded-lg border p-2 ${selectedPathId === item.id ? "border-[#c5a063]/38 bg-[#c5a063]/[0.055]" : "border-white/[0.06]"}`}><button className="w-full text-left" onClick={() => jumpToPath(item.id)}><div className="flex items-center justify-between"><span className={`status-chip status-${item.status.toLowerCase()}`}>{item.status}</span><span className="font-mono text-[8px] text-[#777a76]">{Math.round(item.confidence * 100)}%</span></div><div className="mt-2 break-words font-mono text-[8px] leading-4 text-[#bbb9b3]">{pathBreadcrumb(document, item.id)}</div>{item.diagnostics[0] && <div className="mt-1 text-[8px] leading-4 text-[#b18c5b]">{item.diagnostics[0].message}</div>}</button><button className="mt-2 flex items-center gap-1 text-[8px] text-[#8d908c]" onClick={() => setConfirmedPathIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}>{confirmedPathIds.includes(item.id) ? <CheckSquareIcon size={13} weight="fill" /> : <SquareIcon size={13} />}{chinese ? "纳入确认范围" : "Include in confirmation"}</button></div>)}</div>
          <button className="primary-button mt-2 w-full" disabled={!candidateId || !confirmedPathIds.length || busy} onClick={() => onConfirm(candidateId, confirmedPathIds)}><ShieldCheckIcon size={14} />{chinese ? "确认所选路径" : "Confirm selected paths"}</button>
        </section>

        <section className="mt-4 border-t border-white/[0.07] pt-3"><div className="text-[10px] font-semibold">{chinese ? "图形校正" : "Graph corrections"}</div>
          <label className="mt-2 block"><span className="form-label">{chinese ? "元件" : "Component"}</span><select className="workbench-input" value={selectedComponentId} onChange={(event) => setSelectedComponentId(event.target.value)}>{document.components.map((item) => <option key={item.id} value={item.id}>{item.refdes} · {item.kind}</option>)}</select></label>
          {selectedComponent && <div className="mt-2 grid grid-cols-[1fr_118px] gap-1"><input className="workbench-input" value={componentRefdes} onChange={(event) => setComponentRefdes(event.target.value)} /><select className="workbench-input" value={componentKind} onChange={(event) => setComponentKind(event.target.value as typeof componentKind)}>{["CONNECTOR", "IC", "PASSIVE", "PROTECTION", "POWER", "UNKNOWN"].map((kind) => <option key={kind}>{kind}</option>)}</select><button className="secondary-button col-span-2" disabled={!operator.trim()} onClick={() => void saveComponent()}>{chinese ? "保存位号/类型" : "Save ref/type"}</button></div>}
          <label className="mt-2 block"><span className="form-label">PIN / NET</span><select className="workbench-input" value={selectedPinId} onChange={(event) => setSelectedPinId(event.target.value)}><option value="">-</option>{document.graph_pins.map((pin) => <option key={pin.id} value={pin.id}>{document.components.find((item) => item.id === pin.component_id)?.refdes}.{pin.number}</option>)}</select></label>
          {selectedPin && <div className="mt-2 grid grid-cols-[90px_1fr] gap-1"><input className="workbench-input" value={pinNumber} onChange={(event) => setPinNumber(event.target.value)} /><select className="workbench-input" value={pinNetId} onChange={(event) => setPinNetId(event.target.value)}><option value="">NC / unresolved</option>{document.nets.map((net) => <option key={net.id} value={net.id}>{net.name ?? net.id}</option>)}</select><button className="secondary-button" disabled={!operator.trim()} onClick={() => void savePin()}>{chinese ? "保存引脚" : "Save pin"}</button><button className="secondary-button" disabled={!operator.trim()} onClick={() => void splitSelectedPin()}>{chinese ? "拆分为新网络" : "Split to new net"}</button></div>}
          <div className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-1"><select className="workbench-input" value={mergeSourceId} onChange={(event) => setMergeSourceId(event.target.value)}><option value="">{chinese ? "源网络" : "Source net"}</option>{document.nets.map((net) => <option key={net.id} value={net.id}>{net.name ?? net.id}</option>)}</select><select className="workbench-input" value={pinNetId} onChange={(event) => setPinNetId(event.target.value)}><option value="">{chinese ? "目标网络" : "Target net"}</option>{document.nets.map((net) => <option key={net.id} value={net.id}>{net.name ?? net.id}</option>)}</select><button className="secondary-button !px-2" disabled={!operator.trim() || !mergeSourceId || !pinNetId || mergeSourceId === pinNetId} onClick={() => void onCorrect([{ operation: "MERGE_NETS", entity_kind: "NET", entity_id: pinNetId, after: { source_ids: [pinNetId, mergeSourceId] } }], candidateId || undefined)}>{chinese ? "合并" : "Merge"}</button></div>
          {selectedComponent && selectedComponent.pin_ids.length >= 2 && <div className="mt-2 grid grid-cols-2 gap-1"><select className="workbench-input" value={passthroughLeft} onChange={(event) => setPassthroughLeft(event.target.value)}>{selectedComponent.pin_ids.map((id) => <option key={id} value={id}>{document.graph_pins.find((pin) => pin.id === id)?.number ?? id}</option>)}</select><select className="workbench-input" value={passthroughRight} onChange={(event) => setPassthroughRight(event.target.value)}>{selectedComponent.pin_ids.map((id) => <option key={id} value={id}>{document.graph_pins.find((pin) => pin.id === id)?.number ?? id}</option>)}</select><button className="secondary-button col-span-2" disabled={!operator.trim() || !passthroughLeft || !passthroughRight || passthroughLeft === passthroughRight} onClick={() => void onCorrect([{ operation: "SET_PASSTHROUGH", entity_kind: "COMPONENT", entity_id: selectedComponent.id, after: { pin_pairs: [[passthroughLeft, passthroughRight]] } }], candidateId || undefined)}>{chinese ? "设置允许穿越引脚对" : "Set allowed passthrough pair"}</button></div>}
          <div className="mt-2 grid grid-cols-2 gap-1"><select className="workbench-input" value={selectedWireId} onChange={(event) => setSelectedWireId(event.target.value)}><option value="">{chinese ? "导线" : "Wire"}</option>{document.wires.map((wire) => <option key={wire.id} value={wire.id}>{wire.id}</option>)}</select><button className="secondary-button" disabled={!operator.trim() || !selectedWireId} onClick={() => void onCorrect([{ operation: "DELETE", entity_kind: "WIRE", entity_id: selectedWireId }], candidateId || undefined)}>{chinese ? "删除导线" : "Delete wire"}</button><select className="workbench-input" value={selectedJunctionId} onChange={(event) => setSelectedJunctionId(event.target.value)}><option value="">{chinese ? "连接点" : "Junction"}</option>{document.junctions.map((junction) => <option key={junction.id} value={junction.id}>{junction.id}</option>)}</select><button className="secondary-button" disabled={!operator.trim() || !selectedJunctionId} onClick={() => void onCorrect([{ operation: "DELETE", entity_kind: "JUNCTION", entity_id: selectedJunctionId }], candidateId || undefined)}>{chinese ? "取消连接点" : "Remove junction"}</button></div>
        </section>
        <section className="mt-4 border-t border-white/[0.07] pt-3"><div className="font-mono text-[8px] text-[#70736f]">AUDIT · {document.corrections.length} CORRECTION(S)</div>{document.corrections.slice(-3).reverse().map((item) => <div key={item.id} className="mt-2 text-[8px] leading-4 text-[#777a76]">{item.corrected_by} · {item.operation} {item.entity_kind}<div className="truncate font-mono text-[#5f625f]">{item.content_hash}</div></div>)}</section>
      </aside>
    </div>
  </div>;
}

function pathBreadcrumb(document: SchematicDocument, pathId: string) {
  const pathResult = document.paths.find((item) => item.id === pathId);
  if (!pathResult) return pathId;
  const pinById = new Map(document.graph_pins.map((pin) => [pin.id, pin]));
  const componentById = new Map(document.components.map((component) => [component.id, component]));
  const anchorPin = pinById.get(pathResult.anchor_pin_id);
  const anchor = anchorPin ? componentById.get(anchorPin.component_id) : undefined;
  const nodes = anchor && anchorPin ? [`${anchor.refdes}.${anchorPin.number}`] : [];
  for (const componentId of pathResult.component_ids) {
    const component = componentById.get(componentId);
    if (!component || component.id === anchor?.id || component.kind === "IC") continue;
    const pins = component.pin_ids.map((id) => pinById.get(id)?.number).filter(Boolean).join("/");
    nodes.push(`${component.refdes}${pins ? `.${pins}` : ""}`);
  }
  for (const endpointId of pathResult.endpoint_pin_ids) {
    const pin = pinById.get(endpointId);
    const component = pin ? componentById.get(pin.component_id) : undefined;
    if (pin && component) nodes.push(`${component.refdes}.${pin.number}`);
  }
  return nodes.join(" → ") || pathId;
}

function userEvidence(document: SchematicDocument, page: number, x: number, y: number, excerpt: string) {
  return { source_path: document.source_path, source_hash: document.source_hash, page, bbox: { x: x - 4, y: y - 4, width: 8, height: 8 }, excerpt, method: "USER", confidence: 1 };
}

function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const amount = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (x1 + amount * dx), py - (y1 + amount * dy));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function zoomTransformAt(current: { x: number; y: number; scale: number }, cursor: { x: number; y: number }, nextScale: number) {
  const worldX = (cursor.x - current.x) / current.scale;
  const worldY = (cursor.y - current.y) / current.scale;
  return { x: cursor.x - worldX * nextScale, y: cursor.y - worldY * nextScale, scale: nextScale };
}

export function firstPathPage(evidence: Array<{ page: number | null }>) {
  return evidence.find((item) => item.page != null)?.page ?? null;
}

export function pathFocusPage(
  endpointPinIds: string[],
  pins: Array<{ id: string; page: number | null }>,
  evidence: Array<{ page: number | null }>
) {
  for (const endpointId of endpointPinIds) {
    const page = pins.find((pin) => pin.id === endpointId)?.page;
    if (page != null) return page;
  }
  return firstPathPage(evidence);
}
