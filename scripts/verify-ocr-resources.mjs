import { access } from "node:fs/promises";
import path from "node:path";

export const requiredOcrResources = [
  "ocr-worker.cjs",
  "tesseract-core.wasm",
  "tesseract-core-lstm.wasm",
  "tesseract-core-simd.wasm",
  "tesseract-core-simd-lstm.wasm",
  "tesseract-core-relaxedsimd.wasm",
  "tesseract-core-relaxedsimd-lstm.wasm",
  path.join("lang", "eng.traineddata.gz")
];

export async function verifyOcrResources(directory) {
  const missing = [];
  for (const relative of requiredOcrResources) {
    try {
      await access(path.join(directory, relative));
    } catch {
      missing.push(relative);
    }
  }
  if (missing.length) {
    throw new Error(`OCR runtime is incomplete in ${directory}: missing ${missing.join(", ")}`);
  }
}
