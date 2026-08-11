import {
  ArchiveBoxIcon,
  CircuitryIcon,
  HouseIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import brandMark from "../../assets/icon.svg";
import { DocumentAnalysisScreen } from "./DocumentAnalysisScreen";
import { LOCALE_STORAGE_KEY, resolveLocale, type Locale } from "./i18n";
import { PcbWorkspace } from "./PcbWorkspace";
import { ResultsLibrary } from "./ResultsLibrary";
import { RuleLibrary } from "./RuleLibrary";
import type { AnyAnalysis, ArtifactCatalog, ArtifactKind, DocumentAnalysis, WiringAnalysis } from "./types";
import { WorkbenchHome } from "./WorkbenchHome";
import { WibWorkspace } from "./WibWorkspace";

export type WorkspaceView = "HOME" | "PCB" | "RULES" | "WIB" | "RESULTS";

export function App() {
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY), window.navigator.language));
  const [view, setView] = useState<WorkspaceView>("HOME");
  const [catalog, setCatalog] = useState<ArtifactCatalog>({ artifacts: [], diagnostics: [] });
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [deepLinkUrl, setDeepLinkUrl] = useState<string | null>(null);
  const [initialDesignId, setInitialDesignId] = useState<string | null>(null);
  const [initialDraftId, setInitialDraftId] = useState<string | null>(null);
  const [documentAnalysis, setDocumentAnalysis] = useState<DocumentAnalysis | null>(null);
  const [wiringReview, setWiringReview] = useState<WiringAnalysis | null>(null);
  const [pcbSession, setPcbSession] = useState(0);

  const changeLocale = useCallback(() => setLocale((current) => current === "zh-CN" ? "en-US" : "zh-CN"), []);
  useEffect(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const refreshCatalog = useCallback(async () => {
    setCatalogBusy(true);
    try {
      setCatalog(await window.circuitInspector.listArtifacts());
      setCatalogError("");
    } catch (cause) {
      setCatalogError(message(cause));
    } finally {
      setCatalogBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const openAnalysis = useCallback(async (analysisId: string) => {
    try {
      const loaded = await window.circuitInspector.readAnalysis(analysisId) as AnyAnalysis;
      if ("kind" in loaded) {
        setDocumentAnalysis(loaded);
        setView("RESULTS");
        return;
      }
      setDocumentAnalysis(null);
      setInitialDesignId(loaded.design_id);
      setDeepLinkUrl(`circuitinspector://analysis/${encodeURIComponent(loaded.id)}`);
      setView("PCB");
    } catch (cause) {
      setCatalogError(message(cause));
    }
  }, []);

  const deleteArtifact = useCallback(async (kind: ArtifactKind, id: string) => {
    try {
      await window.circuitInspector.deleteArtifact(kind, id);
      if (kind === "ANALYSIS" && documentAnalysis?.id === id) setDocumentAnalysis(null);
      if (kind === "DESIGN" && initialDesignId === id) setInitialDesignId(null);
      if (kind === "DESIGN" || kind === "ANALYSIS") setPcbSession((current) => current + 1);
      await refreshCatalog();
    } catch (cause) {
      setCatalogError(message(cause));
    }
  }, [documentAnalysis?.id, initialDesignId, refreshCatalog]);

  useEffect(() => window.circuitInspector.onDeepLink((url) => {
    try {
      const parsed = new URL(url);
      const id = parsed.hostname === "analysis"
        ? parsed.pathname.split("/").filter(Boolean)[0]
        : parsed.pathname.split("/").filter(Boolean).at(-1);
      if (id) void openAnalysis(id);
    } catch (cause) {
      setCatalogError(message(cause));
    }
  }), [openAnalysis]);

  function navigate(next: WorkspaceView) {
    setWiringReview(null);
    if (next !== "RESULTS") setDocumentAnalysis(null);
    if (next !== "PCB") setDeepLinkUrl(null);
    if (next !== "WIB") setInitialDraftId(null);
    setView(next);
  }

  function reviewWiring(analysis: WiringAnalysis) {
    setInitialDraftId(null);
    setDocumentAnalysis(null);
    setWiringReview(analysis);
    setView("WIB");
  }

  const navItems = useMemo(() => [
    { id: "HOME" as const, icon: HouseIcon, zh: "任务首页", en: "Task home" },
    { id: "PCB" as const, icon: CircuitryIcon, zh: "PCB 分析", en: "PCB analysis" },
    { id: "RULES" as const, icon: ShieldCheckIcon, zh: "规则库", en: "Rule library" },
    { id: "WIB" as const, icon: PlugsConnectedIcon, zh: "WIB 工作流", en: "WIB workflow" },
    { id: "RESULTS" as const, icon: ArchiveBoxIcon, zh: "结果资料库", en: "Results" }
  ], []);

  return (
    <main className="app-shell grid h-[100dvh] min-w-[1080px] grid-cols-[64px_minmax(0,1fr)] overflow-hidden text-[#ecebe7]">
      <nav className={`title-drag flex min-h-0 flex-col items-center border-r border-white/[0.07] bg-[#151719] pb-3 ${window.circuitInspector.platform === "darwin" ? "pt-[52px]" : "pt-3"}`} aria-label={locale === "zh-CN" ? "工作区导航" : "Workspace navigation"}>
        <button className="title-no-drag brand-emblem mb-7 size-9" onClick={() => navigate("HOME")} aria-label="CircuitInspector">
          <img src={brandMark} alt="" aria-hidden="true" className="size-8" />
        </button>
        <div className="title-no-drag flex flex-1 flex-col gap-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className="workspace-nav-button"
                data-active={view === item.id}
                onClick={() => navigate(item.id)}
                title={locale === "zh-CN" ? item.zh : item.en}
                aria-label={locale === "zh-CN" ? item.zh : item.en}
              >
                <Icon size={19} weight={view === item.id ? "fill" : "regular"} />
              </button>
            );
          })}
        </div>
        <button className="title-no-drag workspace-nav-button font-mono text-[10px]" onClick={changeLocale} title={locale === "zh-CN" ? "Switch to English" : "切换到中文"}>
          {locale === "zh-CN" ? "EN" : "中"}
        </button>
      </nav>

      <section className="min-h-0 min-w-0 overflow-hidden">
        {view === "HOME" && (
          <WorkbenchHome
            locale={locale}
            catalog={catalog}
            busy={catalogBusy}
            error={catalogError}
            onNavigate={navigate}
            onOpenDesign={(id) => { setInitialDesignId(id); setView("PCB"); }}
            onOpenAnalysis={(id) => void openAnalysis(id)}
            onOpenDraft={(id) => { setInitialDraftId(id); setView("WIB"); }}
            onRefresh={() => void refreshCatalog()}
            onDelete={(kind, id) => void deleteArtifact(kind, id)}
          />
        )}
        <div className={view === "PCB" ? "h-full" : "hidden"}>
          <PcbWorkspace
            key={pcbSession}
            locale={locale}
            onLocaleChange={changeLocale}
            deepLinkUrl={deepLinkUrl}
            initialDesignId={initialDesignId}
            onCatalogChanged={() => void refreshCatalog()}
            onOpenRuleLibrary={() => navigate("RULES")}
            onReviewWiring={reviewWiring}
          />
        </div>
        {view === "RULES" && <RuleLibrary locale={locale} onCatalogChanged={() => void refreshCatalog()} />}
        {view === "WIB" && (
          <WibWorkspace
            locale={locale}
            catalog={catalog}
            initialDraftId={initialDraftId}
            initialWiringReview={wiringReview}
            onCatalogChanged={() => void refreshCatalog()}
            onOpenAnalysis={(id) => void openAnalysis(id)}
          />
        )}
        {view === "RESULTS" && (documentAnalysis ? (
          <DocumentAnalysisScreen
            analysis={documentAnalysis}
            locale={locale}
            onLocaleChange={changeLocale}
            onOpenDesign={() => navigate("PCB")}
            onBack={() => setDocumentAnalysis(null)}
            onReviewWiring={reviewWiring}
          />
        ) : (
          <ResultsLibrary locale={locale} catalog={catalog} busy={catalogBusy} onOpenAnalysis={(id) => void openAnalysis(id)} onRefresh={() => void refreshCatalog()} onDelete={(kind, id) => void deleteArtifact(kind, id)} />
        ))}
      </section>
    </main>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
