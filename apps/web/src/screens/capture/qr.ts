/** QR detection: native BarcodeDetector where it exists (Android Chrome), else jsQR in a Web Worker (iPhone). */
import { grabPixels, type Rect } from "../../lib/image";

export interface QrScanner {
  native: boolean;
  /** Returns decoded QR payloads found in the region. */
  scan(source: CanvasImageSource, srcW: number, srcH: number, region?: Rect, width?: number): Promise<string[]>;
  dispose(): void;
}

export async function createQrScanner(): Promise<QrScanner> {
  if (typeof BarcodeDetector !== "undefined") {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes("qr_code")) {
        const det = new BarcodeDetector({ formats: ["qr_code"] });
        return {
          native: true,
          async scan(source) {
            try {
              return (await det.detect(source)).map((r) => r.rawValue).filter(Boolean);
            } catch {
              return [];
            }
          },
          dispose() {},
        };
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  const worker = new Worker(new URL("./qr.worker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  const waiting = new Map<number, (text?: string) => void>();
  worker.onmessage = (e: MessageEvent<{ id: number; text?: string }>) => {
    waiting.get(e.data.id)?.(e.data.text);
    waiting.delete(e.data.id);
  };
  const canvas = document.createElement("canvas");
  return {
    native: false,
    scan(source, srcW, srcH, region, width = 800) {
      const r = region ?? { x: 0, y: 0, w: srcW, h: srcH };
      const img = grabPixels(source, r, Math.min(width, Math.round(r.w)), canvas);
      const id = ++seq;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve([]);
        }, 1500);
        waiting.set(id, (text) => {
          clearTimeout(timer);
          resolve(text ? [text] : []);
        });
        worker.postMessage({ id, data: img.data, width: img.width, height: img.height }, [img.data.buffer]);
      });
    },
    dispose() {
      worker.terminate();
      waiting.clear();
    },
  };
}
