import { decodeTile } from "./board-renderer";

interface TileDecodeRequest {
  requestId: number;
  bytes: ArrayBuffer;
  lod: number;
}

self.onmessage = (event: MessageEvent<TileDecodeRequest>) => {
  const { requestId, bytes, lod } = event.data;
  try {
    const vertices = decodeTile(bytes, lod);
    self.postMessage({ requestId, vertices }, { transfer: [vertices.buffer] });
  } catch (cause) {
    self.postMessage({
      requestId,
      error: cause instanceof Error ? cause.message : String(cause)
    });
  }
};
