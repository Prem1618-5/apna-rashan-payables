import { createHash } from "node:crypto";
import { ENET_VENDOR_PAYMENT_V1, type ColumnKey, type LayoutSpec } from "./spec.js";
import { cleanCode, cleanText, formatDate, formatPaise, packIntoLines } from "./text.js";
import type { ControlTotals, FileOptions, FileResult, Issue, PaymentInstruction, RowPreview, TxnType } from "./types.js";
import { checkAccountNumber, isHdfcIfsc, isValidEmail, isValidIfsc } from "./validate.js";

const RTGS_MIN_PAISE = 2_00_000_00;

/**
 * Build the HDFC bulk upload file. Returns the file only if every row is valid;
 * otherwise returns the full list of problems, because one bad row makes the
 * bank reject the whole file.
 */
export function generateBulkFile(instructions: PaymentInstruction[], options: FileOptions): FileResult {
  const layout = options.layout ?? ENET_VENDOR_PAYMENT_V1;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const clientCode = cleanCode(options.clientCode);
  if (!/^[A-Z0-9]{1,20}$/.test(clientCode)) errors.push({ field: "clientCode", message: "HDFC client code is missing or invalid" });
  if (!Number.isInteger(options.sequence) || options.sequence < 1 || options.sequence > 999) {
    errors.push({ field: "sequence", message: "file sequence must be 1 to 999" });
  }
  let txnDate = "";
  try {
    txnDate = formatDate(options.valueDate);
  } catch (e) {
    errors.push({ field: "valueDate", message: (e as Error).message });
  }
  if (instructions.length === 0) errors.push({ message: "no payments in this run" });

  const rows: string[] = [];
  const previews: RowPreview[] = [];
  const seenRefs = new Set<string>();
  const seenVendors = new Set<string>();
  const seenAccounts = new Map<string, string>();
  const control: ControlTotals = {
    count: 0,
    totalPaise: 0,
    total: "0.00",
    byType: { N: { count: 0, totalPaise: 0 }, R: { count: 0, totalPaise: 0 }, I: { count: 0, totalPaise: 0 } },
  };

  for (const ins of instructions) {
    const ref = ins.customerRef;
    const v = ins.vendor;
    const at = { customerRef: ref, vendorId: v.id };
    const rowErrors: Issue[] = [];
    const err = (field: string, message: string) => rowErrors.push({ ...at, field, message: `${v.name}: ${message}` });
    const warn = (field: string, message: string) => warnings.push({ ...at, field, message: `${v.name}: ${message}` });

    // One payment per vendor and per account in a file; anything else is a duplicate.
    if (!/^[A-Z0-9]{1,20}$/.test(ref)) err("customerRef", `reference "${ref}" must be 1-20 capital letters or digits`);
    if (seenRefs.has(ref)) err("customerRef", `reference ${ref} is used twice`);
    seenRefs.add(ref);
    if (seenVendors.has(v.id)) err("vendor", "vendor appears twice in this file");
    seenVendors.add(v.id);

    const account = cleanCode(v.accountNumber);
    const acct = checkAccountNumber(account);
    if (!acct.ok) err("beneAccount", "account number must be 6-25 letters or digits");
    else if (acct.unusual) warn("beneAccount", "account number is not the usual 9-18 digits; please double-check");
    const otherVendor = seenAccounts.get(account);
    if (otherVendor && otherVendor !== v.id) err("beneAccount", `same account number as vendor ${otherVendor}`);
    seenAccounts.set(account, v.id);

    const ifsc = cleanCode(v.ifsc);
    if (!isValidIfsc(ifsc)) err("ifsc", `IFSC "${v.ifsc}" is not valid (format: 4 letters, 0, 6 letters/digits)`);

    if (!Number.isSafeInteger(ins.amountPaise) || ins.amountPaise <= 0) err("amount", "amount must be more than zero, in whole paise");
    if (options.maxAmountPaise !== undefined && ins.amountPaise > options.maxAmountPaise) {
      err("amount", `amount ${formatPaise(ins.amountPaise)} is above the per-payment limit ${formatPaise(options.maxAmountPaise)}`);
    }

    const name = cleanText(v.name);
    if (!name) err("beneName", "beneficiary name is empty after removing unsupported characters (use English letters)");
    else if (name !== v.name.trim()) warn("beneName", `name written as "${name}" (unsupported characters removed)`);

    const txnType = chooseTxnType(ifsc, ins.amountPaise, options);
    const beneCode = cleanCode(v.beneCode);
    if ((options.beneCodeRequiredFor ?? ["I"]).includes(txnType) && !beneCode) {
      err("beneCode", `transfer type ${txnType} needs the ENet beneficiary code; register the vendor in ENet and save the code`);
    }

    let email = (v.email ?? "").trim();
    if (email && !isValidEmail(email)) {
      warn("beneEmail", `email "${email}" is not valid and was left out`);
      email = "";
    }

    const details = packIntoLines(cleanText(options.narrationPrefix ?? "BILLS"), ins.billRefs.map(cleanText).filter(Boolean), 7, 30);
    const address = (v.address ?? []).map(cleanText);

    const values: Partial<Record<ColumnKey, string>> = {
      txnType,
      beneCode,
      beneAccount: account,
      amount: rowErrors.some((e) => e.field === "amount") ? "" : formatPaise(ins.amountPaise),
      beneName: name,
      beneAddr1: address[0],
      beneAddr2: address[1],
      beneAddr3: address[2],
      beneAddr4: address[3],
      beneAddr5: address[4],
      instructionRef: ref,
      customerRef: ref,
      payDetails1: details[0],
      payDetails2: details[1],
      payDetails3: details[2],
      payDetails4: details[3],
      payDetails5: details[4],
      payDetails6: details[5],
      payDetails7: details[6],
      txnDate,
      ifsc,
      beneBankName: cleanText(v.bankName),
      beneBranchName: cleanText(v.branchName),
      beneEmail: email,
    };

    const cells = layout.columns.map((c) => {
      let value = values[c.key] ?? "";
      if (value.includes(layout.delimiter) || /[\r\n"]/.test(value)) err(c.key, `${c.label} contains a forbidden character`);
      if (value.length > c.maxLength) {
        if (c.overflow === "error") err(c.key, `${c.label} is longer than ${c.maxLength} characters`);
        else {
          warn(c.key, `${c.label} shortened to ${c.maxLength} characters`);
          value = value.slice(0, c.maxLength);
        }
      }
      return value;
    });

    if (rowErrors.length) {
      errors.push(...rowErrors);
      continue;
    }

    rows.push(cells.join(layout.delimiter));
    previews.push({ customerRef: ref, vendorId: v.id, vendorName: name, txnType, amount: formatPaise(ins.amountPaise), billRefs: ins.billRefs });
    control.count++;
    control.totalPaise += ins.amountPaise;
    control.byType[txnType].count++;
    control.byType[txnType].totalPaise += ins.amountPaise;
  }

  if (errors.length) return { ok: false, errors, warnings };

  const header = layout.headerRow ? [layout.columns.map((c) => c.label).join(layout.delimiter)] : [];
  const content = [...header, ...rows].join(layout.lineEnding) + (layout.trailingNewline ? layout.lineEnding : "");
  if (!/^[\x20-\x7E\r\n]*$/.test(content)) return { ok: false, errors: [{ message: "file contains non-ASCII characters" }], warnings };
  const bytes = Buffer.byteLength(content, "ascii");
  if (bytes > layout.maxFileBytes) {
    return { ok: false, errors: [{ message: `file is ${bytes} bytes; the bank limit is ${layout.maxFileBytes}. Split the run.` }], warnings };
  }

  control.total = formatPaise(control.totalPaise);
  return {
    ok: true,
    fileName: buildFileName(layout, clientCode, options.valueDate, options.sequence),
    content,
    sha256: createHash("sha256").update(content, "ascii").digest("hex"),
    control,
    rows: previews,
    warnings,
  };
}

export function chooseTxnType(ifsc: string, amountPaise: number, options: Pick<FileOptions, "internalForHdfc" | "rtgsFromPaise">): TxnType {
  if ((options.internalForHdfc ?? true) && isHdfcIfsc(ifsc)) return "I";
  return amountPaise >= (options.rtgsFromPaise ?? RTGS_MIN_PAISE) ? "R" : "N";
}

export function buildFileName(layout: LayoutSpec, clientCode: string, isoDate: string, sequence: number): string {
  const [yyyy = "", mm = "", dd = ""] = isoDate.split("-");
  return layout.fileNamePattern
    .replace("{CLIENT}", clientCode)
    .replace("{DD}", dd)
    .replace("{MM}", mm)
    .replace("{YYYY}", yyyy)
    .replace("{SEQ}", String(sequence).padStart(3, "0"));
}
