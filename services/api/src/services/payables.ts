/** Payables: verified bills not in an open payment run, one group per vendor across all stores. */
import type { PayableBill, PayablesResponse, PayableVendor, VendorStatus } from "@arad/core";
import { storeScope, type SessionUser } from "../context.js";
import { many, type Db } from "../db.js";
import { addDays, istToday } from "./invoices.js";
import { bankBlockedReason, SIGNED_AMOUNT_SQL } from "./vendors.js";

export type DueFilter = "overdue" | "today" | "week" | "all";

interface Row {
  invoice_id: string;
  store_id: string;
  store_name: string;
  invoice_no: string;
  invoice_date: string;
  due_date: string;
  amount_paise: number;
  doc_type: "INV" | "CRN" | "DBN";
  vendor_id: string;
  vendor_name: string;
  vendor_status: VendorStatus;
  bank_id: string | null;
  usable_from: Date | null;
}

export async function payables(db: Db, user: SessionUser, due: DueFilter = "all"): Promise<PayablesResponse> {
  const today = istToday();
  const params: unknown[] = [];
  const where = ["i.state = 'VERIFIED'", "NOT EXISTS (SELECT 1 FROM payment_run_bills rb WHERE rb.invoice_id = i.id AND rb.active)", storeScope(user, "i.store_id", params)];
  if (due !== "all") {
    const limit = due === "overdue" ? addDays(today, -1) : due === "today" ? today : addDays(today, 7);
    params.push(limit);
    where.push(`i.due_date <= $${params.length}::date`);
  }
  const rows = await many<Row>(
    db,
    `SELECT i.id AS invoice_id, i.store_id, s.name AS store_name, i.invoice_no, i.invoice_date, i.due_date, ${SIGNED_AMOUNT_SQL()} AS amount_paise, i.doc_type,
            v.id AS vendor_id, v.name AS vendor_name, v.status AS vendor_status, b.id AS bank_id, b.usable_from
       FROM invoices i
       JOIN stores s ON s.id = i.store_id
       JOIN vendors v ON v.id = i.vendor_id
       LEFT JOIN vendor_bank_accounts b ON b.vendor_id = v.id AND b.status = 'APPROVED'
      WHERE ${where.join(" AND ")}
      ORDER BY lower(v.name), v.id, i.due_date, i.invoice_no`,
    params,
  );
  const groups = new Map<string, PayableVendor>();
  const now = new Date();
  for (const r of rows) {
    let g = groups.get(r.vendor_id);
    if (!g) {
      const blockedReason = bankBlockedReason({ status: r.vendor_status, bank_id: r.bank_id, usable_from: r.usable_from }, now);
      g = { vendorId: r.vendor_id, vendorName: r.vendor_name, bankReady: !blockedReason, ...(blockedReason ? { blockedReason } : {}), totalPaise: 0, bills: [] };
      groups.set(r.vendor_id, g);
    }
    const bill: PayableBill = {
      invoiceId: r.invoice_id,
      storeId: r.store_id,
      storeName: r.store_name,
      invoiceNo: r.invoice_no,
      invoiceDate: r.invoice_date,
      dueDate: r.due_date,
      amountPaise: r.amount_paise,
      docType: r.doc_type,
    };
    g.bills.push(bill);
    g.totalPaise += r.amount_paise;
  }
  const vendors = [...groups.values()];
  return { vendors, totalPaise: vendors.reduce((s, v) => s + v.totalPaise, 0) };
}
