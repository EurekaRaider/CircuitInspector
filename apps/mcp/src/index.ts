import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CoreClient } from "./core-client.js";
import { extractRulePack } from "./documents.js";

const cacheDir = path.resolve(
  process.env.CIRCUIT_INSPECTOR_CACHE_DIR ?? path.join(os.homedir(), ".circuit-inspector", "cache")
);
const core = new CoreClient();
const server = new McpServer({ name: "circuit-inspector", version: "0.1.0" });

const coverageSchema = z.object({
  layers: z.string(),
  nets: z.string(),
  components: z.string(),
  pins: z.string(),
  test_points: z.string(),
  drills: z.string()
});

server.registerTool(
  "import_design",
  {
    title: "Import PCB design",
    description: "Import a local ODB++, TGZ, Gerber X1/X2/X3, Gerber Job, XNC/Excellon, ZIP, or IPC-356 manufacturing package.",
    inputSchema: { path: z.string().min(1) },
    outputSchema: {
      id: z.string(),
      format: z.string(),
      source_path: z.string(),
      content_hash: z.string(),
      bounds: z.record(z.string(), z.number()),
      layers: z.array(z.record(z.string(), z.unknown())),
      component_count: z.number(),
      net_count: z.number(),
      test_point_count: z.number(),
      drill_count: z.number(),
      semantic_coverage: coverageSchema,
      diagnostics: z.array(z.record(z.string(), z.unknown())),
      cache_hit: z.boolean(),
      elapsed_ms: z.number()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ path: designPath }, extra) => {
    await progress(extra, 0, 100, "Validating and streaming PCB input");
    const result = await core.request<Record<string, unknown>>(
      "import_design",
      { path: path.resolve(designPath), cache_dir: cacheDir },
      extra.signal
    );
    await progress(extra, 100, 100, "PCB design is indexed");
    return toolResult(result, `Imported ${String(result.format)} design ${String(result.id)}.`);
  }
);

server.registerTool(
  "extract_rule_pack",
  {
    title: "Extract draft PCB rules",
    description: "Extract auditable DFT/DFM rule candidates from local PDF, DOCX, Markdown, or text documents. The result remains DRAFT until approved in the Viewer.",
    inputSchema: { paths: z.array(z.string().min(1)).min(1), title: z.string().optional() },
    outputSchema: {
      rule_pack: z.record(z.string(), z.unknown()),
      passage_count: z.number(),
      rule_count: z.number(),
      rag_index_path: z.string()
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ paths, title }, extra) => {
    await progress(extra, 0, 100, "Extracting local rule evidence");
    const extracted = await extractRulePack(paths, cacheDir, title);
    await core.request("save_rule_pack", { cache_dir: cacheDir, rule_pack: extracted.rulePack }, extra.signal);
    await progress(extra, 100, 100, "Draft rule pack created; human approval is still required");
    const structured = {
      rule_pack: extracted.rulePack,
      passage_count: extracted.passageCount,
      rule_count: extracted.ruleCount,
      rag_index_path: extracted.ragIndexPath
    };
    return toolResult(structured, `Created DRAFT rule pack ${extracted.rulePack.id} with ${extracted.ruleCount} candidate rules. It cannot run until approved in the Viewer.`);
  }
);

server.registerTool(
  "list_rule_packs",
  {
    title: "List PCB rule packs",
    description: "List local DRAFT, APPROVED, and DEPRECATED rule packs.",
    inputSchema: {},
    outputSchema: { rule_packs: z.array(z.record(z.string(), z.unknown())) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async () => {
    const result = await core.request<{ rule_packs: unknown[] }>("list_rule_packs", { cache_dir: cacheDir });
    return toolResult(result, `Found ${result.rule_packs.length} local rule packs.`);
  }
);

server.registerTool(
  "analyze_design",
  {
    title: "Analyze PCB design",
    description: "Run an APPROVED deterministic DFT/DFM rule pack against an imported PCB design.",
    inputSchema: { design_id: z.string().min(1), rule_pack_id: z.string().min(1) },
    outputSchema: {
      id: z.string(),
      design_id: z.string(),
      rule_pack_id: z.string(),
      verdict: z.string(),
      pass_count: z.number(),
      fail_count: z.number(),
      review_count: z.number(),
      not_applicable_count: z.number(),
      violations: z.array(z.record(z.string(), z.unknown())),
      report_uri: z.string(),
      elapsed_ms: z.number(),
      report_path: z.string()
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async ({ design_id, rule_pack_id }, extra) => {
    await progress(extra, 0, 100, "Starting deterministic geometry checks");
    const result = await core.request<Record<string, unknown>>(
      "analyze_design",
      { cache_dir: cacheDir, design_id, rule_pack_id },
      extra.signal
    );
    await progress(extra, 100, 100, "Analysis complete");
    const viewer = viewerLink(String(result.id));
    return {
      content: [
        { type: "text" as const, text: `Analysis ${String(result.id)}: ${String(result.verdict)}. FAIL ${String(result.fail_count)}, REVIEW ${String(result.review_count)}.` },
        { type: "resource_link" as const, name: "Open in CircuitInspector Viewer", uri: viewer, mimeType: "application/x-circuit-inspector" }
      ],
      structuredContent: result
    };
  }
);

server.registerTool(
  "query_violations",
  {
    title: "Query PCB violations",
    description: "Filter analysis results by net name, reference designator, rule, or verdict.",
    inputSchema: {
      analysis_id: z.string().min(1),
      net_name: z.string().optional(),
      component_ref: z.string().optional(),
      rule_id: z.string().optional(),
      verdict: z.enum(["PASS", "FAIL", "REVIEW", "NOT_APPLICABLE"]).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(1000).default(100)
    },
    outputSchema: {
      analysis_id: z.string(),
      total: z.number(),
      offset: z.number(),
      violations: z.array(z.record(z.string(), z.unknown()))
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async (input, extra) => {
    const result = await core.request<Record<string, unknown>>(
      "query_violations",
      { cache_dir: cacheDir, ...input },
      extra.signal
    );
    return toolResult(result, `Returned ${(result.violations as unknown[]).length} violations.`);
  }
);

server.registerTool(
  "render_evidence",
  {
    title: "Render PCB evidence",
    description: "Render local high-resolution PNG and lossless SVG evidence for selected violations.",
    inputSchema: {
      analysis_id: z.string().min(1),
      violation_ids: z.array(z.string()).default([]),
      width: z.number().int().min(256).max(4096).default(1600),
      height: z.number().int().min(256).max(4096).default(1200)
    },
    outputSchema: { analysis_id: z.string(), evidence: z.array(z.record(z.string(), z.unknown())) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async (input, extra) => {
    await progress(extra, 0, 100, "Rendering vector evidence locally");
    const result = await core.request<{ analysis_id: string; evidence: Array<{ violation_id: string; png_path: string; svg_path: string }> }>(
      "render_evidence",
      { cache_dir: cacheDir, ...input },
      extra.signal
    );
    await progress(extra, 100, 100, "Evidence ready");
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
      | { type: "resource_link"; name: string; uri: string; mimeType: string }
    > = [
      { type: "text", text: `Rendered ${result.evidence.length} evidence image(s) for analysis ${result.analysis_id}.` }
    ];
    for (const item of result.evidence.slice(0, 8)) {
      const data = await readFile(item.png_path);
      content.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
      content.push({ type: "resource_link", name: `${item.violation_id} SVG`, uri: pathToFileURL(item.svg_path).href, mimeType: "image/svg+xml" });
      content.push({ type: "resource_link", name: "Open issue in Viewer", uri: viewerLink(result.analysis_id, item.violation_id), mimeType: "application/x-circuit-inspector" });
    }
    return { content, structuredContent: result };
  }
);

server.registerResource(
  "analysis-summary",
  new ResourceTemplate("circuit://analysis/{analysisId}/summary", { list: undefined }),
  { title: "CircuitInspector analysis summary", mimeType: "application/json" },
  async (uri, { analysisId }) => {
    const analysis = await core.request("read_analysis", { cache_dir: cacheDir, analysis_id: String(analysisId) });
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(analysis, null, 2) }] };
  }
);

server.registerResource(
  "analysis-report",
  new ResourceTemplate("circuit://analysis/{analysisId}/report", { list: undefined }),
  { title: "CircuitInspector HTML report", mimeType: "text/html" },
  async (uri, { analysisId }) => {
    const report = path.join(cacheDir, "evidence", resourceSegment(analysisId), "report.html");
    return { contents: [{ uri: uri.href, mimeType: "text/html", text: await readFile(report, "utf8") }] };
  }
);

server.registerResource(
  "analysis-evidence",
  new ResourceTemplate("circuit://analysis/{analysisId}/evidence/{fileName}", { list: undefined }),
  { title: "CircuitInspector evidence", mimeType: "application/octet-stream" },
  async (uri, { analysisId, fileName }) => {
    const safeFile = resourceSegment(fileName, true);
    const file = path.join(cacheDir, "evidence", resourceSegment(analysisId), safeFile);
    const data = await readFile(file);
    return {
      contents: [{
        uri: uri.href,
        mimeType: safeFile.endsWith(".svg") ? "image/svg+xml" : "image/png",
        blob: data.toString("base64")
      }]
    };
  }
);

async function progress(
  extra: {
    _meta?: { progressToken?: string | number | undefined } | undefined;
    sendNotification: (notification: any) => Promise<void>;
  },
  value: number,
  total: number,
  message: string
) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: value, total, message } });
}

function toolResult<T extends Record<string, unknown>>(structuredContent: T, text: string) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function viewerLink(analysisId: string, issueId?: string): string {
  const search = issueId ? `?issue=${encodeURIComponent(issueId)}` : "";
  return `circuitinspector://analysis/${encodeURIComponent(analysisId)}${search}`;
}

function resourceSegment(value: unknown, allowDot = false): string {
  const text = String(value);
  const pattern = allowDot ? /^[a-zA-Z0-9_-]+\.(?:png|svg)$/ : /^[a-zA-Z0-9_-]+$/;
  if (!pattern.test(text)) throw new Error("Invalid CircuitInspector resource identifier");
  return text;
}

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    core.close();
    process.exit(0);
  });
}
