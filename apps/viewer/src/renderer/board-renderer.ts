import type { BoundsNm, TilePayload, Violation } from "./types";

const HEADER_BYTES = 42;
const RECORD_BYTES = 24;
const FLOATS_PER_VERTEX = 6;

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
out vec4 outColor;
void main() { outColor = v_color; }`;

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
  readonly #buffer: WebGLBuffer;
  #boardVertices: Float32Array<ArrayBufferLike> = new Float32Array();
  #overlayVertices: Float32Array<ArrayBufferLike> = new Float32Array();
  #view: ViewState = { centerX: 0, centerY: 0, zoom: 20 };
  #mirrored = false;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, depth: false, stencil: false });
    if (!gl) throw new Error("此设备不支持 WebGL2，无法启动 GPU PCB Viewer。");
    this.#gl = gl;
    this.#program = createProgram(gl, vertexSource, fragmentSource);
    this.#buffer = gl.createBuffer() ?? throwError("无法创建 GPU 顶点缓冲区");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, 2 * 4);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  setTile(tile: TilePayload | null): void {
    this.#boardVertices = tile ? decodeTile(tile.bytes) : new Float32Array();
    this.draw();
  }

  setView(view: ViewState): void {
    this.#view = view;
    this.draw();
  }

  setMirrored(mirrored: boolean): void {
    this.#mirrored = mirrored;
    this.draw();
  }

  setOverlay(violation: Violation | null, measure?: [number, number, number, number]): void {
    const vertices: number[] = [];
    if (violation) {
      const x = violation.x_nm / 1_000_000;
      const y = violation.y_nm / 1_000_000;
      const radius = Math.max(0.5, 18 / this.#view.zoom);
      addRing(vertices, x, y, radius, [0.88, 0.36, 0.27, 1]);
      addLine(vertices, x - radius * 1.3, y, x + radius * 1.3, y, 2 / this.#view.zoom, [0.88, 0.36, 0.27, 1]);
      addLine(vertices, x, y - radius * 1.3, x, y + radius * 1.3, 2 / this.#view.zoom, [0.88, 0.36, 0.27, 1]);
      const [first, second] = violation.evidence_points ?? [];
      if (first && second) {
        const x0 = first.x / 1_000_000;
        const y0 = first.y / 1_000_000;
        const x1 = second.x / 1_000_000;
        const y1 = second.y / 1_000_000;
        addLine(vertices, x0, y0, x1, y1, 2 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
        addRing(vertices, x0, y0, 5 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
        addRing(vertices, x1, y1, 5 / this.#view.zoom, [0.33, 0.73, 0.76, 1]);
      }
    }
    if (measure) {
      addLine(vertices, measure[0], measure[1], measure[2], measure[3], 2 / this.#view.zoom, [0.42, 0.73, 0.75, 1]);
    }
    this.#overlayVertices = new Float32Array(vertices);
    this.draw();
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
    gl.clearColor(0.075, 0.086, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.#program);
    gl.uniform2f(gl.getUniformLocation(this.#program, "u_center"), this.#view.centerX, this.#view.centerY);
    gl.uniform2f(gl.getUniformLocation(this.#program, "u_viewport"), this.#canvas.width, this.#canvas.height);
    gl.uniform1f(gl.getUniformLocation(this.#program, "u_zoom"), this.#view.zoom * Math.min(window.devicePixelRatio || 1, 2));
    gl.uniform1f(gl.getUniformLocation(this.#program, "u_mirror"), this.#mirrored ? -1 : 1);
    this.#drawVertices(this.#boardVertices);
    this.#drawVertices(this.#overlayVertices);
  }

  #drawVertices(vertices: Float32Array<ArrayBufferLike>): void {
    if (vertices.length === 0) return;
    const gl = this.#gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / FLOATS_PER_VERTEX);
  }
}

export function decodeTile(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes);
  if (bytes.byteLength < HEADER_BYTES || readMagic(view) !== "CITL") throw new Error("无效的 CircuitInspector tile");
  const count = view.getUint32(6, true);
  const vertices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = HEADER_BYTES + index * RECORD_BYTES;
    if (offset + RECORD_BYTES > bytes.byteLength) throw new Error("CircuitInspector tile 数据被截断");
    const kind = view.getUint8(offset);
    const clear = view.getUint8(offset + 1) === 1;
    const layer = view.getUint16(offset + 2, true);
    const x1 = view.getFloat32(offset + 4, true);
    const y1 = view.getFloat32(offset + 8, true);
    const x2 = view.getFloat32(offset + 12, true);
    const y2 = view.getFloat32(offset + 16, true);
    const width = view.getFloat32(offset + 20, true);
    const color = clear ? ([0.075, 0.086, 0.09, 1] as const) : palette[layer % palette.length]!;
    if (kind === 1) addLine(vertices, x1, y1, x2, y2, Math.max(width, 0.01), color);
    else if (kind === 2) addRect(vertices, x1 - x2 / 2, y1 - y2 / 2, x1 + x2 / 2, y1 + y2 / 2, color);
    else if (kind === 3) addDisc(vertices, x1, y1, Math.max(x2 / 2, 0.01), color);
    else if (kind === 4) addRectOutline(vertices, x1, y1, x2, y2, 0.04, color);
  }
  return new Float32Array(vertices);
}

function addLine(vertices: number[], x0: number, y0: number, x1: number, y1: number, width: number, color: readonly number[]) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * width * 0.5;
  const ny = (dx / length) * width * 0.5;
  addQuad(vertices, x0 + nx, y0 + ny, x0 - nx, y0 - ny, x1 - nx, y1 - ny, x1 + nx, y1 + ny, color);
}

function addRect(vertices: number[], minX: number, minY: number, maxX: number, maxY: number, color: readonly number[]) {
  addQuad(vertices, minX, minY, maxX, minY, maxX, maxY, minX, maxY, color);
}

function addRectOutline(vertices: number[], minX: number, minY: number, maxX: number, maxY: number, width: number, color: readonly number[]) {
  addLine(vertices, minX, minY, maxX, minY, width, color);
  addLine(vertices, maxX, minY, maxX, maxY, width, color);
  addLine(vertices, maxX, maxY, minX, maxY, width, color);
  addLine(vertices, minX, maxY, minX, minY, width, color);
}

function addDisc(vertices: number[], x: number, y: number, radius: number, color: readonly number[]) {
  const segments = 24;
  for (let index = 0; index < segments; index += 1) {
    const a0 = (index / segments) * Math.PI * 2;
    const a1 = ((index + 1) / segments) * Math.PI * 2;
    addTriangle(vertices, x, y, x + Math.cos(a0) * radius, y + Math.sin(a0) * radius, x + Math.cos(a1) * radius, y + Math.sin(a1) * radius, color);
  }
}

function addRing(vertices: number[], x: number, y: number, radius: number, color: readonly number[]) {
  const segments = 32;
  const width = radius * 0.08;
  for (let index = 0; index < segments; index += 1) {
    const a0 = (index / segments) * Math.PI * 2;
    const a1 = ((index + 1) / segments) * Math.PI * 2;
    addLine(vertices, x + Math.cos(a0) * radius, y + Math.sin(a0) * radius, x + Math.cos(a1) * radius, y + Math.sin(a1) * radius, width, color);
  }
}

function addQuad(vertices: number[], ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, color: readonly number[]) {
  addTriangle(vertices, ax, ay, bx, by, cx, cy, color);
  addTriangle(vertices, ax, ay, cx, cy, dx, dy, color);
}

function addTriangle(vertices: number[], ax: number, ay: number, bx: number, by: number, cx: number, cy: number, color: readonly number[]) {
  for (const [x, y] of [[ax, ay], [bx, by], [cx, cy]]) vertices.push(x!, y!, color[0]!, color[1]!, color[2]!, color[3]!);
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
