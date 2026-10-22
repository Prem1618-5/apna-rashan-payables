// End-to-end check of the PWA in mock mode, at iPhone (390x844) and low-end Android (360x780) sizes.
// Usage: pnpm --filter @arad/web build && pnpm --filter @arad/web e2e
// Saves screenshots to apps/web/screenshots/. Uses the Chromium in /opt/pw-browsers (WebKit too, if present).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";
import { chromiumPath, webkitPath } from "./browser.mjs";

const root = new URL("..", import.meta.url).pathname;
const shots = join(root, "screenshots");
mkdirSync(shots, { recursive: true });
const PORT = 4179;
const BASE = `http://localhost:${PORT}`;
const results = [];
let failures = 0;

function check(cond, msg) {
  results.push(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

async function startPreview() {
  const p = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "pipe" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE)).ok) return p;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("vite preview did not start (run the build first)");
}

/** A photo of a paper bill for the gallery upload. */
async function makeSampleBill(browser) {
  const page = await browser.newPage({ viewport: { width: 600, height: 840 } });
  await page.setContent(`<body style="margin:0;background:#cfc8b8;display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace">
  <div style="background:#fdfcf8;width:520px;height:760px;padding:28px;box-sizing:border-box;transform:rotate(-1.5deg);box-shadow:0 6px 20px #0004">
  <h2 style="margin:0">DURGA BISCUIT AGENCY</h2><p>Hinoo, Ranchi · GSTIN 20ABCFD1234E1Z5</p><h3>TAX INVOICE  DBA/4471</h3>
  ${Array.from({ length: 9 }, (_, i) => `<p>${i + 1}. Cream Biscuits 300g ....... 24 x 33.33 = ${(800 + i * 37).toFixed(2)}</p>`).join("")}
  <h3 style="text-align:right">GRAND TOTAL Rs 9,532.00</h3></div></body>`);
  const path = join(tmpdir(), "arad-sample-bill.jpg");
  await page.screenshot({ path, type: "jpeg", quality: 85 });
  await page.close();
  return path;
}

function flow(tag, opts) {
  const full = opts.full;
  return async (page, ctx) => {
    const snap = async (name, o = {}) => {
      // Toasts are transient; close them so screenshots show the screen itself.
      for (const b of await page.locator("[role=status] button[aria-label='Close']").all()) await b.click().catch(() => {});
      await page.waitForTimeout(o.wait ?? 350);
      const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      check(noScroll, `${tag} ${name}: no horizontal scroll`);
      if (!full && !(opts.keep ?? []).some((k) => name.startsWith(k))) return;
      const file = join(shots, `${tag}-${name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      if (statSync(file).size > 190 * 1024) spawnSync("python3", [join(root, "scripts/shrink-png.py"), file]);
      const kb = statSync(file).size / 1024;
      check(kb < 200, `${tag} ${name}.png is ${kb.toFixed(0)} KB (< 200 KB)`);
    };
    const key = async (k) => page.getByRole("group", { name: /keypad|कीपैड/i }).getByRole("button", { name: k, exact: true }).click();
    const typeKeys = async (s) => {
      for (const ch of s) await key(ch === "." ? "Decimal point" : ch);
    };
    const db = () => page.evaluate(() => JSON.parse(localStorage.getItem("arad.mock.db.v1")));

    // ---------------- login (staff) with the custom keypad
    await page.goto(`${BASE}/?mock=1`);
    await page.getByText("Mobile number").waitFor();
    await snap("01-login");
    if (full) {
      await page.getByRole("button", { name: "हिंदी" }).click();
      await snap("02-login-hindi");
      await page.getByRole("button", { name: "English" }).click();
    }
    await typeKeys("9000000002");
    await typeKeys("1111");
    await page.getByText("Photograph bill").waitFor();
    await page.getByText("Shree Balaji Traders").waitFor();
    check(true, `${tag} staff logged in with keypad`);
    await snap("03-home");

    // ---------------- capture: live camera (fake device), then a gallery photo while offline
    await page.getByRole("button", { name: "Photograph bill" }).click();
    await page.waitForTimeout(1800);
    const live = await page.locator("video").evaluate((v) => v.videoWidth > 0).catch(() => false);
    check(live, `${tag} camera preview is live (fake camera)`);
    await snap("04-capture-camera", { wait: 600 });
    await ctx.setOffline(true);
    await page.getByTestId("gallery-input").setInputFiles(opts.sample);
    await page.getByRole("button", { name: /Done, save 1 page/ }).waitFor();
    await snap("05-capture-page");
    await page.getByRole("button", { name: /Done, save 1 page/ }).click();
    await page.getByText("Waiting to upload").first().waitFor();
    await page.getByText("No internet").first().waitFor();
    const queued = await page.evaluate(
      () =>
        new Promise((res) => {
          const r = indexedDB.open("arad");
          r.onsuccess = () => {
            const g = r.result.transaction("outbox").objectStore("outbox").getAll();
            g.onsuccess = () => res(g.result.map((x) => ({ pages: x.pages.length, bytes: x.pages[0].bytes })));
          };
        }),
    );
    check(queued.length === 1 && queued[0].bytes > 20_000, `${tag} capture saved in IndexedDB outbox while offline (${queued[0]?.bytes} bytes JPEG)`);
    await snap("06-home-offline-queue");
    await ctx.setOffline(false);
    await page.getByText("Reading the bill…").first().waitFor({ timeout: 15000 });
    check(true, `${tag} outbox uploaded when back online`);
    await snap("07-home-reading");
    await page.waitForFunction(() => !document.body.innerText.includes("Reading the bill"), null, { timeout: 15000 });
    const after = (await db()).invoices.filter((i) => i.clientId);
    check(after.length === 1 && after[0].state === "NEEDS_VERIFICATION", `${tag} captured bill became NEEDS_VERIFICATION after ~2 s`);

    // ---------------- verify the demo bill end to end
    await page.getByRole("button", { name: /Shree Balaji Traders/ }).click();
    await page.getByRole("button", { name: "Details are right" }).waitFor();
    await page.locator("img[alt='Photo of the bill']").first().evaluate((i) => i.decode());
    await snap("08-verify-details");
    await page.getByRole("button", { name: "Details are right" }).click();
    await page.getByText("Type the GRAND TOTAL printed on the paper").waitFor();
    const bodyText = await page.locator("main").innerText();
    const paperTotal = (await db()).invoices.find((i) => i.id === "inv_demo1").paper.totals.grandTotalPaise;
    const rupees = (p) => `${Math.floor(p / 100)}${p % 100 ? `.${String(p % 100).padStart(2, "0")}` : ""}`;
    check(!bodyText.includes(rupees(paperTotal).replace(/\B(?=(\d{2})+(?!\d)(?=\d{3}))/g, ",")), `${tag} total entry is blind (extracted total not shown)`);
    await snap("09-total-blind");
    await typeKeys("17000");
    await snap("09b-total-typed");
    await page.getByRole("button", { name: "Lock total" }).click();
    await page.getByText("Please look at the paper again").waitFor();
    await snap("10-total-recheck");
    await typeKeys(rupees(paperTotal));
    await page.getByRole("button", { name: "Lock total" }).click();
    await page.getByTestId("line-card").first().waitFor();
    check(true, `${tag} total locked after a guided recheck`);

    const swipe = async (dir, hold) => {
      const card = page.getByTestId("line-card").last();
      const b = await card.boundingBox();
      const y = b.y + b.height * 0.75;
      const x0 = b.x + b.width / 2;
      await page.mouse.move(x0, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((dir === "right" ? 1 : -1) * b.width * 0.5 * i) / 8, y + i);
      if (hold) await hold();
      await page.mouse.up();
    };
    let n = 0;
    let undone = false;
    for (;;) {
      const card = page.getByTestId("line-card").last();
      if (!(await card.isVisible().catch(() => false))) break;
      const text = await card.innerText();
      n++;
      if (text.includes("Local OCR")) {
        if (full) await snap("12-line-flagged");
        await swipe("left");
        await page.getByRole("dialog").getByText("Fix line").waitFor();
        await snap("13-line-edit-sheet");
        const qty = page.getByRole("dialog").getByLabel("Qty", { exact: true });
        await qty.fill("12");
        await snap("13b-line-edit-fixed", { wait: 200 });
        await page.getByRole("button", { name: "Save line" }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
      } else {
        if (n === 1) await snap("11-line-card");
        await page.waitForTimeout(1300); // minimum look time
        await swipe("right", n === 2 && full ? () => snap("14-line-swiping", { wait: 50 }) : undefined);
        if (n === 1 && !undone) {
          await page.waitForTimeout(500);
          await page.getByRole("button", { name: "Undo" }).click();
          undone = true;
          n = 0;
          check(true, `${tag} undo put the card back`);
        }
      }
      await page.waitForTimeout(450);
      if (n > 20) break;
    }
    await page.getByText("Bill balances to ₹0.00").waitFor();
    const meterOk = await page
      .waitForFunction(() => [...document.querySelectorAll("[aria-atomic='true']")].some((e) => e.textContent.trim() === "₹0.00"), null, { timeout: 3000 })
      .then(() => true, () => false);
    check(meterOk, `${tag} balance meter reached ₹0.00`);
    await snap("15-lines-balanced");
    await page.getByRole("button", { name: "Continue to seal" }).click();
    await page.getByRole("button", { name: "Seal bill" }).waitFor();
    await snap("16-seal-checks");
    await page.getByRole("button", { name: "Seal bill" }).click();
    await page.getByText("Bill balanced").waitFor();
    await snap("17-bill-balanced", { wait: 1200 });
    check((await db()).invoices.find((i) => i.id === "inv_demo1").state === "VERIFIED", `${tag} demo bill sealed as VERIFIED`);

    // ---------------- missing-line hint on bill 2
    if (full) {
      await page.goto(`${BASE}/verify/inv_demo2`);
      await page.getByRole("button", { name: "Details are right" }).click();
      const t2 = (await db()).invoices.find((i) => i.id === "inv_demo2").paper.totals.grandTotalPaise;
      await typeKeys(rupees(t2));
      await page.getByRole("button", { name: "Lock total" }).click();
      for (let i = 0; i < 5; i++) {
        await page.getByTestId("line-card").last().waitFor();
        await page.waitForTimeout(1300);
        await page.getByTestId("accept-line").click();
        await page.waitForTimeout(450);
      }
      await page.getByText("A line may be missing").waitFor();
      await snap("18-missing-line-hint");
      await page.getByText("A line may be missing").click();
      await snap("18b-add-line-sheet");
      await page.keyboard.press("Escape");
    }

    // ---------------- owner: dashboard, bills, vendors
    await page.goto(`${BASE}/more`);
    if (full) await snap("19-more-staff");
    await page.getByRole("button", { name: "Log out" }).click();
    await page.getByText("Mobile number").waitFor();
    // phone is remembered; clear it and type the owner's
    await page.getByRole("button", { name: /Mobile number/ }).click();
    for (let i = 0; i < 10; i++) await key("Delete");
    await typeKeys("9000000001");
    await typeKeys("1234");
    await page.getByText("Owed to vendors").waitFor();
    await page.getByText("Today by store").waitFor();
    await snap("20-dashboard", { wait: 600 });

    if (full) {
      await page.getByRole("button", { name: "Bills", exact: true }).click();
      await page.getByPlaceholder("Search vendor or bill number").waitFor();
      await page.waitForTimeout(500);
      await snap("21-bills");
      await page.getByRole("tab", { name: "Verified" }).click();
      await page.waitForTimeout(500);
      await page.locator("main .card button").first().click();
      await page.getByText("Checks", { exact: true }).waitFor();
      await snap("22-bill-detail", { wait: 600 });

      await page.goto(`${BASE}/vendors`);
      await page.getByText("Sai Beverages").waitFor();
      await snap("23-vendors");
      await page.getByRole("button", { name: /Sai Beverages/ }).click();
      await page.getByText("Bank change waiting for your approval").waitFor();
      await snap("24-vendor-bank-change");
      await page.getByRole("button", { name: "Approve these bank details" }).click();
      await snap("25-approve-bank-sheet");
      await page.getByRole("button", { name: "Yes, approve" }).click();
      await page.getByText(/Cooling-off: payments allowed from/).waitFor();
      check(true, `${tag} owner approved a bank change; cooling-off shown`);
      await page.getByRole("button", { name: "Change" }).click();
      await page.getByLabel("Account number", { exact: true }).fill("50200012345678");
      const again = page.getByLabel("Type the account number again");
      await again.focus();
      await page.evaluate(() => {
        const el = document.activeElement;
        const dt = new DataTransfer();
        dt.setData("text/plain", "50200012345678");
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      check((await again.inputValue()) === "", `${tag} paste is blocked in the confirm account field`);
      await again.fill("50200012345679");
      await page.getByLabel("IFSC").fill("HDFC000123");
      await snap("26-bank-form-errors");
      await page.goBack();
    }

    // ---------------- pay: select, prepare, approve, download the HDFC file
    await page.goto(`${BASE}/pay`);
    await page.getByRole("tab", { name: "All" }).click();
    await page.getByText("Select all ready").waitFor();
    await page.waitForTimeout(400);
    if (full) await snap("27-pay");
    await page.getByRole("button", { name: "Select all ready" }).click();
    if (full) {
      await page.getByRole("button", { name: "Show bills of Singh Brothers Wholesale" }).click();
      await page.getByText("Prepare payment run").first().scrollIntoViewIfNeeded();
    }
    await snap("28-pay-selected");
    await page.getByRole("button", { name: "Prepare payment run" }).click();
    await page.getByRole("button", { name: "Prepare for review" }).click();
    await page.getByText("Review payment run").waitFor();
    await snap("29-run-review", { wait: 500 });
    const count = await page.locator("main >> text=Payments").count();
    void count;
    await page.getByTestId("approve-run").click();
    await page.getByTestId("file-name").waitFor();
    await snap("30-file-ready", { wait: 500 });
    const controlCount = Number(await page.getByTestId("control-count").innerText());
    const controlTotal = (await page.getByTestId("control-total").innerText()).replace("₹", "");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-file").click()]);
    const content = readFileSync(await download.path(), "ascii");
    const rows = content.split("\r\n").filter(Boolean);
    const fname = await page.getByTestId("file-name").innerText();
    check(download.suggestedFilename() === fname, `${tag} downloaded file keeps the bank name ${fname}`);
    check(rows.length === controlCount && controlCount > 3, `${tag} HDFC file has ${rows.length} rows = control count ${controlCount}`);
    check(rows.every((r) => r.split(",").length === 28), `${tag} every HDFC row has 28 columns`);
    const sum = rows.reduce((s, r) => s + Math.round(Number(r.split(",")[3]) * 100), 0);
    check((sum / 100).toFixed(2) === controlTotal, `${tag} HDFC file amounts add up to control total ₹${controlTotal}`);
    await page.getByText("Upload in HDFC ENet").scrollIntoViewIfNeeded();
    if (full) await snap("31-enet-steps");
    await page.getByRole("button", { name: "I have uploaded it in ENet" }).click();
    await page.getByRole("button", { name: "Mark paid" }).click();
    await page.getByPlaceholder("UTR (optional)").first().fill("HDFCN26102212345");
    if (full) await snap("32-mark-paid-sheet");
    await page.getByRole("button", { name: "Mark all paid" }).click();
    await page.getByText("UTR HDFCN26102212345").waitFor();
    check(true, `${tag} run marked uploaded and paid with a UTR`);

    if (full) {
      await page.goto(`${BASE}/runs`);
      await page.waitForTimeout(500);
      await snap("33-runs");
      await page.goto(`${BASE}/more`);
      await page.getByText("Bill readers (AI)").waitFor();
      await snap("34-more-owner", { wait: 500 });
      await page.goto(`${BASE}/more/install`);
      await page.getByRole("tab", { name: "iPhone" }).click();
      await snap("35-install-iphone");
    }
  };
}

async function run(browserType, executablePath, devices, args = []) {
  const browser = await browserType.launch({ executablePath, args });
  const sample = await makeSampleBill(browser);
  for (const d of devices) {
    const ctx = await browser.newContext({
      viewport: d.viewport,
      deviceScaleFactor: d.dpr,
      isMobile: browserType === chromium,
      hasTouch: true,
      userAgent: d.ua,
      acceptDownloads: true,
      serviceWorkers: "block",
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      reducedMotion: "no-preference",
      permissions: browserType === chromium ? ["camera"] : [],
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const t0 = Date.now();
    try {
      await flow(d.tag, { full: d.full, keep: d.keep, sample })(page, ctx);
    } catch (e) {
      check(false, `${d.tag} flow crashed: ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: join(tmpdir(), `arad-${d.tag}-failure.png`) }).catch(() => {});
    }
    check(errors.length === 0, `${d.tag} no uncaught page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
    results.push(`      ${d.tag} flow took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (d.dark) {
      const dark = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.dpr, colorScheme: "dark", isMobile: browserType === chromium, hasTouch: true, serviceWorkers: "block" });
      const p = await dark.newPage();
      await p.goto(`${BASE}/?mock=1`);
      await p.getByText("Owner: Rajesh").click();
      await p.getByText("Owed to vendors").waitFor();
      await p.waitForTimeout(800);
      await p.screenshot({ path: join(shots, `${d.tag}-36-dashboard-dark.png`) });
      await p.goto(`${BASE}/verify/inv_demo3`);
      await p.getByRole("button", { name: "Details are right" }).click();
      const t3 = await p.evaluate(() => JSON.parse(localStorage.getItem("arad.mock.db.v1")).invoices.find((i) => i.id === "inv_demo3").paper.totals.grandTotalPaise);
      for (const ch of String(Math.floor(t3 / 100))) await p.getByRole("group", { name: /keypad/i }).getByRole("button", { name: ch, exact: true }).click();
      if (t3 % 100) {
        await p.getByRole("button", { name: "Decimal point" }).click();
        for (const ch of String(t3 % 100).padStart(2, "0")) await p.getByRole("group", { name: /keypad/i }).getByRole("button", { name: ch, exact: true }).click();
      }
      await p.getByRole("button", { name: "Lock total" }).click();
      await p.getByTestId("line-card").first().waitFor();
      await p.waitForTimeout(900);
      await p.screenshot({ path: join(shots, `${d.tag}-37-line-card-dark.png`) });
      await dark.close();
    }
    await ctx.close();
  }
  await browser.close();
}

const preview = await startPreview();
try {
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const ANDROID_UA = "Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
  await run(
    chromium,
    chromiumPath(),
    [
      { tag: "iphone", viewport: { width: 390, height: 844 }, dpr: 2, ua: IPHONE_UA, full: true, dark: true },
      { tag: "android", viewport: { width: 360, height: 780 }, dpr: 2, ua: ANDROID_UA, full: false, keep: ["01", "03", "04", "08", "09-", "11", "13-", "15", "17", "20", "28", "29", "30"] },
    ],
    ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  );
  const wk = webkitPath();
  if (wk) {
    results.push("      WebKit found; running the iPhone flow in WebKit");
    await run(webkit, undefined, [{ tag: "webkit-iphone", viewport: { width: 390, height: 844 }, dpr: 2, full: false }]);
  } else results.push("      WebKit: not installed in /opt/pw-browsers, skipped");
} finally {
  preview.kill();
}
console.log(results.join("\n"));
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
