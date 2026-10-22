/**
 * Build an HDFC bulk upload file from a JSON run.
 * Usage: tsx scripts/make-file.ts <run.json> <out-dir>
 * Writes the bank file plus a .summary.json with control totals and the bills each payment covers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consolidate, generateBulkFile, type FileOptions, type PayableBill, type Vendor } from "../src/index.js";

const [input, outDir = "out"] = process.argv.slice(2);
if (!input) {
  console.error("usage: tsx scripts/make-file.ts <run.json> <out-dir>");
  process.exit(2);
}

const run = JSON.parse(readFileSync(input, "utf8")) as { runRef: string; options: FileOptions; vendors: Vendor[]; bills: PayableBill[] };
const { instructions, errors } = consolidate(run.bills, run.vendors, run.runRef);
if (errors.length) {
  console.error("Cannot build the file:\n" + errors.map((e) => `  - ${e.message}`).join("\n"));
  process.exit(1);
}

const result = generateBulkFile(instructions, run.options);
for (const w of result.warnings) console.warn(`warning: ${w.message}`);
if (!result.ok) {
  console.error("Cannot build the file:\n" + result.errors.map((e) => `  - ${e.message}`).join("\n"));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, result.fileName), result.content, "ascii");
writeFileSync(
  join(outDir, `${result.fileName}.summary.json`),
  JSON.stringify({ fileName: result.fileName, sha256: result.sha256, control: result.control, payments: result.rows }, null, 2),
);

console.log(`Wrote ${join(outDir, result.fileName)}`);
console.log(`Payments: ${result.control.count}   Total: Rs ${result.control.total}`);
console.log("Before authorising in ENet, check that the bank shows the same count and total.");
