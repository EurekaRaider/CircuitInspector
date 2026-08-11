import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import type { RuleDocumentDiagnostic, RuleDocumentValidation } from "@circuit-inspector/contracts";
export type { RuleDocumentDiagnostic, RuleDocumentValidation } from "@circuit-inspector/contracts";

const EXTRACTOR_VERSION = "0.4.0";
const RULE_SOURCE_SCHEMA = "CIRCUITINSPECTOR_RULE_SOURCE_V1" as const;

export interface RuleCitation {
  source_path: string;
  source_hash: string;
  page: number | null;
  paragraph: number | null;
  excerpt: string;
}

export interface ExtractedRule {
  id: string;
  title: string;
  kind: "MINIMUM_DISTANCE" | "MINIMUM_WIDTH" | "MINIMUM_ANNULAR_RING" | "MINIMUM_DIAMETER";
  source: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL" | "TOOLING_HOLE" | "PANEL_TAB" | "BGA_CSP" | "SHIELD_FENCE" | "UV_GLUE";
  target: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL" | "TOOLING_HOLE" | "PANEL_TAB" | "BGA_CSP" | "SHIELD_FENCE" | "UV_GLUE" | null;
  metric: "CENTER_TO_CENTER" | "EDGE_TO_EDGE" | "BODY_TO_PAD" | null;
  threshold_nm: number;
  severity: "INFO" | "WARNING" | "ERROR" | null;
  layer_functions: string[];
  same_net_only: boolean;
  different_net_only: boolean;
  citation: RuleCitation;
}

export interface RuleReviewItem {
  id: string;
  code: "RELATIVE_THRESHOLD" | "AMBIGUOUS_THRESHOLD" | "NON_EXECUTABLE_GUIDANCE" | "UNSUPPORTED_TARGET";
  message: string;
  acknowledged: boolean;
  resolution: null;
  citation: RuleCitation;
}

interface Passage {
  sourcePath: string;
  sourceHash: string;
  page: number | null;
  paragraph: number;
  text: string;
}

interface LoadedRuleDocument {
  sourcePath: string;
  sourceHash: string;
  passages: Passage[];
  markdownText: string | null;
}

export interface DraftRulePack {
  id: string;
  version: string;
  title: string;
  status: "DRAFT";
  rules: ExtractedRule[];
  review_items: RuleReviewItem[];
  approval: null;
}

export interface RulePackExtractionResult {
  rulePack: DraftRulePack | null;
  passageCount: number;
  ruleCount: number;
  ragIndexPath: string;
  validation: RuleDocumentValidation;
}

export async function extractRulePack(paths: string[], cacheDir: string, title?: string) {
  const result = await extractRulePackWithValidation(paths, cacheDir, title);
  if (!result.rulePack) {
    throw new Error(formatValidationFailure(result.validation));
  }
  return { ...result, rulePack: result.rulePack };
}

export async function extractRulePackWithValidation(paths: string[], cacheDir: string, title?: string): Promise<RulePackExtractionResult> {
  const documents = await Promise.all(paths.map(readRuleDocument));
  const passages = documents.flatMap((document) => document.passages);
  const inferred = passages.map((passage, index) => inferPassage(passage, index));
  const rules = inferred.flatMap((result) => result.rules);
  const reviewItems = inferred.flatMap((result) => result.reviewItems);
  const validationResults = documents
    .filter((document): document is LoadedRuleDocument & { markdownText: string } => document.markdownText !== null)
    .map((document) => validateRuleSourceMarkdown(document));
  const diagnostics = validationResults.flatMap((result) => result.diagnostics);
  diagnostics.push(...reviewItems.map(reviewItemDiagnostic));
  if (rules.length === 0) {
    diagnostics.push(createDiagnostic({
      code: "NO_EXECUTABLE_RULES",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: documents[0]?.sourcePath ?? paths[0] ?? "",
      message: "No executable geometry rule was recognized in the supplied documents.",
      suggestion: "Add at least one Section 2 rule with a supported object, measurement, comparator, one positive threshold, and unit, or resolve the reported rule-card issues.",
      messageZh: "提供的文档中没有识别到可执行的几何规则。",
      suggestionZh: "在第 2 节至少添加一条包含受支持对象、测量方式、比较关系、唯一正阈值和单位的规则，或先修复下面列出的规则卡问题。"
    }));
  }
  const validation = summarizeValidation(validationSchema(validationResults), diagnostics);
  const hash = createHash("sha256")
    .update(EXTRACTOR_VERSION)
    .update(JSON.stringify(passages.map(({ sourceHash, page, paragraph, text }) => ({ sourceHash, page, paragraph, text }))))
    .digest("hex");
  const id = `rules-${hash.slice(0, 12)}`;
  const ragDirectory = path.join(cacheDir, "rules", "rag");
  await mkdir(ragDirectory, { recursive: true });
  const ragIndexPath = path.join(ragDirectory, `${id}.json`);
  await writeFile(ragIndexPath, JSON.stringify({ id, passages, validation }, null, 2), "utf8");
  const rulePack: DraftRulePack | null = validation.generation_blocker_count > 0 ? null : {
    id,
    version: `${EXTRACTOR_VERSION}-draft`,
    title: title?.trim() || `Extracted rules ${hash.slice(0, 8)}`,
    status: "DRAFT",
    rules,
    review_items: reviewItems,
    approval: null
  };
  return {
    rulePack,
    passageCount: passages.length,
    ruleCount: rules.length,
    ragIndexPath,
    validation
  };
}

async function readRuleDocument(sourcePath: string): Promise<LoadedRuleDocument> {
  const absolute = path.resolve(sourcePath);
  const bytes = await readFile(absolute);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const extension = path.extname(absolute).toLowerCase();
  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    const text = bytes.toString("utf8");
    return { sourcePath: absolute, sourceHash, passages: splitPassages(text, absolute, sourceHash, null), markdownText: extension === ".txt" ? null : text };
  }
  if (extension === ".docx") {
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    return { sourcePath: absolute, sourceHash, passages: splitPassages(extracted.value, absolute, sourceHash, null), markdownText: null };
  }
  if (extension === ".pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false }).promise;
    const passages: Passage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      passages.push(...splitPassages(text, absolute, sourceHash, pageNumber));
    }
    if (passages.every((passage) => passage.text.trim().length === 0)) {
      throw new Error(`${absolute} contains no extractable PDF text; OCR is intentionally not enabled in V1.`);
    }
    return { sourcePath: absolute, sourceHash, passages, markdownText: null };
  }
  throw new Error(`Unsupported rule document: ${absolute}. Use PDF, DOCX, Markdown, or text.`);
}

function splitPassages(text: string, sourcePath: string, sourceHash: string, page: number | null): Passage[] {
  return text
    .split(/\n\s*\n|(?<=[。！？.!?])\s+/u)
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((value, index) => ({ sourcePath, sourceHash, page, paragraph: index + 1, text: value }));
}

function inferPassage(passage: Passage, sequence: number): { rules: ExtractedRule[]; reviewItems: RuleReviewItem[] } {
  const value = passage.text;
  const normalized = value.toLowerCase();
  const thresholds = extractThresholds(value);
  if (thresholds.length === 0) return { rules: [], reviewItems: [] };
  const citation: RuleCitation = {
    source_path: passage.sourcePath,
    source_hash: passage.sourceHash,
    page: passage.page,
    paragraph: passage.paragraph,
    excerpt: value.slice(0, 500)
  };
  const suffix = `${passage.sourceHash.slice(0, 8)}-${sequence + 1}`;
  const reviewItem = (code: RuleReviewItem["code"], message: string): { rules: ExtractedRule[]; reviewItems: RuleReviewItem[] } => ({
    rules: [],
    reviewItems: [{ id: `review-${code.toLowerCase().replaceAll("_", "-")}-${suffix}`, code, message, acknowledged: false, resolution: null, citation }]
  });
  if (/测试点|test\s*point/i.test(value) && /(?:\d+\s*\/\s*\d+|half|一半|二分之一)\s*(?:d\b|diameter|直径)?/i.test(value)) {
    return reviewItem("RELATIVE_THRESHOLD", "The relative formula is retained as a valid baseline candidate, but D, the measured entities, and its applicability must be confirmed before execution.");
  }
  const supportedSubject = /环宽|annular\s+ring|线宽|导线宽|trace\s+width|minimum\s+width|测试点|test\s*point/i.test(value)
    || ((/铜|copper/i.test(value) && /板边|board\s+edge/i.test(value)))
    || ((/孔|drill|hole/i.test(value) && /铜|copper/i.test(value)));
  if (!supportedSubject) return { rules: [], reviewItems: [] };
  const uniqueThresholds = [...new Set(thresholds)];
  if (/环宽|annular\s+ring/i.test(value)) {
    if (uniqueThresholds.length !== 1) return reviewItem("AMBIGUOUS_THRESHOLD", "The passage contains multiple distinct annular-ring values and does not select one requirement.");
    const threshold = uniqueThresholds[0]!;
    return executable(baseRule(`annular-ring-${suffix}`, "最小环宽", "MINIMUM_ANNULAR_RING", "DRILL", "COPPER", null, threshold, citation));
  }
  if (/线宽|导线宽|trace\s+width|minimum\s+width/i.test(value)) {
    if (uniqueThresholds.length !== 1) return reviewItem("AMBIGUOUS_THRESHOLD", "The passage contains multiple distinct trace-width values and does not select one requirement.");
    const threshold = uniqueThresholds[0]!;
    return executable(baseRule(`trace-width-${suffix}`, "最小导线宽度", "MINIMUM_WIDTH", "COPPER", null, null, threshold, citation));
  }
  if (/测试点|test\s*point/i.test(value)) {
    const diameterThresholds = [...new Set(extractDiameterThresholds(value))];
    if (diameterThresholds.length > 1) {
      return reviewItem("AMBIGUOUS_THRESHOLD", "The passage gives multiple alternative test-point diameters and requires the applicable product or use condition to be selected.");
    }
    if (diameterThresholds.length === 1 && /直径|diameter/i.test(value)) {
      return executable(baseRule(`tp-diameter-${suffix}`, "测试点最小直径", "MINIMUM_DIAMETER", "TEST_POINT", null, null, diameterThresholds[0]!, citation));
    }
    if (!hasDistanceRequirement(normalized)) {
      return reviewItem("NON_EXECUTABLE_GUIDANCE", "The passage mentions test-point dimensions or equipment guidance but does not state an executable clearance requirement.");
    }
    if (uniqueThresholds.length !== 1) {
      return reviewItem("AMBIGUOUS_THRESHOLD", "The passage states a clearance requirement but contains multiple distinct candidate limits without selecting one.");
    }
    const threshold = uniqueThresholds[0]!;
    if (/工装孔|定位孔|tooling\s+hole/i.test(value)) {
      return executable(baseRule(`tp-tooling-hole-${suffix}`, "测试点到工装孔距离", "MINIMUM_DISTANCE", "TEST_POINT", "TOOLING_HOLE", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/板边|board\s+edge/i.test(value)) {
      return executable(baseRule(`tp-board-edge-${suffix}`, "测试点到板边距离", "MINIMUM_DISTANCE", "TEST_POINT", "BOARD_EDGE", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/panel\s*tab|breaking\s*tab|工艺边连接筋|邮票孔连接边/i.test(value)) {
      return executable(baseRule(`tp-panel-tab-${suffix}`, "测试点到断板边距离", "MINIMUM_DISTANCE", "TEST_POINT", "PANEL_TAB", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/\bBGA\b|\bCSP\b|芯片外形|chip\s+outline/i.test(value)) {
      return executable(baseRule(`tp-bga-csp-${suffix}`, "测试点到 BGA/CSP 外形距离", "MINIMUM_DISTANCE", "TEST_POINT", "BGA_CSP", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/shield(?:ing)?\s*(?:fence|cover)|屏蔽(?:罩|框|围栏)/i.test(value)) {
      return executable(baseRule(`tp-shield-fence-${suffix}`, "测试点到屏蔽结构距离", "MINIMUM_DISTANCE", "TEST_POINT", "SHIELD_FENCE", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/UV\s*glue|dispens(?:e|ing)|点胶|UV\s*胶/i.test(value)) {
      return executable(baseRule(`tp-uv-glue-${suffix}`, "测试点到 UV 胶边缘距离", "MINIMUM_DISTANCE", "TEST_POINT", "UV_GLUE", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/器件|component/i.test(value)) {
      return executable(baseRule(`tp-component-${suffix}`, "测试点到器件距离", "MINIMUM_DISTANCE", "TEST_POINT", "COMPONENT", "BODY_TO_PAD", threshold, citation));
    }
    if (/测试点中心间距|test point center-to-center spacing/i.test(value)) {
      return executable(baseRule(`tp-spacing-${suffix}`, "测试点间距", "MINIMUM_DISTANCE", "TEST_POINT", "TEST_POINT", "CENTER_TO_CENTER", threshold, citation));
    }
    if (/测试点(?:边缘)?间距|test\s*point\s+(?:edge[- ]to[- ]edge\s+)?spacing|between\s+test\s*points|test\s*point[^.]{0,80}test\s*point/i.test(value)) {
      return executable(baseRule(`tp-spacing-${suffix}`, "测试点间距", "MINIMUM_DISTANCE", "TEST_POINT", "TEST_POINT", metricFromText(normalized), threshold, citation));
    }
    return reviewItem("NON_EXECUTABLE_GUIDANCE", "The passage does not identify a supported target for the test-point measurement.");
  }
  if (/铜|copper/i.test(value) && /板边|board\s+edge/i.test(value)) {
    if (uniqueThresholds.length !== 1) return reviewItem("AMBIGUOUS_THRESHOLD", "The passage contains multiple distinct copper-clearance values and does not select one requirement.");
    const threshold = uniqueThresholds[0]!;
    return executable(baseRule(`copper-edge-${suffix}`, "铜到板边距离", "MINIMUM_DISTANCE", "COPPER", "BOARD_EDGE", "EDGE_TO_EDGE", threshold, citation));
  }
  if (/孔|drill|hole/i.test(value) && /铜|copper/i.test(value)) {
    if (uniqueThresholds.length !== 1) return reviewItem("AMBIGUOUS_THRESHOLD", "The passage contains multiple distinct drill-clearance values and does not select one requirement.");
    const threshold = uniqueThresholds[0]!;
    return executable(baseRule(`drill-copper-${suffix}`, "孔到铜距离", "MINIMUM_DISTANCE", "DRILL", "COPPER", "EDGE_TO_EDGE", threshold, citation));
  }
  return { rules: [], reviewItems: [] };
}

function executable(rule: ExtractedRule): { rules: ExtractedRule[]; reviewItems: RuleReviewItem[] } {
  return { rules: [rule], reviewItems: [] };
}

function hasDistanceRequirement(text: string): boolean {
  const distance = /间距|距离|间隙|避让|clearance|distance|spacing|gap|keep[- ]?out|edge\s+to\s+(?:the\s+)?(?:board|tooling|component|test|panel|breaking|BGA|CSP|shield|UV)/i.test(text);
  const requirement = /不得|不低于|不小于|至少|最小|要求|必须|应保持|at\s+least|minimum|require(?:d|s)?|must|shall|make\s+sure|keep\s+at\s+least|>=|≥|keep[- ]?out/i.test(text);
  return distance && requirement;
}

function extractThresholds(text: string): number[] {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|mil|mils|um|μm|微米|inches|inch|in\b)/giu)];
  return matches.flatMap((match) => {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return [];
    const unit = match[2]?.toLowerCase();
    if (unit === "mil" || unit === "mils") return [Math.round(amount * 25_400)];
    if (unit === "um" || unit === "μm" || unit === "微米") return [Math.round(amount * 1_000)];
    if (unit === "in" || unit === "inch" || unit === "inches") return [Math.round(amount * 25_400_000)];
    return [Math.round(amount * 1_000_000)];
  });
}

function extractDiameterThresholds(text: string): number[] {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|mil|mils|um|μm|微米|inches|inch|in\b)\s*(?:diameter|直径)/giu)];
  return matches.flatMap((match) => lengthToNm(match[1], match[2]));
}

function lengthToNm(amountText: string | undefined, unitText: string | undefined): number[] {
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return [];
  const unit = unitText?.toLowerCase();
  if (unit === "mil" || unit === "mils") return [Math.round(amount * 25_400)];
  if (unit === "um" || unit === "μm" || unit === "微米") return [Math.round(amount * 1_000)];
  if (unit === "in" || unit === "inch" || unit === "inches") return [Math.round(amount * 25_400_000)];
  return [Math.round(amount * 1_000_000)];
}

function metricFromText(text: string): "CENTER_TO_CENTER" | "EDGE_TO_EDGE" {
  return /中心(?:到中心|间距|距)|center\s*(?:-|to|2)\s*center|between\s+(?:the\s+)?(?:test\s+point\s+)?cent(?:er|re)s/i.test(text)
    ? "CENTER_TO_CENTER"
    : "EDGE_TO_EDGE";
}

function baseRule(
  id: string,
  title: string,
  kind: ExtractedRule["kind"],
  source: ExtractedRule["source"],
  target: ExtractedRule["target"],
  metric: ExtractedRule["metric"],
  threshold_nm: number,
  citation: RuleCitation
): ExtractedRule {
  return {
    id,
    title,
    kind,
    source,
    target,
    metric,
    threshold_nm,
    severity: null,
    layer_functions: source === "COPPER" ? ["COPPER"] : [],
    same_net_only: false,
    different_net_only: false,
    citation
  };
}

interface TemplateValidationResult {
  schema: typeof RULE_SOURCE_SCHEMA | "LEGACY";
  diagnostics: RuleDocumentDiagnostic[];
}

interface DiagnosticInput {
  code: string;
  severity: RuleDocumentDiagnostic["severity"];
  blocksGeneration: boolean;
  blocksApproval: boolean;
  sourcePath: string;
  page?: number | null;
  line?: number | null;
  paragraph?: number | null;
  section?: string | null;
  ruleId?: string | null;
  field?: string | null;
  excerpt?: string | null;
  message: string;
  suggestion: string;
  messageZh: string;
  suggestionZh: string;
}

interface MarkdownField {
  value: string;
  line: number;
}

const REQUIRED_SECTIONS = [
  "## 1. 受控来源",
  "## 2. 自动几何候选规则",
  "## 3. 待人工复核候选",
  "## 4. 不进入自动规则包的要求和不安全候选",
  "## 5. 转换完整性与冲突清单",
  "## 6. 生成后自检"
] as const;

const REQUIRED_DOCUMENT_FIELDS = [
  "rule_source_schema",
  "source_pdf",
  "source_sha256",
  "document_id",
  "document_revision",
  "document_title",
  "effective_date",
  "project",
  "product_revisions",
  "factory",
  "tester_or_fixture",
  "authority_tier",
  "conversion_model",
  "conversion_time",
  "conversion_status"
] as const;

const REQUIRED_RULE_FIELDS = [
  "verification_mode",
  "kind",
  "source",
  "target",
  "metric",
  "layer_functions",
  "net_relation",
  "applicability",
  "source_severity",
  "source_fidelity",
  "review_note"
] as const;

function validateRuleSourceMarkdown(document: LoadedRuleDocument & { markdownText: string }): TemplateValidationResult {
  const text = document.markdownText;
  const lines = text.split(/\r?\n/u);
  const diagnostics: RuleDocumentDiagnostic[] = [];
  const documentFields = markdownFields(lines, 0, lines.length);
  const looksLikeTemplate = documentFields.has("rule_source_schema")
    || documentFields.has("conversion_status")
    || REQUIRED_SECTIONS.some((section) => lines.some((line) => line.trim() === section));
  if (!looksLikeTemplate) {
    diagnostics.push(createDiagnostic({
      code: "TEMPLATE_SCHEMA_MISSING",
      severity: "WARNING",
      blocksGeneration: false,
      blocksApproval: false,
      sourcePath: document.sourcePath,
      line: 1,
      field: "rule_source_schema",
      excerpt: lines[0]?.trim() || null,
      message: "This Markdown uses the legacy free-form rule format, so template structure and field-level locations cannot be fully validated.",
      suggestion: `Regenerate the document with rule_source_schema ${RULE_SOURCE_SCHEMA} and the PDF-to-rule-source template. Legacy extraction will continue for compatibility.`,
      messageZh: "此 Markdown 使用旧版自由文本规则格式，CircuitInspector 无法完整校验模板结构和字段位置。",
      suggestionZh: `请使用 PDF 转规则源模板重新生成，并填写 rule_source_schema ${RULE_SOURCE_SCHEMA}。为兼容旧文档，本次仍会继续抽取。`
    }));
    return { schema: "LEGACY", diagnostics };
  }

  const schemaField = documentFields.get("rule_source_schema");
  if (!schemaField || unquote(schemaField.value) !== RULE_SOURCE_SCHEMA) {
    diagnostics.push(createDiagnostic({
      code: "TEMPLATE_SCHEMA_INVALID",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: schemaField?.line ?? 1,
      field: "rule_source_schema",
      excerpt: schemaField?.value ?? null,
      message: `The rule source schema is missing or is not ${RULE_SOURCE_SCHEMA}.`,
      suggestion: `Add \`- \`rule_source_schema\`: \`${RULE_SOURCE_SCHEMA}\`\` under Section 1 and regenerate from the official template.`,
      messageZh: `规则源 schema 缺失，或不是 ${RULE_SOURCE_SCHEMA}。`,
      suggestionZh: `请在第 1 节添加 \`- \`rule_source_schema\`: \`${RULE_SOURCE_SCHEMA}\`\`，并使用正式模板重新生成。`
    }));
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!lines.some((line) => line.trim() === section)) {
      diagnostics.push(createDiagnostic({
        code: "TEMPLATE_SECTION_MISSING",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: 1,
        section,
        message: `Required template section is missing: ${section}.`,
        suggestion: `Restore the exact heading \`${section}\` and place its content in the order defined by the official template.`,
        messageZh: `缺少必需的模板章节：${section}。`,
        suggestionZh: `请恢复标题 \`${section}\`，并按照正式模板规定的顺序填写内容。`
      }));
    }
  }

  for (const field of REQUIRED_DOCUMENT_FIELDS) {
    if (!documentFields.has(field)) {
      diagnostics.push(missingFieldDiagnostic(document.sourcePath, 1, "受控来源", null, field));
    }
  }

  const placeholderLines = new Set<number>();
  for (const match of text.matchAll(/<[^>\n]+>/gu)) {
    placeholderLines.add(lineAt(text, match.index ?? 0));
  }
  for (const line of placeholderLines) {
    diagnostics.push(createDiagnostic({
      code: "TEMPLATE_PLACEHOLDER_REMAINS",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line,
      excerpt: lines[line - 1]?.trim() ?? null,
      message: "An unfilled angle-bracket placeholder remains in the generated Markdown.",
      suggestion: "Replace the placeholder with PDF-backed content or the explicit value UNKNOWN where the template permits it; otherwise remove the unused card.",
      messageZh: "生成的 Markdown 中仍有未填写的尖括号占位内容。",
      suggestionZh: "请用 PDF 中有依据的内容替换；模板允许缺省时填写 UNKNOWN；未使用的规则卡应整段删除。"
    }));
  }

  const commentIndex = text.indexOf("<!--");
  if (commentIndex >= 0) {
    diagnostics.push(createDiagnostic({
      code: "TEMPLATE_INSTRUCTIONS_REMAIN",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: lineAt(text, commentIndex),
      excerpt: "<!--",
      message: "Template instruction comments remain in the generated rule source.",
      suggestion: "Remove all template comments after generation; keep only populated rule-source content.",
      messageZh: "生成后的规则源中仍保留模板说明注释。",
      suggestionZh: "生成完成后删除所有模板注释，只保留已填写的规则源内容。"
    }));
  }

  if (text.trimStart().startsWith("```")) {
    diagnostics.push(createDiagnostic({
      code: "DOCUMENT_WRAPPED_IN_CODE_FENCE",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: 1,
      excerpt: lines[0]?.trim() ?? null,
      message: "The entire Markdown document is wrapped in a code fence.",
      suggestion: "Remove the outer code fence and save the Markdown content directly as the file body.",
      messageZh: "整个 Markdown 文档被包在代码围栏中。",
      suggestionZh: "请删除最外层代码围栏，直接把 Markdown 内容保存为文件正文。"
    }));
  }

  validateDocumentMetadata(document, lines, documentFields, diagnostics);
  validateAutomaticRuleCards(document, lines, diagnostics);
  validateReviewSections(document, lines, diagnostics);
  return { schema: RULE_SOURCE_SCHEMA, diagnostics };
}

function validateDocumentMetadata(
  document: LoadedRuleDocument,
  lines: string[],
  fields: Map<string, MarkdownField>,
  diagnostics: RuleDocumentDiagnostic[]
) {
  const sourcePdf = fields.get("source_pdf");
  if (sourcePdf && isUnknown(unquote(sourcePdf.value))) {
    diagnostics.push(createDiagnostic({
      code: "SOURCE_PDF_REQUIRED",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: sourcePdf.line,
      field: "source_pdf",
      excerpt: lines[sourcePdf.line - 1]?.trim() ?? null,
      message: "source_pdf must identify the PDF used by the model.",
      suggestion: "Fill source_pdf with the exact controlled PDF filename; do not use UNKNOWN for this field.",
      messageZh: "source_pdf 必须标明大模型实际读取的 PDF。",
      suggestionZh: "请填写受控 PDF 的准确文件名；此字段不能使用 UNKNOWN。"
    }));
  }
  const status = fields.get("conversion_status");
  if (status && unquote(status.value) !== "DRAFT_SOURCE") {
    diagnostics.push(createDiagnostic({
      code: "CONVERSION_STATUS_INVALID",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: status.line,
      field: "conversion_status",
      excerpt: lines[status.line - 1]?.trim() ?? null,
      message: "conversion_status must remain DRAFT_SOURCE.",
      suggestion: "Set conversion_status to DRAFT_SOURCE. Rule-pack approval can only be recorded by CircuitInspector Viewer.",
      messageZh: "conversion_status 必须保持为 DRAFT_SOURCE。",
      suggestionZh: "请改为 DRAFT_SOURCE；规则包批准只能由 CircuitInspector Viewer 写入。"
    }));
  }
  const sourceHash = fields.get("source_sha256");
  if (sourceHash) {
    const value = unquote(sourceHash.value);
    if (value !== "UNKNOWN" && !/^[a-f0-9]{64}$/iu.test(value)) {
      diagnostics.push(createDiagnostic({
        code: "SOURCE_HASH_INVALID",
        severity: "WARNING",
        blocksGeneration: false,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: sourceHash.line,
        field: "source_sha256",
        excerpt: lines[sourceHash.line - 1]?.trim() ?? null,
        message: "source_sha256 is neither UNKNOWN nor a 64-character hexadecimal SHA-256 value.",
        suggestion: "Copy the hash produced by a trusted local tool, or use UNKNOWN until the PDF hash is available.",
        messageZh: "source_sha256 既不是 UNKNOWN，也不是 64 位十六进制 SHA-256。",
        suggestionZh: "请填写可信本地工具计算的哈希；暂时无法获得时填写 UNKNOWN。"
      }));
    }
  }
  const forbidden = lines.findIndex((line) => /^\s*-\s*`?(?:approved_by|approved_at|approval|rule_pack_status)`?\s*:/iu.test(line));
  if (forbidden >= 0) {
    diagnostics.push(createDiagnostic({
      code: "FORGED_APPROVAL_FIELD",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: forbidden + 1,
      field: "approval",
      excerpt: lines[forbidden]?.trim() ?? null,
      message: "The generated Markdown contains a rule-pack approval field.",
      suggestion: "Remove approval metadata. Extraction creates DRAFT only; approve the immutable rules in CircuitInspector Viewer.",
      messageZh: "生成的 Markdown 中包含规则包批准字段。",
      suggestionZh: "请删除批准元数据。抽取结果只能是 DRAFT，之后必须在 CircuitInspector Viewer 中批准不可变版本。"
    }));
  }
}

function validateAutomaticRuleCards(
  document: LoadedRuleDocument,
  lines: string[],
  diagnostics: RuleDocumentDiagnostic[]
) {
  const range = sectionRange(lines, "## 2. 自动几何候选规则", "## 3. 待人工复核候选");
  if (!range) return;
  const headings = headingLines(lines, range.start, range.end);
  if (headings.length === 0) {
    diagnostics.push(createDiagnostic({
      code: "AUTO_RULE_CARD_MISSING",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: range.start + 1,
      section: "自动几何候选规则",
      message: "Section 2 contains no populated automatic geometry rule card.",
      suggestion: "Add at least one complete `### RULE-ID Title` card, or move the source requirement to the appropriate REVIEW section.",
      messageZh: "第 2 节没有已填写的自动几何规则卡。",
      suggestionZh: "请至少添加一张完整的 `### RULE-ID 标题` 规则卡；不能确定的要求应移入相应 REVIEW 章节。"
    }));
    return;
  }
  const seenIds = new Map<string, number>();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const next = headings[index + 1]?.index ?? range.end;
    const headingText = lines[heading.index]!.replace(/^###\s+/u, "").trim();
    const ruleId = headingText.split(/\s+/u)[0] ?? "";
    const blockFields = markdownFields(lines, heading.index + 1, next);
    if (!/^[A-Z][A-Z0-9-]{2,63}$/u.test(ruleId)) {
      diagnostics.push(createDiagnostic({
        code: "RULE_ID_INVALID",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: heading.index + 1,
        section: "自动几何候选规则",
        ruleId: ruleId || null,
        field: "id",
        excerpt: lines[heading.index]?.trim() ?? null,
        message: "The rule heading does not start with a stable uppercase ASCII rule ID.",
        suggestion: "Use an ID such as DFT-TP-001 containing only uppercase letters, digits, and hyphens; keep it stable across wording edits.",
        messageZh: "规则标题没有以稳定的大写 ASCII 规则 ID 开头。",
        suggestionZh: "请使用类似 DFT-TP-001 的 ID，只包含大写字母、数字和连字符；仅修改文字时保持 ID 不变。"
      }));
    } else if (seenIds.has(ruleId)) {
      diagnostics.push(createDiagnostic({
        code: "RULE_ID_DUPLICATE",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: heading.index + 1,
        section: "自动几何候选规则",
        ruleId,
        field: "id",
        excerpt: lines[heading.index]?.trim() ?? null,
        message: `Rule ID ${ruleId} is duplicated; the first occurrence is on line ${seenIds.get(ruleId)}.`,
        suggestion: "Assign a unique stable ID to each distinct requirement. Do not merge different applicability or thresholds under one ID.",
        messageZh: `规则 ID ${ruleId} 重复；第一次出现在第 ${seenIds.get(ruleId)} 行。`,
        suggestionZh: "请为每条独立要求分配唯一稳定 ID；不同适用范围或阈值不能共用一个 ID。"
      }));
    } else {
      seenIds.set(ruleId, heading.index + 1);
    }

    for (const field of REQUIRED_RULE_FIELDS) {
      if (!blockFields.has(field)) {
        diagnostics.push(missingFieldDiagnostic(document.sourcePath, heading.index + 1, "自动几何候选规则", ruleId || null, field));
      }
    }

    const sourceLines = [] as number[];
    for (let lineIndex = heading.index + 1; lineIndex < next; lineIndex += 1) {
      if (lines[lineIndex]?.trim().startsWith("[SOURCE ")) sourceLines.push(lineIndex);
    }
    if (sourceLines.length !== 1) {
      diagnostics.push(createDiagnostic({
        code: "RULE_SOURCE_SENTENCE_COUNT",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: heading.index + 1,
        section: "自动几何候选规则",
        ruleId: ruleId || null,
        field: "source_sentence",
        message: `Rule card must contain exactly one standalone [SOURCE ...] normative sentence; found ${sourceLines.length}.`,
        suggestion: "Keep one PDF-backed requirement sentence immediately after the heading. Split distinct requirements into separate rule cards.",
        messageZh: `规则卡必须且只能包含一条独立的 [SOURCE ...] 规范性约束句；当前找到 ${sourceLines.length} 条。`,
        suggestionZh: "请在标题后只保留一条有 PDF 依据的约束句；不同要求拆成独立规则卡。"
      }));
      continue;
    }

    const sourceLineIndex = sourceLines[0]!;
    const sourceLine = lines[sourceLineIndex]!.trim();
    const sourceMatch = /^\[SOURCE\s+pdf="([^"]+)"\s+page="([^"]+)"\s+clause="([^"]+)"\]\s+(.+)$/u.exec(sourceLine);
    if (!sourceMatch) {
      diagnostics.push(createDiagnostic({
        code: "RULE_SOURCE_TAG_INVALID",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: sourceLineIndex + 1,
        section: "自动几何候选规则",
        ruleId: ruleId || null,
        field: "source",
        excerpt: sourceLine,
        message: "The rule source tag does not contain pdf, page, and clause in the required form.",
        suggestion: "Use `[SOURCE pdf=\"file.pdf\" page=\"12\" clause=\"4.2\"] Requirement sentence.` with the real PDF location.",
        messageZh: "规则来源标签没有按要求提供 pdf、page 和 clause。",
        suggestionZh: "请使用 `[SOURCE pdf=\"file.pdf\" page=\"12\" clause=\"4.2\"] 约束句。`，并填写真实 PDF 位置。"
      }));
      continue;
    }
    const [, sourcePdf, sourcePage, , sentence] = sourceMatch;
    if (isUnknown(sourcePdf) || !/^\d+$/u.test(sourcePage ?? "") || Number(sourcePage) <= 0) {
      diagnostics.push(createDiagnostic({
        code: "RULE_SOURCE_LOCATION_INVALID",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: sourceLineIndex + 1,
        section: "自动几何候选规则",
        ruleId: ruleId || null,
        field: "source",
        excerpt: sourceLine,
        message: "An automatic rule must name its source PDF and a positive one-based PDF page number.",
        suggestion: "Copy the exact PDF filename and page number used by the model. If the location is uncertain, move the item to Section 4 REVIEW instead of guessing.",
        messageZh: "自动规则必须标明来源 PDF，并提供从 1 开始的有效 PDF 页码。",
        suggestionZh: "请填写模型实际读取的 PDF 文件名和页码；位置不确定时移入第 4 节 REVIEW，不得猜测。"
      }));
    }

    const thresholdMatches = extractThresholds(sentence ?? "");
    if (thresholdMatches.length !== 1) {
      diagnostics.push(createDiagnostic({
        code: thresholdMatches.length === 0 ? "RULE_THRESHOLD_MISSING" : "RULE_THRESHOLD_REPEATED",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: sourceLineIndex + 1,
        section: "自动几何候选规则",
        ruleId: ruleId || null,
        field: "threshold",
        excerpt: sourceLine,
        message: thresholdMatches.length === 0
          ? "The automatic rule sentence has no supported positive threshold and unit."
          : "The automatic rule sentence repeats or contains multiple numeric thresholds.",
        suggestion: thresholdMatches.length === 0
          ? "State the single PDF-backed threshold with mm, mil, or um. If no fixed value exists, move the item to REVIEW."
          : "Keep exactly one threshold occurrence in this card. Move alternatives or conditions together to Section 3 REVIEW; never choose a value silently.",
        messageZh: thresholdMatches.length === 0
          ? "自动规则句中没有受支持的正阈值和单位。"
          : "自动规则句重复出现阈值，或包含多个数值阈值。",
        suggestionZh: thresholdMatches.length === 0
          ? "请填写 PDF 明确给出的唯一阈值，并使用 mm、mil 或 um；没有固定值时移入 REVIEW。"
          : "此规则卡只保留一次阈值；备选值或条件应整体移入第 3 节 REVIEW，不能静默选值。"
      }));
    }

    const metadataText = lines.slice(heading.index + 1, next).filter((_line, offset) => heading.index + 1 + offset !== sourceLineIndex).join(" ");
    if (extractThresholds(metadataText).length > 0) {
      diagnostics.push(createDiagnostic({
        code: "RULE_THRESHOLD_REPEATED_IN_METADATA",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: heading.index + 1,
        section: "自动几何候选规则",
        ruleId: ruleId || null,
        field: "threshold",
        message: "A numeric threshold and unit are repeated outside the standalone normative sentence.",
        suggestion: "Keep the original value and unit only in the [SOURCE ...] sentence. Let CircuitInspector normalize the threshold and verify it in Viewer.",
        messageZh: "规范性约束句之外又重复出现了数值阈值和单位。",
        suggestionZh: "原始阈值和单位只保留在 [SOURCE ...] 约束句中；由 CircuitInspector 归一化，并在 Viewer 中核对。"
      }));
    }

    if (sourceMatch && thresholdMatches.length === 1) {
      validateRuleInterpretation(document, sourceLineIndex, sourceLine, ruleId, blockFields, diagnostics);
    }
  }
}

function validateRuleInterpretation(
  document: LoadedRuleDocument,
  sourceLineIndex: number,
  sourceLine: string,
  ruleId: string,
  fields: Map<string, MarkdownField>,
  diagnostics: RuleDocumentDiagnostic[]
) {
  const inferred = inferPassage({
    sourcePath: document.sourcePath,
    sourceHash: document.sourceHash,
    page: null,
    paragraph: sourceLineIndex + 1,
    text: sourceLine
  }, sourceLineIndex);
  if (inferred.rules.length !== 1 || inferred.reviewItems.length > 0) {
    diagnostics.push(createDiagnostic({
      code: "RULE_SENTENCE_NOT_EXECUTABLE",
      severity: "ERROR",
      blocksGeneration: true,
      blocksApproval: true,
      sourcePath: document.sourcePath,
      line: sourceLineIndex + 1,
      section: "自动几何候选规则",
      ruleId: ruleId || null,
      field: "source_sentence",
      excerpt: sourceLine,
      message: "The normative sentence does not map to exactly one supported automatic geometry rule.",
      suggestion: "Use one of the canonical sentence forms in the official template without changing the PDF meaning; otherwise move the passage to REVIEW.",
      messageZh: "规范性约束句不能唯一映射为一条受支持的自动几何规则。",
      suggestionZh: "请在不改变 PDF 含义的前提下使用正式模板中的规范句式；仍不能唯一表达时移入 REVIEW。"
    }));
    return;
  }
  const rule = inferred.rules[0]!;
  const expected = new Map<string, string>([
    ["verification_mode", "AUTOMATED_GEOMETRY"],
    ["kind", rule.kind],
    ["source", rule.source],
    ["target", rule.target ?? "NONE"],
    ["metric", rule.metric ?? "NONE"]
  ]);
  for (const [field, expectedValue] of expected) {
    const actualField = fields.get(field);
    if (!actualField) continue;
    const actual = unquote(actualField.value);
    if (actual !== expectedValue) {
      diagnostics.push(createDiagnostic({
        code: "RULE_METADATA_MISMATCH",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: actualField.line,
        section: "自动几何候选规则",
        ruleId: ruleId || null,
        field,
        excerpt: `${field}: ${actual}`,
        message: `Field ${field} is ${actual}, but the normative sentence is interpreted as ${expectedValue}.`,
        suggestion: "Re-check the PDF and make the source sentence and metadata agree. Do not change metadata merely to silence this diagnostic if the source is ambiguous.",
        messageZh: `字段 ${field} 为 ${actual}，但规范性约束句被解释为 ${expectedValue}。`,
        suggestionZh: "请重新核对 PDF，使约束句与元数据一致；来源存在歧义时不能只改字段来消除诊断，应移入 REVIEW。"
      }));
    }
  }
}

function validateReviewSections(
  document: LoadedRuleDocument,
  lines: string[],
  diagnostics: RuleDocumentDiagnostic[]
) {
  const reviewRange = sectionRange(lines, "## 3. 待人工复核候选", "## 4. 不进入自动规则包的要求和不安全候选");
  if (reviewRange) {
    for (let index = reviewRange.start; index < reviewRange.end; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (!line.startsWith("[SOURCE ")) continue;
      const inferred = inferPassage({
        sourcePath: document.sourcePath,
        sourceHash: document.sourceHash,
        page: null,
        paragraph: index + 1,
        text: line
      }, index);
      if (inferred.rules.length > 0) {
        diagnostics.push(createDiagnostic({
          code: "REVIEW_CANDIDATE_BECOMES_EXECUTABLE",
          severity: "ERROR",
          blocksGeneration: true,
          blocksApproval: true,
          sourcePath: document.sourcePath,
          line: index + 1,
          section: "待人工复核候选",
          excerpt: line,
          message: "A Section 3 REVIEW passage would be extracted as an executable geometry rule by the current extractor.",
          suggestion: "If the source is actually unambiguous, move it to a complete Section 2 rule card. Otherwise keep the location and structured reason in Section 4 without a contiguous value-unit pair.",
          messageZh: "第 3 节中的 REVIEW 原文会被当前抽取器误识别为可执行几何规则。",
          suggestionZh: "若原文确实唯一明确，请移入第 2 节并补全规则卡；否则保留来源位置和结构化原因，移入第 4 节且不要连续书写数值与单位。"
        }));
      } else if (inferred.reviewItems.length === 0) {
        diagnostics.push(createDiagnostic({
          code: "REVIEW_CANDIDATE_NOT_RECOGNIZED",
          severity: "ERROR",
          blocksGeneration: true,
          blocksApproval: true,
          sourcePath: document.sourcePath,
          line: index + 1,
          section: "待人工复核候选",
          excerpt: line,
          message: "A Section 3 passage is not recognized as one of the supported extraction review items.",
          suggestion: "Use Section 3 only for multiple thresholds, relative test-point formulas, or non-executable test-point guidance. Move all other uncertainties to Section 4.",
          messageZh: "第 3 节中的原文不能识别为当前支持的抽取复核项。",
          suggestionZh: "第 3 节只放多阈值、测试点相对公式或非可执行测试点指导；其他不确定项全部移入第 4 节。"
        }));
      }
    }
  }

  const manualRange = sectionRange(lines, "## 4. 不进入自动规则包的要求和不安全候选", "## 5. 转换完整性与冲突清单");
  if (manualRange) {
    for (let index = manualRange.start; index < manualRange.end; index += 1) {
      const line = lines[index] ?? "";
      if (extractThresholds(line).length === 0) continue;
      diagnostics.push(createDiagnostic({
        code: "UNSAFE_NON_AUTOMATED_THRESHOLD",
        severity: "ERROR",
        blocksGeneration: true,
        blocksApproval: true,
        sourcePath: document.sourcePath,
        line: index + 1,
        section: "不进入自动规则包的要求和不安全候选",
        field: "source_value_tokens",
        excerpt: line.trim(),
        message: "Section 4 contains a contiguous numeric value and unit that the legacy extractor could misinterpret as an automatic rule.",
        suggestion: "Keep the exact PDF location and record the value as separate tokens such as VALUE=0.5; UNIT=mm. Do not create an automatic PASS/FAIL rule from this item.",
        messageZh: "第 4 节包含连续的数值和单位，旧版抽取器可能把它误识别为自动规则。",
        suggestionZh: "请保留准确 PDF 位置，并拆分记录为 VALUE=0.5; UNIT=mm；此项不得生成自动 PASS/FAIL 规则。"
      }));
    }
  }
}

function reviewItemDiagnostic(item: RuleReviewItem): RuleDocumentDiagnostic {
  const suggestions: Record<RuleReviewItem["code"], { en: string; zh: string }> = {
    RELATIVE_THRESHOLD: {
      en: "Confirm the definition of D, measured entities, and applicability. Keep the formula in REVIEW until formula execution is supported; do not invent a fixed value.",
      zh: "确认 D 的定义、测量对象和适用范围。在公式执行能力完成前保持 REVIEW，不得自行换算成固定值。"
    },
    AMBIGUOUS_THRESHOLD: {
      en: "Use the controlled product scope and source clause to resolve one applicable value. If the source is not decisive, keep it in REVIEW and do not guess.",
      zh: "结合受控产品范围和原文条款确定唯一适用值；来源仍不唯一时保持 REVIEW，不得猜选。"
    },
    NON_EXECUTABLE_GUIDANCE: {
      en: "Keep this as design or equipment guidance and verify that no automatic PASS/FAIL rule was created from it.",
      zh: "将此项保留为设计或设备指导，并确认没有据此生成自动 PASS/FAIL 规则。"
    },
    UNSUPPORTED_TARGET: {
      en: "Retain the requirement as REVIEW. Do not substitute a similar geometry entity; add engine support or close it with manual evidence.",
      zh: "将要求保留为 REVIEW，不得用相近几何对象替代；应补充引擎能力或用人工证据关闭。"
    }
  };
  const suggestion = suggestions[item.code];
  return createDiagnostic({
    code: `EXTRACTION_${item.code}`,
    severity: "WARNING",
    blocksGeneration: false,
    blocksApproval: true,
    sourcePath: item.citation.source_path,
    page: item.citation.page,
    paragraph: item.citation.paragraph,
    excerpt: item.citation.excerpt,
    message: item.message,
    suggestion: suggestion.en,
    messageZh: reviewItemMessageZh(item.code),
    suggestionZh: suggestion.zh
  });
}

function reviewItemMessageZh(code: RuleReviewItem["code"]): string {
  const messages: Record<RuleReviewItem["code"], string> = {
    RELATIVE_THRESHOLD: "原文使用相对公式，尚未确认公式变量、测量对象和适用范围。",
    AMBIGUOUS_THRESHOLD: "原文包含多个备选阈值或适用条件，无法安全选择唯一值。",
    NON_EXECUTABLE_GUIDANCE: "原文属于尺寸或设备指导，不构成可执行的几何间距要求。",
    UNSUPPORTED_TARGET: "当前几何模型不能可靠表达原文目标。"
  };
  return messages[code];
}

function missingFieldDiagnostic(sourcePath: string, line: number, section: string, ruleId: string | null, field: string): RuleDocumentDiagnostic {
  return createDiagnostic({
    code: "TEMPLATE_FIELD_MISSING",
    severity: "ERROR",
    blocksGeneration: true,
    blocksApproval: true,
    sourcePath,
    line,
    section,
    ruleId,
    field,
    message: `Required template field is missing: ${field}.`,
    suggestion: `Restore the \`${field}\` row from the official template. Use UNKNOWN only when that field explicitly permits it.`,
    messageZh: `缺少必需的模板字段：${field}。`,
    suggestionZh: `请从正式模板恢复 \`${field}\` 行；只有该字段明确允许时才能填写 UNKNOWN。`
  });
}

function createDiagnostic(input: DiagnosticInput): RuleDocumentDiagnostic {
  const page = input.page ?? null;
  const line = input.line ?? null;
  const paragraph = input.paragraph ?? null;
  const section = input.section ?? null;
  const ruleId = input.ruleId ?? null;
  const field = input.field ?? null;
  const excerpt = input.excerpt?.slice(0, 500) ?? null;
  const identity = JSON.stringify({ code: input.code, sourcePath: input.sourcePath, page, line, paragraph, section, ruleId, field });
  return {
    id: `rule-diagnostic-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    code: input.code,
    severity: input.severity,
    blocks_generation: input.blocksGeneration,
    blocks_approval: input.blocksApproval,
    source_path: input.sourcePath,
    page,
    line,
    paragraph,
    section,
    rule_id: ruleId,
    field,
    excerpt,
    message: input.message,
    suggestion: input.suggestion,
    message_zh: input.messageZh,
    suggestion_zh: input.suggestionZh
  };
}

function summarizeValidation(schema: RuleDocumentValidation["schema"], diagnostics: RuleDocumentDiagnostic[]): RuleDocumentValidation {
  const unique = [...new Map(diagnostics.map((diagnostic) => [diagnostic.id, diagnostic])).values()]
    .sort((left, right) => left.source_path.localeCompare(right.source_path)
      || (left.page ?? Number.MAX_SAFE_INTEGER) - (right.page ?? Number.MAX_SAFE_INTEGER)
      || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
      || left.code.localeCompare(right.code));
  const generationBlockers = unique.filter((diagnostic) => diagnostic.blocks_generation).length;
  const approvalBlockers = unique.filter((diagnostic) => diagnostic.blocks_approval).length;
  return {
    schema,
    status: generationBlockers > 0 ? "INVALID" : approvalBlockers > 0 || unique.length > 0 ? "REVIEW" : "VALID",
    diagnostics: unique,
    error_count: unique.filter((diagnostic) => diagnostic.severity === "ERROR").length,
    warning_count: unique.filter((diagnostic) => diagnostic.severity === "WARNING").length,
    generation_blocker_count: generationBlockers,
    approval_blocker_count: approvalBlockers
  };
}

function validationSchema(results: TemplateValidationResult[]): RuleDocumentValidation["schema"] {
  if (results.length === 0) return "LEGACY";
  const values = new Set(results.map((result) => result.schema));
  if (values.size > 1) return "MIXED";
  return results[0]?.schema ?? "LEGACY";
}

function formatValidationFailure(validation: RuleDocumentValidation): string {
  const details = validation.diagnostics
    .filter((diagnostic) => diagnostic.blocks_generation)
    .map((diagnostic) => {
      const location = diagnostic.line ? `${diagnostic.source_path}:${diagnostic.line}` : diagnostic.source_path;
      return `[${diagnostic.code}] ${location}: ${diagnostic.message} Suggestion: ${diagnostic.suggestion}`;
    })
    .join("\n");
  return `Rule document validation failed with ${validation.generation_blocker_count} blocking issue(s).${details ? `\n${details}` : ""}`;
}

function markdownFields(lines: string[], start: number, end: number): Map<string, MarkdownField> {
  const fields = new Map<string, MarkdownField>();
  for (let index = start; index < end; index += 1) {
    const match = /^\s*-\s*`([^`]+)`:\s*(.+?)\s*$/u.exec(lines[index] ?? "");
    if (!match?.[1] || match[2] === undefined || fields.has(match[1])) continue;
    fields.set(match[1], { value: match[2], line: index + 1 });
  }
  return fields;
}

function sectionRange(lines: string[], startHeading: string, endHeading: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === startHeading);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === endHeading);
  return { start: start + 1, end: end < 0 ? lines.length : end };
}

function headingLines(lines: string[], start: number, end: number): Array<{ index: number }> {
  const headings: Array<{ index: number }> = [];
  for (let index = start; index < end; index += 1) {
    if (/^###\s+\S/u.test(lines[index] ?? "")) headings.push({ index });
  }
  return headings;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("`") && trimmed.endsWith("`") ? trimmed.slice(1, -1).trim() : trimmed;
}

function isUnknown(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = unquote(value).trim().toUpperCase();
  return normalized === "UNKNOWN" || normalized.length === 0 || normalized.includes("<");
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/u).length;
}
