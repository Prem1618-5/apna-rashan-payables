/** Photo helpers: resize + JPEG compress on a canvas (no libraries). */

export const MAX_SIDE = 2000;
export const TARGET_MAX_BYTES = 600 * 1024;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fitSize(w: number, h: number, maxSide = MAX_SIDE): { w: number; h: number } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode photo"))), "image/jpeg", quality));
}

/** Draw (a region of) a source onto a canvas no larger than maxSide and encode as JPEG ~250–600 KB. */
export async function compressSource(source: CanvasImageSource, srcW: number, srcH: number, region?: Rect, maxSide = MAX_SIDE): Promise<Blob> {
  const r = region ?? { x: 0, y: 0, w: srcW, h: srcH };
  const { w, h } = fitSize(r.w, r.h, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, w, h);
  let q = 0.8;
  let blob = await toBlob(canvas, q);
  while (blob.size > TARGET_MAX_BYTES && q > 0.55) {
    q -= 0.1;
    blob = await toBlob(canvas, q);
  }
  canvas.width = canvas.height = 0; // free memory early on low-end phones
  return blob;
}

/** Load a picked file as an <img> (browsers apply EXIF rotation for us). */
export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not open this photo"));
    };
    img.src = url;
  });
}

export async function compressFile(file: Blob): Promise<Blob> {
  const img = await loadImage(file);
  return compressSource(img, img.naturalWidth, img.naturalHeight);
}

/** Grayscale pixels of a source region at a small size, for focus/brightness checks and QR decoding. */
export function grabPixels(source: CanvasImageSource, region: Rect, width: number, canvas?: HTMLCanvasElement): ImageData {
  const c = canvas ?? document.createElement("canvas");
  const h = Math.max(1, Math.round((region.h / region.w) * width));
  if (c.width !== width) c.width = width;
  if (c.height !== h) c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, width, h);
  return ctx.getImageData(0, 0, width, h);
}

/**
 * Sharpness = variance of the Laplacian on a grayscale image (higher = sharper).
 * Brightness = mean luma 0..255. Works on RGBA ImageData.
 */
export function frameQuality(img: { data: Uint8ClampedArray; width: number; height: number }): { sharpness: number; brightness: number } {
  const { data, width: w, height: h } = img;
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const v = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
    g[i] = v;
    sum += v;
  }
  let n = 0;
  let mean = 0;
  let m2 = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - w]! + g[i + w]! + g[i - 1]! + g[i + 1]! - 4 * g[i]!;
      n++;
      const d = lap - mean;
      mean += d / n;
      m2 += d * (lap - mean);
    }
  }
  return { sharpness: n > 1 ? m2 / (n - 1) : 0, brightness: sum / g.length };
}

export type FrameHint = "ok" | "blurry" | "dark" | "bright";
export const SHARP_MIN = 45;
export function hintFor(q: { sharpness: number; brightness: number }): FrameHint {
  if (q.brightness < 55) return "dark";
  if (q.brightness > 238) return "bright";
  if (q.sharpness < SHARP_MIN) return "blurry";
  return "ok";
}
