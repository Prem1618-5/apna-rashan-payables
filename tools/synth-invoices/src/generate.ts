/** Generate N synthetic invoices (images + truth JSON) into a folder. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { LAYOUTS, makeInvoice, truthOf, type Layout, type Truth } from "./model.js";
import { describeDistortion, distort, launch, pickDistortion, qrDataUrl, renderPage } from "./render.js";
import { Rng } from "./rng.js";
import { renderHtml } from "./templates.js";

export interface GenerateOptions {
  count: number;
  seed: number;
  outDir: string;
  layouts?: Layout[];
  /** No distortions (clean renders). */
  clean?: boolean;
  /** Max bytes per image (lowers JPEG quality until it fits). */
  maxBytes?: number;
  today?: string;
  /** Force these invoice indexes to be two-page invoices (continued table). */
  multiPage?: number[];
  log?: (msg: string) => void;
}

const LEVELS = [["none", 2], ["mild", 4], ["moderate", 3], ["harsh", 1]] as const;

export async function generate(opts: GenerateOptions): Promise<Truth[]> {
  mkdirSync(opts.outDir, { recursive: true });
  const browser: Browser = await launch();
  const out: Truth[] = [];
  try {
    const layouts = opts.layouts?.length ? opts.layouts : LAYOUTS;
    for (let i = 0; i < opts.count; i++) {
      const inv = makeInvoice({ seed: opts.seed, index: i, layout: layouts[i % layouts.length], today: opts.today, multiPage: opts.multiPage?.includes(i) ? true : undefined });
      const r = new Rng(opts.seed * 7919 + i);
      const qr = inv.qr ? await qrDataUrl(inv.qr.jwt) : undefined;
      const html = renderHtml(inv, r, qr);
      const scale = inv.layout === "thermal" ? 2 : 1.5;
      const level = opts.clean ? "none" : r.weighted(LEVELS);
      const d = pickDistortion(r, level, inv.layout === "thermal");
      const pages: string[] = [];
      for (let p = 0; p < html.pages.length; p++) {
        const { png, height } = await renderPage(browser, html.pages[p]!, html.width, scale);
        const w = Math.round(html.width * scale);
        const h = Math.round(height * scale);
        let quality = 78;
        let jpg = await distort(browser, png, w, h, d, quality);
        while (opts.maxBytes && jpg.length > opts.maxBytes && quality > 30) {
          quality -= 8;
          jpg = await distort(browser, png, w, h, d, quality);
        }
        const name = `${inv.id}.p${p + 1}.jpg`;
        writeFileSync(join(opts.outDir, name), jpg);
        pages.push(name);
      }
      const truth = truthOf(inv, pages, [level, ...describeDistortion(d)]);
      writeFileSync(join(opts.outDir, `${inv.id}.json`), `${JSON.stringify(truth, null, 2)}\n`);
      out.push(truth);
      opts.log?.(`${inv.id}: ${inv.lines.length} lines, ${pages.length} page(s), ${level}${inv.qr ? ", e-invoice QR" : ""}`);
    }
  } finally {
    await browser.close();
  }
  return out;
}
