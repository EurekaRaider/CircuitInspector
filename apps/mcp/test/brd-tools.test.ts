import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Allegro BRD selected-TP MCP surface", () => {
  it("registers the complete eight-tool workflow with resources and Viewer deep links", async () => {
    const source = await readFile(path.resolve("apps/mcp/src/index.ts"), "utf8");
    const tools = [
      "import_brd_test_points",
      "query_brd_test_points",
      "export_test_point_review",
      "import_test_point_review",
      "approve_test_point_selection",
      "propose_test_point_alignment",
      "approve_test_point_alignment",
      "analyze_selected_test_points"
    ];
    for (const tool of tools) expect(source).toContain(`server.registerTool(\n  "${tool}"`);
    expect(source).toContain("pathToFileURL(result.csv_path).href");
    expect(source).toContain("circuitinspector://tp-workflow");
    expect(source).toContain("production_readiness_verdict: z.literal(\"REVIEW\")");
  });
});
