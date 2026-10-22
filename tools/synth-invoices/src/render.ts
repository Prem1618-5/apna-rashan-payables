/** Renders invoice HTML to images with Playwright (system Chromium in /opt/pw-browsers) and applies photo-like distortions. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import QRCode from "qrcode";
import type { Rng } from "./rng.js";

/** Find a Chromium binary without ever running `playwright install`. */
export function findChromium(): string {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers"].filter((x): x is string => !!x && existsSync(x));
  for (const root of roots) {
    const dirs = readdirSync(root).sort().reverse();
    for (const d of dirs.filter((x) => x.startsWith("chromium_headless_shell-"))) {
      const p = join(root, d, "chrome-linux", "headless_shell");
      if (existsSync(p)) return p;
    }
    for (const d of dirs.filter((x) => /^chromium-\d+/.test(x))) {
      const p = join(root, d, "chrome-linux", "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("Chromium not found: set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH (never run playwright install here)");
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox", "--font-render-hinting=none"] });
}

export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 260 });
}

/** Render one HTML page to PNG at the given CSS width. */
export async function renderPage(browser: Browser, html: string, width: number, scale: number): Promise<{ png: Buffer; height: number }> {
  const page = await browser.newPage({ viewport: { width, height: 400 }, deviceScaleFactor: scale });
  try {
    await page.setContent(html, { waitUntil: "load" });
    const height = await page.evaluate(() => Math.ceil(document.body.scrollHeight));
    await page.setViewportSize({ width, height });
    const png = await page.screenshot({ type: "png", fullPage: true });
    return { png, height };
  } finally {
    await page.close();
  }
}

export interface Distortion {
  rotateDeg: number;
  skewDeg: number;
  blurPx: number;
  contrast: number;
  brightness: number;
  sepia: number;
  shadow: number;
  shadowAngle: number;
  background: string;
  margin: number;
}

export function pickDistortion(r: Rng, level: "none" | "mild" | "moderate" | "harsh", thermal: boolean): Distortion {
  const sign = () => (r.chance(0.5) ? -1 : 1);
  const bg = r.pick(["#6b5b4b", "#8a7a66", "#3d4a52", "#9a9a92", "#5a4636"]);
  const base: Distortion = { rotateDeg: 0, skewDeg: 0, blurPx: 0, contrast: 1, brightness: 1, sepia: thermal ? 0.15 : 0, shadow: 0, shadowAngle: 0, background: bg, margin: 0 };
  if (level === "none") return { ...base, background: "#ffffff" };
  if (level === "mild") return { ...base, rotateDeg: sign() * (0.4 + r.next() * 1.2), shadow: 0.12 + r.next() * 0.1, shadowAngle: r.int(0, 359), margin: 0.03 };
  if (level === "moderate")
    return { ...base, rotateDeg: sign() * (1 + r.next() * 2), skewDeg: sign() * r.next() * 1.2, blurPx: 0.3 + r.next() * 0.4, contrast: 0.8 + r.next() * 0.1, brightness: 0.95, shadow: 0.2 + r.next() * 0.15, shadowAngle: r.int(0, 359), margin: 0.04 };
  return { ...base, rotateDeg: sign() * (2 + r.next() * 2.5), skewDeg: sign() * (0.5 + r.next() * 1.5), blurPx: 0.7 + r.next() * 0.5, contrast: 0.62 + r.next() * 0.12, brightness: 0.88 + r.next() * 0.06, sepia: thermal ? 0.35 : 0.1, shadow: 0.3 + r.next() * 0.15, shadowAngle: r.int(0, 359), margin: 0.05 };
}

export function describeDistortion(d: Distortion): string[] {
  const out: string[] = [];
  if (d.rotateDeg) out.push(`rotate ${d.rotateDeg.toFixed(1)}°`);
  if (d.skewDeg) out.push(`skew ${d.skewDeg.toFixed(1)}°`);
  if (d.blurPx) out.push(`blur ${d.blurPx.toFixed(2)}px`);
  if (d.contrast < 1) out.push(`contrast ${d.contrast.toFixed(2)}`);
  if (d.shadow) out.push(`shadow ${d.shadow.toFixed(2)}`);
  if (d.sepia) out.push(`paper tint ${d.sepia.toFixed(2)}`);
  return out.length ? out : ["clean"];
}

/** Photograph-like re-render: rotate/skew on a background, blur, low contrast, shadow gradient; JPEG out. */
export async function distort(browser: Browser, png: Buffer, w: number, h: number, d: Distortion, quality: number): Promise<Buffer> {
  const mw = Math.round(w * d.margin);
  const mh = Math.round(h * d.margin);
  const W = w + 2 * mw;
  const H = h + 2 * mh;
  const html = `<!doctype html><html><body style="margin:0;background:${d.background};width:${W}px;height:${H}px;overflow:hidden;position:relative">
  <img src="data:image/png;base64,${png.toString("base64")}" style="position:absolute;left:${mw}px;top:${mh}px;width:${w}px;height:${h}px;transform:rotate(${d.rotateDeg}deg) skew(${d.skewDeg}deg);transform-origin:50% 50%;filter:blur(${d.blurPx}px) contrast(${d.contrast}) brightness(${d.brightness}) sepia(${d.sepia});box-shadow:0 4px 18px rgba(0,0,0,.35)"/>
  <div style="position:absolute;inset:0;background:linear-gradient(${d.shadowAngle}deg, rgba(0,0,0,${d.shadow}) 0%, rgba(0,0,0,${d.shadow * 0.4}) 35%, rgba(0,0,0,0) 70%)"></div>
  </body></html>`;
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    return await page.screenshot({ type: "jpeg", quality, fullPage: false });
  } finally {
    await page.close();
  }
}
