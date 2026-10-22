import type { Issue, PayableBill, PaymentInstruction, Vendor } from "./types.js";

/**
 * Turn many bills (across all stores) into one payment per vendor.
 * Credit notes are negative amounts and reduce the vendor's total.
 */
export function consolidate(
  bills: PayableBill[],
  vendors: Vendor[],
  runRef: string,
): { instructions: PaymentInstruction[]; errors: Issue[] } {
  const errors: Issue[] = [];
  if (!/^[A-Z0-9]{1,17}$/.test(runRef)) {
    errors.push({ message: `run reference must be 1-17 capital letters or digits: ${runRef}` });
    return { instructions: [], errors };
  }

  const vendorById = new Map(vendors.map((v) => [v.id, v]));
  const groups = new Map<string, PayableBill[]>();
  const seenBills = new Set<string>();

  for (const bill of bills) {
    if (!Number.isSafeInteger(bill.amountPaise)) {
      errors.push({ vendorId: bill.vendorId, message: `bill ${bill.billNo}: amount must be whole paise` });
      continue;
    }
    const billKey = `${bill.vendorId}|${bill.storeCode}|${bill.billNo}`;
    if (seenBills.has(billKey)) {
      errors.push({ vendorId: bill.vendorId, message: `bill ${bill.billNo} (${bill.storeCode}) appears twice in this run` });
      continue;
    }
    seenBills.add(billKey);
    if (!vendorById.has(bill.vendorId)) {
      errors.push({ vendorId: bill.vendorId, message: `bill ${bill.billNo}: vendor not found in vendor master` });
      continue;
    }
    const list = groups.get(bill.vendorId) ?? [];
    list.push(bill);
    groups.set(bill.vendorId, list);
  }

  // Stable order (by vendor name) so the same input always gives the same file.
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    const an = vendorById.get(a)!.name;
    const bn = vendorById.get(b)!.name;
    return an.localeCompare(bn) || a.localeCompare(b);
  });

  const instructions: PaymentInstruction[] = [];
  for (const [vendorId, vendorBills] of ordered) {
    const vendor = vendorById.get(vendorId)!;
    const amountPaise = vendorBills.reduce((sum, b) => sum + b.amountPaise, 0);
    if (amountPaise <= 0) {
      errors.push({ vendorId, message: `${vendor.name}: credit notes are equal to or larger than the bills, nothing to pay` });
      continue;
    }
    instructions.push({
      customerRef: `${runRef}${String(instructions.length + 1).padStart(3, "0")}`,
      vendor,
      amountPaise,
      billRefs: vendorBills.map((b) => b.billNo),
    });
  }

  return { instructions, errors };
}
