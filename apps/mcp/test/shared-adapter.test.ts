import { describe, expect, it } from "vitest";
import {
  extractRulePack as sharedExtractRulePack,
  compareFixtureWiring as sharedCompareFixtureWiring,
  qualifyWibDesign as sharedQualifyWibDesign,
  recommendManufacturingTests as sharedRecommendManufacturingTests
} from "@circuit-inspector/workflows";
import { extractRulePack as mcpExtractRulePack } from "../src/documents.js";
import { recommendManufacturingTests as mcpRecommendManufacturingTests } from "../src/test-recommendations.js";
import { qualifyWibDesign as mcpQualifyWibDesign } from "../src/wib-qualification.js";
import { compareFixtureWiring as mcpCompareFixtureWiring } from "../src/wiring.js";

describe("MCP protocol adapters share the manual-workbench implementation", () => {
  it("re-exports the exact rule, wiring, recommendation, and qualification services", () => {
    expect(mcpExtractRulePack).toBe(sharedExtractRulePack);
    expect(mcpCompareFixtureWiring).toBe(sharedCompareFixtureWiring);
    expect(mcpRecommendManufacturingTests).toBe(sharedRecommendManufacturingTests);
    expect(mcpQualifyWibDesign).toBe(sharedQualifyWibDesign);
  });
});
