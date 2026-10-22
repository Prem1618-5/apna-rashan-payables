/** Decodes QR codes off the main thread (jsQR is only loaded on phones without BarcodeDetector). */
import jsQR from "jsqr";

interface Req {
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<Req>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = (e) => {
  const { id, data, width, height } = e.data;
  let text: string | undefined;
  try {
    text = jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data || undefined;
  } catch {
    text = undefined;
  }
  scope.postMessage({ id, text });
};
