import { describe, expect, it } from "vitest";
import { decodeTile } from "../src/renderer/board-renderer.js";

function lineTile(): ArrayBuffer {
  const bytes = new ArrayBuffer(42 + 24);
  const view = new DataView(bytes);
  for (const [index, value] of [..."CITL"].entries()) view.setUint8(index, value.charCodeAt(0));
  view.setUint16(4, 1, true);
  view.setUint32(6, 1, true);
  const offset = 42;
  view.setUint8(offset, 1);
  view.setUint8(offset + 1, 0);
  view.setUint16(offset + 2, 0, true);
  view.setFloat32(offset + 4, 0, true);
  view.setFloat32(offset + 8, 0, true);
  view.setFloat32(offset + 12, 10, true);
  view.setFloat32(offset + 16, 0, true);
  view.setFloat32(offset + 20, 1, true);
  return bytes;
}

describe("compact GPU tiles", () => {
  it("decodes one line into two triangles without JSON conversion", () => {
    const vertices = decodeTile(lineTile());
    expect(vertices).toHaveLength(36);
    expect(Math.min(...vertices.filter((_value, index) => index % 6 === 0))).toBe(0);
    expect(Math.max(...vertices.filter((_value, index) => index % 6 === 0))).toBe(10);
  });

  it("rejects truncated tile records", () => {
    expect(() => decodeTile(lineTile().slice(0, 50))).toThrow(/截断/);
  });
});
