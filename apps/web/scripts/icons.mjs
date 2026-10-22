// Renders the SVG brand mark to the PNG icons the manifest and iOS need.
// Usage: pnpm --filter @arad/web icons   (uses the Chromium in /opt/pw-browsers)
import { copyFileSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { chromiumPath } from "../e2e/browser.mjs";

const dir = new URL("../public/", import.meta.url);
const icon = readFileSync(new URL("icons/icon.svg", dir), "utf8");
const maskable = readFileSync(new URL("icons/maskable.svg", dir), "utf8");

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
async function render(svg, size, out, bg = "transparent") {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:${bg}">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(out, dir).pathname, omitBackground: bg === "transparent" });
}
await render(icon, 192, "icons/icon-192.png");
await render(icon, 512, "icons/icon-512.png");
await render(maskable, 512, "icons/maskable-512.png", "#0E7C66");
// iOS ignores transparency and rounds corners itself, so use the full-bleed version.
await render(maskable, 180, "apple-touch-icon.png", "#0E7C66");
await browser.close();
copyFileSync(new URL("icons/icon.svg", dir), new URL("favicon.svg", dir));
console.log("icons written to public/");
