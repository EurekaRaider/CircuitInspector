export type Locale = "zh-CN" | "en-US";

const en = {
  localPcbReview: "LOCAL PCB REVIEW",
  searchPlaceholder: "Search NET NAME or reference designator",
  fitBoard: "Fit board",
  measure: "Measure",
  switchSide: "Switch board side",
  switchToEnglish: "Switch to English",
  switchToChinese: "切换到中文",
  openDesign: "Open design",
  designStructure: "Design structure",
  layers: "{count} LAYERS",
  noDesign: "NO DESIGN",
  emptySidebar: "Import ODB++, a Gerber ZIP/TGZ, or a manufacturing-data directory to inspect layers, board side, and semantic coverage.",
  components: "Components",
  nets: "Nets",
  testPoints: "Test points",
  drills: "Drills",
  pins: "Pins",
  semanticCoverage: "Semantic coverage",
  processing: "Processing",
  waitingForImport: "Waiting for import",
  processingLocalData: "Processing local data",
  validatingDesign: "Validating and parsing manufacturing data",
  designIndexed: "Design index ready",
  measured: "Measured",
  threshold: "Threshold",
  searchResults: "Search results",
  closeSearchResults: "Close search results",
  closeError: "Close error",
  rulesAndIssues: "Rules and issues",
  notRun: "NOT RUN",
  rulePack: "Rule pack",
  selectApprovedRulePack: "Select an approved rule pack",
  analyze: "Analyze",
  pendingConfirmation: "Pending human confirmation",
  noViolations: "No violations found",
  passReportGenerated: "A complete PASS report was generated, including every executed and non-applicable rule.",
  analysisPrompt: "Select an approved rule pack to run the analysis. The deterministic engine returns PASS, FAIL, REVIEW, and evidence coordinates.",
  approveRulePack: "Approve rule pack",
  approvalDescription: "An approved rule version is immutable and may produce formal PASS/FAIL results. Verify every threshold and source citation.",
  closeApproval: "Close approval dialog",
  approver: "Approver",
  approverPlaceholder: "Enter a name or employee ID",
  approvalRecord: "The approval record includes the approver, timestamp, and rule-content SHA-256.",
  cancel: "Cancel",
  confirmApproval: "Confirm approval",
  emptyTitle: "Inspect manufacturing data, not screenshots",
  emptyDescription: "Import ODB++ or a complete Gerber manufacturing package. Parsing, rule evaluation, and evidence rendering all run locally.",
  chooseDesign: "Choose design files",
  localOnly: "LOCAL ONLY · GPU WEBGL2",
  layer: "LAYER",
  net: "NET",
  reference: "REF",
  measurement: "MEASURE",
  zoom: "ZOOM"
} as const;

type TranslationKey = keyof typeof en;
type TranslationTable = Record<TranslationKey, string>;

const zh: TranslationTable = {
  localPcbReview: "本地 PCB 审查",
  searchPlaceholder: "搜索 NET NAME 或器件位号",
  fitBoard: "适配全板",
  measure: "测距",
  switchSide: "切换正反面视图",
  switchToEnglish: "Switch to English",
  switchToChinese: "切换到中文",
  openDesign: "打开设计",
  designStructure: "设计结构",
  layers: "{count} 层",
  noDesign: "无设计",
  emptySidebar: "导入 ODB++、Gerber ZIP/TGZ 或制造数据目录后，这里显示图层、面别及语义覆盖。",
  components: "器件",
  nets: "网络",
  testPoints: "测试点",
  drills: "钻孔",
  pins: "引脚",
  semanticCoverage: "语义覆盖",
  processing: "正在处理",
  waitingForImport: "等待导入",
  processingLocalData: "正在处理本地数据",
  validatingDesign: "正在校验并解析制造数据",
  designIndexed: "设计索引已就绪",
  measured: "实测",
  threshold: "阈值",
  searchResults: "搜索结果",
  closeSearchResults: "关闭搜索结果",
  closeError: "关闭错误",
  rulesAndIssues: "规则与问题",
  notRun: "未运行",
  rulePack: "规则包",
  selectApprovedRulePack: "选择已批准规则包",
  analyze: "分析",
  pendingConfirmation: "待人工确认",
  noViolations: "没有发现违规项",
  passReportGenerated: "完整 PASS 报告已生成，并记录所有已执行和不适用规则。",
  analysisPrompt: "选择已批准规则包执行分析。确定性引擎输出 PASS、FAIL、REVIEW 与证据坐标。",
  approveRulePack: "批准规则包",
  approvalDescription: "批准后规则版本不可变，并可产生正式 PASS/FAIL。请核对阈值和原文证据。",
  closeApproval: "关闭批准窗口",
  approver: "批准人",
  approverPlaceholder: "输入姓名或工号",
  approvalRecord: "批准记录包含批准人、时间和规则内容 SHA-256。",
  cancel: "取消",
  confirmApproval: "确认批准",
  emptyTitle: "检查真实制造数据，而不是截图",
  emptyDescription: "导入 ODB++ 或完整 Gerber 制造数据包。解析、规则计算和证据渲染全部在本机完成。",
  chooseDesign: "选择设计文件",
  localOnly: "仅本地 · GPU WEBGL2",
  layer: "图层",
  net: "网络",
  reference: "位号",
  measurement: "测距",
  zoom: "缩放"
};

const messages: Record<Locale, TranslationTable> = { "en-US": en, "zh-CN": zh };

export const LOCALE_STORAGE_KEY = "circuit-inspector.locale";

export function resolveLocale(savedLocale: string | null, browserLanguage: string): Locale {
  if (savedLocale === "zh-CN" || savedLocale === "en-US") return savedLocale;
  return browserLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function translate(locale: Locale, key: TranslationKey, variables: Record<string, string | number> = {}): string {
  return Object.entries(variables).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    messages[locale][key]
  );
}

export type Translator = (key: TranslationKey, variables?: Record<string, string | number>) => string;
