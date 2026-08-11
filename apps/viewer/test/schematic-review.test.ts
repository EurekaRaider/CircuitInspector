import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { firstPathPage, fitPageTransform, pathFocusPage, zoomTransformAt } from "../src/renderer/SchematicReview.js";
import { SchematicReview } from "../src/renderer/SchematicReview.js";
import type { SchematicDocument } from "../src/renderer/types.js";

describe("schematic PDF viewport", () => {
  it("keeps the document point under the pointer fixed while zooming", () => {
    const current = { x: 40, y: 25, scale: 0.5 };
    const cursor = { x: 310, y: 225 };
    const before = { x: (cursor.x - current.x) / current.scale, y: (cursor.y - current.y) / current.scale };
    const next = zoomTransformAt(current, cursor, 1.25);
    const after = { x: (cursor.x - next.x) / next.scale, y: (cursor.y - next.y) / next.scale };
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it("centers the first rendered page inside the available viewport", () => {
    expect(fitPageTransform({ width: 1000, height: 700 }, { width: 2000, height: 1000 })).toEqual({
      x: 24,
      y: 112,
      scale: 0.476
    });
  });

  it("chooses the first page-backed evidence for cross-page navigation", () => {
    expect(firstPathPage([{ page: null }, { page: 2 }, { page: 1 }])).toBe(2);
    expect(firstPathPage([{ page: null }])).toBeNull();
  });

  it("prefers the final chip endpoint page when a traced path crosses pages", () => {
    expect(pathFocusPage(["pin-u7-36"], [{ id: "pin-u7-36", page: 2 }], [{ page: 1 }])).toBe(2);
    expect(pathFocusPage([], [], [{ page: null }, { page: 3 }])).toBe(3);
  });

  it("clips the PDF workspace and keeps the review panel in its own grid column", () => {
    const document = {
      id: "schematic",
      role: "PRODUCT",
      pages: [],
      interface_candidates: [],
      confirmed_scopes: [],
      paths: [],
      components: [],
      graph_pins: [],
      nets: [],
      wires: [],
      junctions: [],
      corrections: [],
      diagnostics: []
    } as unknown as SchematicDocument;
    const markup = renderToStaticMarkup(createElement(SchematicReview, {
      locale: "zh-CN",
      document,
      operator: "",
      busy: false,
      onOperator: () => undefined,
      onTrace: async () => undefined,
      onCorrect: async () => undefined,
      onConfirm: () => undefined
    }));

    expect(markup).toContain('data-testid="schematic-review-layout"');
    expect(markup).toContain("grid-cols-[132px_minmax(0,1fr)_minmax(280px,330px)]");
    expect(markup).toContain('data-testid="schematic-review-toolbar"');
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain('data-testid="schematic-review-panel"');
  });
});
