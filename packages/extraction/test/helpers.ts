import { computeLine, gstinCheckChar, toMilli, toPaise, type RawExtractedLine, type RawExtraction } from "@arad/core";

export const gstin = (first14: string) => first14 + gstinCheckChar(first14);
export const SELLER = gstin("20AABCS1234F1Z");
export const BUYER = gstin("20AAACA9999K1Z");
export const OTHER_STATE_BUYER = gstin("19AAACA9999K1Z");

/** A printed line whose numbers add up (amount before tax). */
export function printedLine(description: string, qty: number, rate: number, gstRate: number, extra: Partial<RawExtractedLine> = {}): RawExtractedLine {
  const c = computeLine({ qtyMilli: toMilli(qty), ratePaise: toPaise(rate), discountPaise: extra.discount ? toPaise(extra.discount) : 0, gstRateBp: Math.round(gstRate * 100) });
  return { description, qty, rate, gstRate, amount: c.taxablePaise / 100, confidence: 0.9, ...extra };
}

/** A consistent invoice (CGST+SGST, amounts before tax) built from printed lines. */
export function invoice(lines: RawExtractedLine[], opts: { roundTo?: boolean; header?: Partial<RawExtraction["header"]>; otherCharges?: number } = {}): RawExtraction {
  let taxable = 0;
  let tax = 0;
  for (const l of lines) {
    const c = computeLine({ qtyMilli: toMilli(l.qty), ratePaise: toPaise(l.rate), discountPaise: l.discount ? toPaise(l.discount) : 0, gstRateBp: Math.round((l.gstRate ?? 0) * 100) });
    taxable += c.taxablePaise;
    tax += c.taxPaise;
  }
  const cgst = Math.round(tax / 2);
  const sgst = tax - cgst;
  const other = opts.otherCharges ? toPaise(opts.otherCharges) : 0;
  const exact = taxable + tax + other;
  const grand = opts.roundTo === false ? exact : Math.round(exact / 100) * 100;
  return {
    header: { vendorName: "Shree Ganesh Distributors", sellerGstin: SELLER, buyerGstin: BUYER, invoiceNo: "SGD/26-27/0412", invoiceDate: "2026-10-20", docType: "INV", ...opts.header },
    lines,
    amountIncludesTax: false,
    totals: { taxable: taxable / 100, cgst: cgst / 100, sgst: sgst / 100, ...(other ? { otherCharges: other / 100 } : {}), roundOff: (grand - exact) / 100, grandTotal: grand / 100 },
    confidence: { vendorName: 0.9, sellerGstin: 0.9, buyerGstin: 0.9, invoiceNo: 0.9, invoiceDate: 0.9, "totals.grandTotal": 0.9 },
  };
}

export const clone = <T>(x: T): T => structuredClone(x);

export const STD_LINES = () => [
  printedLine("Tata Salt 1kg", 50, 26.67, 5, { hsn: "2501", unit: "PKT" }),
  printedLine("Surf Excel Easy Wash 1kg", 12, 118.64, 18, { hsn: "3402", unit: "PCS" }),
  printedLine("Fortune Soyabean Oil 1L", 10, 138.1, 5, { hsn: "1507", unit: "BTL" }),
  printedLine("Parle-G 800g", 24, 76.19, 5, { hsn: "1905", unit: "PKT" }),
];

export const TODAY = "2026-10-22";
