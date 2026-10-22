/**
 * HDFC ENet bulk payment upload layout.
 *
 * HDFC does not publish this layout publicly; it is shared with ENet customers
 * through the portal and the relationship manager. This version follows the
 * widely used 28-column ENet vendor-payment layout. Before the first real
 * upload, compare it column by column with the template downloaded from your
 * ENet login and change only this file if anything differs.
 * See docs/design/hdfc-bulk-file.md.
 */

export type ColumnKey =
  | "txnType"
  | "beneCode"
  | "beneAccount"
  | "amount"
  | "beneName"
  | "draweeLocation"
  | "printLocation"
  | "beneAddr1"
  | "beneAddr2"
  | "beneAddr3"
  | "beneAddr4"
  | "beneAddr5"
  | "instructionRef"
  | "customerRef"
  | "payDetails1"
  | "payDetails2"
  | "payDetails3"
  | "payDetails4"
  | "payDetails5"
  | "payDetails6"
  | "payDetails7"
  | "chequeNumber"
  | "txnDate"
  | "micr"
  | "ifsc"
  | "beneBankName"
  | "beneBranchName"
  | "beneEmail";

export interface ColumnSpec {
  key: ColumnKey;
  label: string;
  maxLength: number;
  /** What to do when a value is too long: shorten it (with a warning) or refuse the file. */
  overflow: "truncate" | "error";
}

export interface LayoutSpec {
  id: string;
  columns: ColumnSpec[];
  delimiter: string;
  lineEnding: "\r\n" | "\n";
  trailingNewline: boolean;
  headerRow: boolean;
  maxFileBytes: number;
  /** {CLIENT} {DD} {MM} {YYYY} {SEQ} are replaced. */
  fileNamePattern: string;
}

const col = (key: ColumnKey, label: string, maxLength: number, overflow: ColumnSpec["overflow"] = "truncate"): ColumnSpec => ({
  key,
  label,
  maxLength,
  overflow,
});

export const ENET_VENDOR_PAYMENT_V1: LayoutSpec = {
  id: "hdfc-enet-vendor-payment-v1",
  columns: [
    col("txnType", "Transaction Type", 1, "error"),
    col("beneCode", "Beneficiary Code", 13, "error"),
    col("beneAccount", "Beneficiary Account Number", 25, "error"),
    col("amount", "Instrument Amount", 20, "error"),
    col("beneName", "Beneficiary Name", 40),
    col("draweeLocation", "Drawee Location", 20),
    col("printLocation", "Print Location", 20),
    col("beneAddr1", "Bene Address 1", 70),
    col("beneAddr2", "Bene Address 2", 70),
    col("beneAddr3", "Bene Address 3", 70),
    col("beneAddr4", "Bene Address 4", 70),
    col("beneAddr5", "Bene Address 5", 70),
    col("instructionRef", "Instruction Reference Number", 20, "error"),
    col("customerRef", "Customer Reference Number", 20, "error"),
    col("payDetails1", "Payment details 1", 30),
    col("payDetails2", "Payment details 2", 30),
    col("payDetails3", "Payment details 3", 30),
    col("payDetails4", "Payment details 4", 30),
    col("payDetails5", "Payment details 5", 30),
    col("payDetails6", "Payment details 6", 30),
    col("payDetails7", "Payment details 7", 30),
    col("chequeNumber", "Cheque Number", 12, "error"),
    col("txnDate", "Chq / Trn Date", 10, "error"),
    col("micr", "MICR Number", 15, "error"),
    col("ifsc", "IFC Code", 11, "error"),
    col("beneBankName", "Bene Bank Name", 100),
    col("beneBranchName", "Bene Bank Branch Name", 40),
    col("beneEmail", "Beneficiary email id", 100, "error"),
  ],
  // Same shape Excel produces when HDFC's template is saved as CSV: no header,
  // no quoting (so commas are removed from values), CRLF line endings.
  delimiter: ",",
  lineEnding: "\r\n",
  trailingNewline: true,
  headerRow: false,
  maxFileBytes: 2 * 1024 * 1024,
  fileNamePattern: "{CLIENT}{DD}{MM}.{SEQ}",
};
