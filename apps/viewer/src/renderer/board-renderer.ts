import type { BoundsNm, TestPointCandidate, TilePayload, Violation } from "./types";

const HEADER_BYTES = 42;
const RECORD_BYTES = 24;
const FLOATS_PER_VERTEX = 6;
const FLOATS_PER_TRIANGLE = FLOATS_PER_VERTEX * 3;

const vertexSource = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec4 a_color;
uniform vec2 u_center;
uniform vec2 u_viewport;
uniform float u_zoom;
uniform float u_mirror;
out vec4 v_color;
void main() {
  vec2 delta = a_position - u_center;
  delta.x *= u_mirror;
  vec2 pixel = delta * u_zoom;
  vec2 clip = vec2(pixel.x * 2.0 / u_viewport.x, pixel.y * 2.0 / u_viewport.y);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec4 v_color;
uniform float u_opacity;
out vec4 outColor;
void main() { outColor = vec4(v_color.rgb, v_color.a * u_opacity); }`;

const palette = [
  [0.55, 0.67, 0.43, 1],
  [0.37, 0.63, 0.69, 1],
  [0.76, 0.57, 0.32, 1],
  [0.67, 0.43, 0.39, 1],
  [0.52, 0.48, 0.68, 1],
  [0.62, 0.65, 0.67, 1]
] as const;

export interface ViewState {
  centerX: number;
  centerY: number;
  zoom: number;
}

export class BoardRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #boardBuffer: WebGLBuffer;
  readonly #overlayBuffer: WebGLBuffer;
  readonly #uniforms: {
    center: WebGLUniformLocation | null;
    viewport: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    mirror: WebGLUniformLocation | null;
    opacity: WebGLUniformLocation | null;
  };
  #boardVertexCount = 0;
  #tilePath: string | null = null;
  #overlayVertexCount = 0;
  #overlayViolation: Violation | null = null;
  #overlayTestPoint: TestPointCandidate | null = null;
  #measure: [number, number, number, number] | undefined;
  #view: ViewState = { centerX: 0, centerY: 0, zoom: 20 };
  #mirrored = false;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, depth: false, stencil: false });
    if (!gl) throw new Error("此设备不支持 WebGL2，无法启动 GPU PCB Viewer。");
    this.#gl = gl;
    this.#program = createProgram(gl, vertexSource, fragmentSource);
    this.#boardBuffer = gl.createBuffer() ?? throwError("无法创建 GPU 板图缓冲区");
    this.#overlayBuffer = gl.createBuffer() ?? throwError("无法创建 GPU 标注缓冲区");
    this.#uniforms = {
      center: gl.getUniformLocation(this.#program, "u_center"),
      viewport: gl.getUniformLocation(this.#program, "u_viewport"),
      zoom: gl.getUniformLocation(this.#program, "u_zoom"),
      mirror: gl.getUniformLocation(this.#program, "u_mirror"),
      opacity: gl.getUniformLocation(this.#program, "u_opacity")
    };
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setTile(tile: TilePayload | null): void {
    const tilePath = tile?.path ?? null;
    if (tilePath === this.#tilePath) {
      this.draw();
      return;
    }
    this.#tilePath = tilePath;
    const vertices = tile ? decodeTile(tile.bytes, tile.lod) : new Float32Array();
    this.#boardVertexCount = vertices.length / FLOATS_PER_VERTEX;
    this.#upload(this.#boardBuffer, vertices, this.#gl.STATIC_DRAW);
    this.draw();
  }

  setView(view: ViewState): void {
    this.#view = view;
    this.#refreshOverlay();
    this.draw();
  }

  setMirrored(mirrored: boolean): void {
    this.#mirrored = mirrored;
    this.draw();
  }

  setOverlay(violation: Violation | null, testPoint: TestPointCandidate | null, measure?: [number, number, number, number]): void {
    this.#overlayViolation = violation;
    this.#overlayTestPoint = testPoint;
    this.#measure = measure;
    this.#refreshOverlay();
    this.draw();
  }

  #refreshOverlay(): void {
    const violation = this.#overlayViolation;
    const testPoint = this.#overlayTestPoint;
    const measure = this.#measure;
    if (!violation && !testPoint && !measure) {
      this.#overlayVertexCount = 0;
      return;
    }
    const vertices: number[] = [];
    const write = arrayVertexWriter(vertices);
    if (violation) {
      const x = violation.x_nm / 1_000_000;
      const y = violation.y_nm / 1_000_000;
      const radius = Math.max(0.05, 18 / this.#view.zoom);
      addRing(write, x, y, radius, [0.88, 0.36, 0.27, 1]);
      addLine(write, x - radius * 1.3, y, x + radius * 1.3, y, 2 / this.#view.zoom, [0.88, 0.36, 0.27, 1]);
      addLine(write, x, y - radius * 1.3, x, y + radius * 1.3, 2 / this.#view.zoom, [0.88, 0.36, 0.27, 1]);
      const [first, second] = violation.evidence_points ?? [];
      if (first && second) {
        const x0 = first.x / 1_000_000;
        const y0 = first.y / 1_000_000;
        const x1 = second.x / 1_000_000;
        const y1 = second.y / 1_000_000;
        addLine(write, x0, y0, x1, y1, 2 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
        addRing(write, x0, y0, 5 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
        addRing(write, x1, y1, 5 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
      }
    }
    if (testPoint) {
      const x = testPoint.center.x / 1_000_000;
      const y = testPoint.center.y / 1_000_000;
      const featureRadius = testPoint.radius_nm == null
        ? null
        : Math.max(0.03, testPoint.radius_nm / 1_000_000);
      const locatorRadius = Math.max((featureRadius ?? 0.05) * 1.8, 24 / this.#view.zoom);
      addDisc(write, x, y, locatorRadius, [0.93, 0.66, 0.24, 0.13], 32);
      if (featureRadius != null) addRing(write, x, y, featureRadius, [0.98, 0.83, 0.45, 1]);
      addRing(write, x, y, locatorRadius, [0.98, 0.69, 0.27, 1]);
      addLine(write, x - locatorRadius * 1.45, y, x + locatorRadius * 1.45, y, 2.5 / this.#view.zoom, [0.98, 0.83, 0.45, 1]);
      addLine(write, x, y - locatorRadius * 1.45, x, y + locatorRadius * 1.45, 2.5 / this.#view.zoom, [0.98, 0.83, 0.45, 1]);
      const boardEdge = testPoint.review_context?.board_edge.point;
      if (boardEdge) {
        const edgeX = boardEdge.x / 1_000_000;
        const edgeY = boardEdge.y / 1_000_000;
        addLine(write, x, y, edgeX, edgeY, 2 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
        addRing(write, edgeX, edgeY, 5 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
      }
      const nearestPoint = testPoint.review_context?.nearest_test_point;
      if (nearestPoint) {
        const nearestX = nearestPoint.center.x / 1_000_000;
        const nearestY = nearestPoint.center.y / 1_000_000;
        addLine(write, x, y, nearestX, nearestY, 2 / this.#view.zoom, [0.56, 0.72, 0.42, 1]);
        addRing(write, nearestX, nearestY, 7 / this.#view.zoom, [0.56, 0.72, 0.42, 1]);
      }
    }
    if (measure) {
      addLine(write, measure[0], measure[1], measure[2], measure[3], 2 / this.#view.zoom, [0.42, 0.73, 0.75, 1]);
    }
    const buffer = new Float32Array(vertices);
    this.#overlayVertexCount = buffer.length / FLOATS_PER_VERTEX;
    this.#upload(this.#overlayBuffer, buffer, this.#gl.DYNAMIC_DRAW);
  }

  resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.#canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(this.#canvas.clientHeight * ratio));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    this.draw();
  }

  draw(): void {
    const gl = this.#gl;
    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.clearColor(0.067, 0.078, 0.086, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.#program);
    gl.uniform2f(this.#uniforms.center, this.#view.centerX, this.#view.centerY);
    gl.uniform2f(this.#uniforms.viewport, this.#canvas.width, this.#canvas.height);
    gl.uniform1f(this.#uniforms.zoom, this.#view.zoom * Math.min(window.devicePixelRatio || 1, 2));
    gl.uniform1f(this.#uniforms.mirror, this.#mirrored ? -1 : 1);
    gl.uniform1f(this.#uniforms.opacity, this.#overlayTestPoint || this.#overlayViolation ? 0.55 : 1);
    this.#drawBuffer(this.#boardBuffer, this.#boardVertexCount);
    gl.uniform1f(this.#uniforms.opacity, 1);
    this.#drawBuffer(this.#overlayBuffer, this.#overlayVertexCount);
  }

  dispose(): void {
    this.#gl.deleteBuffer(this.#boardBuffer);
    this.#gl.deleteBuffer(this.#overlayBuffer);
    this.#gl.deleteProgram(this.#program);
  }

  #upload(buffer: WebGLBuffer, vertices: Float32Array<ArrayBufferLike>, usage: number): void {
    const gl = this.#gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, usage);
  }

  #drawBuffer(buffer: WebGLBuffer, vertexCount: number): void {
    if (vertexCount === 0) return;
    const gl = this.#gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, 0);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, 2 * 4);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }
}

export function decodeTile(bytes: ArrayBuffer, lod = 0): Float32Array {
  const view = new DataView(bytes);
  if (bytes.byteLength < HEADER_BYTES || readMagic(view) !== "CITL") throw new Error("无效的 CircuitInspector tile");
  const count = view.getUint32(6, true);
  if (HEADER_BYTES + count * RECORD_BYTES > bytes.byteLength) throw new Error("CircuitInspector tile 数据被截断");
  let floatCount = 0;
  for (let index = 0; index < count; index += 1) {
    floatCount += recordFloatCount(view.getUint8(HEADER_BYTES + index * RECORD_BYTES), lod);
  }
  const vertices = new Float32Array(floatCount);
  let cursor = 0;
  const write: VertexWriter = (x, y, color) => {
    vertices[cursor++] = x;
    vertices[cursor++] = y;
    vertices[cursor++] = color[0]!;
    vertices[cursor++] = color[1]!;
    vertices[cursor++] = color[2]!;
    vertices[cursor++] = color[3]!;
  };
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * RECORD_BYTES;
    const kind = view.getUint8(offset);
    const clear = view.getUint8(offset + 1) === 1;
    const layer = view.getUint16(offset + 2, true);
    const x1 = view.getFloat32(offset + 4, true);
    const y1 = view.getFloat32(offset + 8, true);
    const x2 = view.getFloat32(offset + 12, true);
    const y2 = view.getFloat32(offset + 16, true);
    const width = view.getFloat32(offset + 20, true);
    const color = clear ? ([0.067, 0.078, 0.086, 1] as const) : palette[layer % palette.length]!;
    if (kind === 1) addLine(write, x1, y1, x2, y2, Math.max(width, 0.01), color);
    else if (kind === 2) addRect(write, x1 - x2 / 2, y1 - y2 / 2, x1 + x2 / 2, y1 + y2 / 2, color);
    else if (kind === 3) addDisc(write, x1, y1, Math.max(x2 / 2, 0.01), color, discSegments(lod));
    else if (kind === 4) addRectOutline(write, x1, y1, x2, y2, 0.04, color);
  }
  return vertices;
}

type VertexWriter = (x: number, y: number, color: readonly number[]) => void;

function arrayVertexWriter(vertices: number[]): VertexWriter {
  return (x, y, color) => {
    vertices.push(x, y, color[0]!, color[1]!, color[2]!, color[3]!);
  };
}

function recordFloatCount(kind: number, lod: number): number {
  if (kind === 1 || kind === 2) return FLOATS_PER_TRIANGLE * 2;
  if (kind === 3) return FLOATS_PER_TRIANGLE * discSegments(lod);
  if (kind === 4) return FLOATS_PER_TRIANGLE * 8;
  return 0;
}

function discSegments(lod: number): number {
  return lod >= 2 ? 8 : lod === 1 ? 12 : 24;
}

function addLine(write: VertexWriter, x0: number, y0: number, x1: number, y1: number, width: number, color: readonly number[]) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * width * 0.5;
  const ny = (dx / length) * width * 0.5;
  addQuad(write, x0 + nx, y0 + ny, x0 - nx, y0 - ny, x1 - nx, y1 - ny, x1 + nx, y1 + ny, color);
}

function addRect(write: VertexWriter, minX: number, minY: number, maxX: number, maxY: number, color: readonly number[]) {
  addQuad(write, minX, minY, maxX, minY, maxX, maxY, minX, maxY, color);
}

function addRectOutline(write: VertexWriter, minX: number, minY: number, maxX: number, maxY: number, width: number, color: readonly number[]) {
  addLine(write, minX, minY, maxX, minY, width, color);
  addLine(write, maxX, minY, maxX, maxY, width, color);
  addLine(write, maxX, maxY, minX, maxY, width, color);
  addLine(write, minX, maxY, minX, minY, width, color);
}

function addDisc(write: VertexWriter, x: number, y: number, radius: number, color: readonly number[], segments: number) {
  for (let index = 0; index < segments; index += 1) {
    const a0 = (index / segments) * Math.PI * 2;
    const a1 = ((index + 1) / segments) * Math.PI * 2;
    addTriangle(write, x, y, x + Math.cos(a0) * radius, y + Math.sin(a0) * radius, x + Math.cos(a1) * radius, y + Math.sin(a1) * radius, color);
  }
}

function addRing(write: VertexWriter, x: number, y: number, radius: number, color: readonly number[]) {
  const segments = 32;
  const width = radius * 0.08;
  for (let index = 0; index < segments; index += 1) {
    const a0 = (index / segments) * Math.PI * 2;
    const a1 = ((index + 1) / segments) * Math.PI * 2;
    addLine(write, x + Math.cos(a0) * radius, y + Math.sin(a0) * radius, x + Math.cos(a1) * radius, y + Math.sin(a1) * radius, width, color);
  }
}

function addQuad(write: VertexWriter, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, color: readonly number[]) {
  addTriangle(write, ax, ay, bx, by, cx, cy, color);
  addTriangle(write, ax, ay, cx, cy, dx, dy, color);
}

function addTriangle(write: VertexWriter, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: readonly number[]) {
  write(ax, ay, color);
  write(bx, by, color);
  write(cx, cy, color);
}

function readMagic(view: DataView): string {
  return String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
}

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram() ?? throwError("无法创建 WebGL 程序");
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "WebGL link failed");
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type) ?? throwError("无法创建 WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL shader failed");
  return shader;
}

function throwError(message: string): never {
  throw new Error(message);
}

export function fitView(bounds: BoundsNm, width: number, height: number): ViewState {
  const boardWidth = Math.max(0.001, (bounds.max_x - bounds.min_x) / 1_000_000);
  const boardHeight = Math.max(0.001, (bounds.max_y - bounds.min_y) / 1_000_000);
  return {
    centerX: (bounds.min_x + bounds.max_x) / 2_000_000,
    centerY: (bounds.min_y + bounds.max_y) / 2_000_000,
    zoom: Math.max(0.05, Math.min(width / boardWidth, height / boardHeight) * 0.86)
  };
}
