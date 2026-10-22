import { existsSync, readdirSync } from "node:fs";

/** Finds the pre-installed Chromium (never run `playwright install` in this sandbox). */
export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = `${root}/${d}/${rel}`;
      if (existsSync(p)) return p;
    }
  }
  return undefined; // let playwright-core try its own default
}

/** WebKit, if a build is present next to Chromium. */
export function webkitPath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^webkit-\d+$/.test(d)) : [];
  return dirs.length ? `${root}/${dirs.sort().reverse()[0]}` : undefined;
}
