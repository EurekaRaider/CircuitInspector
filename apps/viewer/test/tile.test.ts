import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardRenderer, decodeTile } from "../src/renderer/board-renderer.js";
import type { TilePayload } from "../src/renderer/types.js";

function singleRecordTile(kind = 1): ArrayBuffer {
  const bytes = new ArrayBuffer(42 + 24);
  const view = new DataView(bytes);
  for (const [index, value] of [..."CITL"].entries()) view.setUint8(index, value.charCodeAt(0));
  view.setUint16(4, 1, true);
  view.setUint32(6, 1, true);
  const offset = 42;
  view.setUint8(offset, kind);
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes one line into two triangles without JSON conversion", () => {
    const vertices = decodeTile(singleRecordTile());
    expect(vertices).toHaveLength(36);
    expect(Math.min(...vertices.filter((_value, index) => index % 6 === 0))).toBe(0);
    expect(Math.max(...vertices.filter((_value, index) => index % 6 === 0))).toBe(10);
  });

  it("uses fewer circle vertices for a zoomed-out tile", () => {
    expect(decodeTile(singleRecordTile(3), 2)).toHaveLength(8 * 18);
    expect(decodeTile(singleRecordTile(3), 0)).toHaveLength(24 * 18);
  });

  it("rejects truncated tile records", () => {
    expect(() => decodeTile(singleRecordTile().slice(0, 50))).toThrow(/截断/);
  });

  it("uploads board geometry once and reuses the GPU buffer while the view moves", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    const uploads: Array<{ buffer: unknown; usage: number }> = [];
    let boundBuffer: unknown;
    let bufferId = 0;
    const gl = new Proxy({
      ARRAY_BUFFER: 1,
      STATIC_DRAW: 2,
      DYNAMIC_DRAW: 3,
      FLOAT: 4,
      BLEND: 5,
      SRC_ALPHA: 6,
      ONE_MINUS_SRC_ALPHA: 7,
      COLOR_BUFFER_BIT: 8,
      TRIANGLES: 9,
      VERTEX_SHADER: 10,
      FRAGMENT_SHADER: 11,
      COMPILE_STATUS: 12,
      LINK_STATUS: 13,
      createShader: () => ({}),
      getShaderParameter: () => true,
      createProgram: () => ({}),
      getProgramParameter: () => true,
      createBuffer: () => ({ id: ++bufferId }),
      getUniformLocation: () => ({}),
      bindBuffer: (_target: number, buffer: unknown) => { boundBuffer = buffer; },
      bufferData: (_target: number, _vertices: Float32Array, usage: number) => uploads.push({ buffer: boundBuffer, usage })
    }, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        return () => undefined;
      }
    }) as unknown as WebGL2RenderingContext;
    const canvas = {
      width: 800,
      height: 600,
      clientWidth: 800,
      clientHeight: 600,
      getContext: () => gl
    } as unknown as HTMLCanvasElement;
    const renderer = new BoardRenderer(canvas);
    const tile: TilePayload = {
      path: "/tmp/tile.citl",
      feature_count: 1,
      bounds: { min_x: 0, min_y: 0, max_x: 10_000_000, max_y: 1_000_000 },
      lod: 0,
      bytes: singleRecordTile()
    };

    renderer.setTile(tile);
    renderer.setView({ centerX: 1, centerY: 1, zoom: 20 });
    renderer.setView({ centerX: 2, centerY: 1, zoom: 25 });

    expect(uploads.filter((upload) => upload.usage === gl.STATIC_DRAW)).toHaveLength(1);
    expect(uploads).toHaveLength(1);
    renderer.dispose();
  });
});
