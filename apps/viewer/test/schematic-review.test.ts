import { describe, expect, it } from "vitest";
import { firstPathPage, pathFocusPage, zoomTransformAt } from "../src/renderer/SchematicReview.js";

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

  it("chooses the first page-backed evidence for cross-page navigation", () => {
    expect(firstPathPage([{ page: null }, { page: 2 }, { page: 1 }])).toBe(2);
    expect(firstPathPage([{ page: null }])).toBeNull();
  });

  it("prefers the final chip endpoint page when a traced path crosses pages", () => {
    expect(pathFocusPage(["pin-u7-36"], [{ id: "pin-u7-36", page: 2 }], [{ page: 1 }])).toBe(2);
    expect(pathFocusPage([], [], [{ page: null }, { page: 3 }])).toBe(3);
  });
});
