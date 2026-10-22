/** System prompt and response schema for vision LLM readers (used by Gemini; reusable for others). */

export const EXTRACTION_PROMPT_VERSION = "gst-invoice-v1";

export const SYSTEM_PROMPT = `You read photos of Indian GST vendor invoices (tax invoices, bills of supply, credit notes, debit notes) for a supermarket's accounts team. Your output is checked by maths and by a person, and a wrong number is far worse than a missing one.

THE DOCUMENTS
- Printed A4/A5 distributor invoices with item tables, and narrow thermal-printer receipts.
- Text may be English, Hindi (Devanagari) or mixed. Keep item names in the script printed; do not translate.
- An invoice may span several pages/photos. Tables can continue across pages, with rows like "B/F", "Brought Forward", "C/F", "Carried Forward", "Page Total" or "Sub Total". Those rows are NOT items: never output them as lines. Output every real item row exactly once, in printed order, across all pages.
- Photos may be tilted, curled, shadowed, blurred or low contrast.

RULES
1. Transcribe; do not calculate. Read every amount exactly as printed. Never compute, round, correct or "fix" a printed number, even if the invoice's own maths looks wrong.
2. Never invent. If a value is not printed, is cut off, or you cannot read it with certainty, return null for it and lower its confidence. Do not guess digits.
3. Handwriting: ignore handwritten scribbles, ticks, signatures, stamps and notes, EXCEPT a clear handwritten correction that replaces a printed value (struck-through printed value with a new value written next to it). In that case return the corrected value, set its confidence at most 0.5 and mention it in "notes".
4. Numbers: plain JSON numbers in rupees, no commas or currency signs (1,23,456.50 -> 123456.5). Quantities may be decimal (2.5 kg). Negative only if printed negative (e.g. round-off -0.40).
5. Dates: normalise to YYYY-MM-DD. Indian dates are day first: 05/04/2026 is 5 April 2026.
6. GSTIN: exactly 15 characters, uppercase, no spaces: 2 digits (state), 5 letters, 4 digits, 1 letter, 1 letter-or-digit, the letter Z, 1 letter-or-digit. sellerGstin is the GSTIN of the business that issued the invoice (usually near its name at the top). buyerGstin is the GSTIN of the customer it is billed to ("Bill To", "Buyer", "Recipient", "M/s ..."). Read each character carefully; O vs 0, I vs 1, S vs 5, B vs 8 matter.
7. Header: vendorName = the issuing business's name as printed. invoiceNo = exactly as printed, including prefixes, slashes and dashes (e.g. "RD/2026-27/1043"). docType: "INV" for tax invoice / bill / bill of supply, "CRN" for credit note, "DBN" for debit note. irn = the 64-character IRN if printed, else null.
8. Lines, one per item row:
   - description: the item name as printed (keep pack size like "1kg", "500 ml").
   - hsn: HSN/SAC code digits as printed, else null.
   - qty: quantity as printed (number). unit: unit as printed (KG, PCS, BOX, LTR, ...), else null.
   - mrp: MRP column if printed, else null.
   - rate: the per-unit rate exactly as printed in the rate/price column.
   - rateIncludesTax: true only if that printed rate already includes GST (typical on retail/thermal bills where qty x rate = the line amount including GST, or the column says "Rate (Incl. Tax)"); false if the rate is before tax; null if you cannot tell.
   - discount: the line discount AMOUNT in rupees if printed. If only a discount PERCENT is printed, put it in discountPercent and leave discount null.
   - gstRate: the total GST percent for the line (CGST% + SGST%, or IGST%). Example: CGST 9% + SGST 9% -> 18. If the invoice only shows the rate in a tax summary table per HSN, use that rate for the matching lines.
   - taxable: the line's taxable value column if printed, else null. tax: the line's GST amount column if printed, else null.
   - amount: the line amount / total column exactly as printed.
   - box: bounding box of the whole row on its page, normalised 0..1 of the page image (x, y = top-left corner; w, h = width, height); page = 0-based index of the image.
   - confidence: 0..1, how sure you are of this row overall.
9. amountIncludesTax: true if the line "amount" column includes GST, false if it is before GST (the GST is added below the table), null if unsure.
10. Totals (from the totals area, as printed; null if not printed): taxable (total taxable value), cgst, sgst, igst (total tax amounts), otherCharges (freight, packing, cartage, delivery charges; sum if several), discount (invoice-level discount after the table, positive number), roundOff (signed, e.g. -0.40 or 0.35), grandTotal (final invoice value / net amount payable).
11. confidence: for each header field and each totals field, 0..1. Use 0.95+ only when the print is sharp and unambiguous; 0.5 or less when partly unreadable.
12. notes: short remarks a checker should know (handwritten correction, torn or cut-off area, unreadable row, page missing). Empty list if none.

Answer with JSON only, matching the response schema.`;

type S = Record<string, unknown>;
const num = (description?: string): S => ({ type: "NUMBER", nullable: true, ...(description ? { description } : {}) });
const str = (description?: string): S => ({ type: "STRING", nullable: true, ...(description ? { description } : {}) });

const CONF_KEYS = ["vendorName", "sellerGstin", "buyerGstin", "invoiceNo", "invoiceDate", "irn", "docType", "taxable", "cgst", "sgst", "igst", "otherCharges", "discount", "roundOff", "grandTotal"];

/** Gemini responseSchema (OpenAPI subset). Mapped to RawExtraction by parseGeminiPayload. */
export const RESPONSE_SCHEMA: S = {
  type: "OBJECT",
  properties: {
    header: {
      type: "OBJECT",
      properties: {
        vendorName: str(),
        sellerGstin: str("15 characters, uppercase"),
        buyerGstin: str("15 characters, uppercase"),
        invoiceNo: str("exactly as printed"),
        invoiceDate: str("YYYY-MM-DD"),
        irn: str(),
        docType: { type: "STRING", nullable: true, enum: ["INV", "CRN", "DBN"] },
      },
      propertyOrdering: ["vendorName", "sellerGstin", "buyerGstin", "invoiceNo", "invoiceDate", "irn", "docType"],
    },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" },
          hsn: str(),
          qty: num(),
          unit: str(),
          mrp: num(),
          rate: num("per-unit rate as printed"),
          rateIncludesTax: { type: "BOOLEAN", nullable: true },
          discount: num("line discount amount in rupees"),
          discountPercent: num(),
          gstRate: num("total GST percent"),
          taxable: num(),
          tax: num(),
          amount: num("line amount as printed"),
          box: {
            type: "OBJECT",
            nullable: true,
            properties: { page: { type: "INTEGER" }, x: { type: "NUMBER" }, y: { type: "NUMBER" }, w: { type: "NUMBER" }, h: { type: "NUMBER" } },
            required: ["page", "x", "y", "w", "h"],
            propertyOrdering: ["page", "x", "y", "w", "h"],
          },
          confidence: { type: "NUMBER" },
        },
        required: ["description", "qty", "rate", "amount", "confidence"],
        propertyOrdering: ["description", "hsn", "qty", "unit", "mrp", "rate", "rateIncludesTax", "discount", "discountPercent", "gstRate", "taxable", "tax", "amount", "box", "confidence"],
      },
    },
    amountIncludesTax: { type: "BOOLEAN", nullable: true },
    totals: {
      type: "OBJECT",
      properties: { taxable: num(), cgst: num(), sgst: num(), igst: num(), otherCharges: num(), discount: num(), roundOff: num(), grandTotal: num() },
      propertyOrdering: ["taxable", "cgst", "sgst", "igst", "otherCharges", "discount", "roundOff", "grandTotal"],
    },
    confidence: {
      type: "OBJECT",
      properties: Object.fromEntries(CONF_KEYS.map((k) => [k, { type: "NUMBER", nullable: true }])),
      propertyOrdering: CONF_KEYS,
    },
    notes: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["header", "lines", "totals", "confidence"],
  propertyOrdering: ["header", "lines", "amountIncludesTax", "totals", "confidence", "notes"],
};

export const TOTALS_KEYS = ["taxable", "cgst", "sgst", "igst", "otherCharges", "discount", "roundOff", "grandTotal"];
