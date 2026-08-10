import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";

const EXTRACTOR_VERSION = "0.2.0";

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
  kind: "MINIMUM_DISTANCE" | "MINIMUM_WIDTH" | "MINIMUM_ANNULAR_RING";
  source: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL";
  target: "TEST_POINT" | "COMPONENT" | "COPPER" | "BOARD_EDGE" | "DRILL" | null;
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
  citation: RuleCitation;
}

interface Passage {
  sourcePath: string;
  sourceHash: string;
  page: number | null;
  paragraph: number;
  text: string;
}

export async function extractRulePack(paths: string[], cacheDir: string, title?: string) {
  const passages = (await Promise.all(paths.map(readPassages))).flat();
  const inferred = passages.map((passage, index) => inferPassage(passage, index));
  const rules = inferred.flatMap((result) => result.rules);
  const reviewItems = inferred.flatMap((result) => result.reviewItems);
  if (rules.length === 0) {
    throw new Error("No executable distance, width, or annular-ring rules were recognized; clarify the source wording before approval.");
  }
  const hash = createHash("sha256")
    .update(EXTRACTOR_VERSION)
    .update(JSON.stringify(passages.map(({ sourceHash, page, paragraph, text }) => ({ sourceHash, page, paragraph, text }))))
    .digest("hex");
  const id = `rules-${hash.slice(0, 12)}`;
  const ragDirectory = path.join(cacheDir, "rules", "rag");
  await mkdir(ragDirectory, { recursive: true });
  await writeFile(path.join(ragDirectory, `${id}.json`), JSON.stringify({ id, passages }, null, 2), "utf8");
  return {
    rulePack: {
      id,
      version: `${EXTRACTOR_VERSION}-draft`,
      title: title?.trim() || `Extracted rules ${hash.slice(0, 8)}`,
      status: "DRAFT" as const,
      rules,
      review_items: reviewItems,
      approval: null
    },
    passageCount: passages.length,
    ruleCount: rules.length,
    ragIndexPath: path.join(ragDirectory, `${id}.json`)
  };
}

async function readPassages(sourcePath: string): Promise<Passage[]> {
  const absolute = path.resolve(sourcePath);
  const bytes = await readFile(absolute);
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const extension = path.extname(absolute).toLowerCase();
  if (extension === ".md" || extension === ".markdown" || extension === ".txt") {
    return splitPassages(bytes.toString("utf8"), absolute, sourceHash, null);
  }
  if (extension === ".docx") {
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    return splitPassages(extracted.value, absolute, sourceHash, null);
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
    return passages;
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
    reviewItems: [{ id: `review-${code.toLowerCase().replaceAll("_", "-")}-${suffix}`, code, message, acknowledged: false, citation }]
  });
  if (/测试点|test\s*point/i.test(value) && /panel\s*tab|breaking\s*tab|工艺边连接筋|邮票孔连接边/i.test(value)) {
    return reviewItem("UNSUPPORTED_TARGET", "Panel-tab clearance is not represented by the current executable geometry entities; confirm it manually.");
  }
  if (/测试点|test\s*point/i.test(value) && /(?:\d+\s*\/\s*\d+|half|一半|二分之一)\s*(?:d\b|diameter|直径)?/i.test(value)) {
    return reviewItem("RELATIVE_THRESHOLD", "The source uses a relative diameter formula that the current fixed-threshold engine cannot execute safely.");
  }
  const supportedSubject = /环宽|annular\s+ring|线宽|导线宽|trace\s+width|minimum\s+width|测试点|test\s*point/i.test(value)
    || ((/铜|copper/i.test(value) && /板边|board\s+edge/i.test(value)))
    || ((/孔|drill|hole/i.test(value) && /铜|copper/i.test(value)));
  if (!supportedSubject) return { rules: [], reviewItems: [] };
  if (thresholds.length !== 1) {
    return reviewItem("AMBIGUOUS_THRESHOLD", "The passage contains multiple dimensional values, so no single executable threshold was selected.");
  }
  const threshold = thresholds[0]!;
  if (/环宽|annular\s+ring/i.test(value)) {
    return executable(baseRule(`annular-ring-${suffix}`, "最小环宽", "MINIMUM_ANNULAR_RING", "DRILL", "COPPER", null, threshold, citation));
  }
  if (/线宽|导线宽|trace\s+width|minimum\s+width/i.test(value)) {
    return executable(baseRule(`trace-width-${suffix}`, "最小导线宽度", "MINIMUM_WIDTH", "COPPER", null, null, threshold, citation));
  }
  if (/测试点|test\s*point/i.test(value)) {
    if (!hasDistanceRequirement(normalized)) {
      return reviewItem("NON_EXECUTABLE_GUIDANCE", "The passage mentions test-point dimensions or equipment guidance but does not state an executable clearance requirement.");
    }
    if (/工装孔|定位孔|tooling\s+hole/i.test(value)) {
      return executable(baseRule(`tp-tooling-hole-${suffix}`, "测试点到工装孔距离", "MINIMUM_DISTANCE", "TEST_POINT", "DRILL", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/板边|board\s+edge/i.test(value)) {
      return executable(baseRule(`tp-board-edge-${suffix}`, "测试点到板边距离", "MINIMUM_DISTANCE", "TEST_POINT", "BOARD_EDGE", "EDGE_TO_EDGE", threshold, citation));
    }
    if (/器件|component/i.test(value)) {
      return executable(baseRule(`tp-component-${suffix}`, "测试点到器件距离", "MINIMUM_DISTANCE", "TEST_POINT", "COMPONENT", "BODY_TO_PAD", threshold, citation));
    }
    if (/测试点(?:边缘)?间距|test\s*point\s+(?:edge[- ]to[- ]edge\s+)?spacing|between\s+test\s*points|test\s*point[^.]{0,80}test\s*point/i.test(value)) {
      return executable(baseRule(`tp-spacing-${suffix}`, "测试点间距", "MINIMUM_DISTANCE", "TEST_POINT", "TEST_POINT", metricFromText(normalized), threshold, citation));
    }
    return reviewItem("NON_EXECUTABLE_GUIDANCE", "The passage does not identify a supported target for the test-point measurement.");
  }
  if (/铜|copper/i.test(value) && /板边|board\s+edge/i.test(value)) {
    return executable(baseRule(`copper-edge-${suffix}`, "铜到板边距离", "MINIMUM_DISTANCE", "COPPER", "BOARD_EDGE", "EDGE_TO_EDGE", threshold, citation));
  }
  if (/孔|drill|hole/i.test(value) && /铜|copper/i.test(value)) {
    return executable(baseRule(`drill-copper-${suffix}`, "孔到铜距离", "MINIMUM_DISTANCE", "DRILL", "COPPER", "EDGE_TO_EDGE", threshold, citation));
  }
  return { rules: [], reviewItems: [] };
}

function executable(rule: ExtractedRule): { rules: ExtractedRule[]; reviewItems: RuleReviewItem[] } {
  return { rules: [rule], reviewItems: [] };
}

function hasDistanceRequirement(text: string): boolean {
  const distance = /间距|距离|间隙|避让|clearance|distance|spacing|gap|keep[- ]?out|edge\s+to\s+(?:the\s+)?(?:board|tooling|component|test)/i.test(text);
  const requirement = /不得|不低于|不小于|至少|最小|要求|必须|应保持|at\s+least|minimum|required|must|shall|make\s+sure|keep\s+at\s+least|>=|≥|keep[- ]?out/i.test(text);
  return distance && requirement;
}

function extractThresholds(text: string): number[] {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|mil|mils|um|μm|微米)/giu)];
  return matches.flatMap((match) => {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return [];
    const unit = match[2]?.toLowerCase();
    if (unit === "mil" || unit === "mils") return [Math.round(amount * 25_400)];
    if (unit === "um" || unit === "μm" || unit === "微米") return [Math.round(amount * 1_000)];
    return [Math.round(amount * 1_000_000)];
  });
}

function metricFromText(text: string): "CENTER_TO_CENTER" | "EDGE_TO_EDGE" {
  return /中心|center/i.test(text) ? "CENTER_TO_CENTER" : "EDGE_TO_EDGE";
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
