import { describe, expect, it } from "vitest";
import { ENET_VENDOR_PAYMENT_V1, consolidate, generateBulkFile, type PaymentInstruction } from "../src/index.js";
import { bills, options, vendors } from "./fixtures.js";

function build() {
  const { instructions, errors } = consolidate(bills, vendors, "R2610230");
  expect(errors).toEqual([]);
  return instructions;
}

function okFile(instructions: PaymentInstruction[], opts = options) {
  const result = generateBulkFile(instructions, opts);
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result;
}

const rowsOf = (content: string) => content.split("\r\n").filter(Boolean).map((line) => line.split(","));

describe("consolidate", () => {
  it("makes one payment per vendor across stores, netting credit notes", () => {
    const ins = build();
    expect(ins.map((i) => [i.vendor.id, i.amountPaise, i.billRefs])).toEqual([
      ["V002", 14_500_00, ["JD-77", "CN-5"]],
      ["V003", 2_10_000_00, ["RFD9001"]],
      ["V001", 5_729_50, ["SGT/1021", "SGT/1022", "SGT/1023"]],
    ]);
    expect(ins.map((i) => i.customerRef)).toEqual(["R2610230001", "R2610230002", "R2610230003"]);
  });

  it("refuses the same bill twice", () => {
    const { errors } = consolidate([...bills, bills[0]!], vendors, "R1");
    expect(errors[0]?.message).toMatch(/appears twice/);
  });

  it("refuses a vendor whose credit notes cancel the bills", () => {
    const { errors } = consolidate(
      [
        { vendorId: "V001", billNo: "A", storeCode: "S1", amountPaise: 100_00 },
        { vendorId: "V001", billNo: "CN", storeCode: "S1", amountPaise: -100_00 },
      ],
      vendors,
      "R1",
    );
    expect(errors[0]?.message).toMatch(/nothing to pay/);
  });
});

describe("generateBulkFile", () => {
  it("writes exact rows in the 28-column layout", () => {
    const file = okFile(build());
    const rows = rowsOf(file.content);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveLength(ENET_VENDOR_PAYMENT_V1.columns.length);

    expect(file.content.split("\r\n")[2]).toBe(
      [
        "N", "", "50200012345678", "5729.50", "Shree Ganesh Traders", "", "",
        "", "", "", "", "",
        "R2610230003", "R2610230003",
        "BILLS SGT/1021 SGT/1022", "SGT/1023", "", "", "", "", "",
        "", "23/10/2026", "", "SBIN0001234",
        "State Bank of India", "Main Road Ranchi", "accounts@ganeshtraders.example",
      ].join(","),
    );
  });

  it("picks I for HDFC accounts, R from Rs 2 lakh, N otherwise", () => {
    const file = okFile(build());
    expect(file.rows.map((r) => [r.vendorId, r.txnType])).toEqual([
      ["V002", "I"],
      ["V003", "R"],
      ["V001", "N"],
    ]);
  });

  it("gives control totals to compare with what ENet shows before authorising", () => {
    const file = okFile(build());
    expect(file.control.count).toBe(3);
    expect(file.control.totalPaise).toBe(14_500_00 + 2_10_000_00 + 5_729_50);
    expect(file.control.total).toBe("230229.50");
    expect(file.control.byType.R).toEqual({ count: 1, totalPaise: 2_10_000_00 });
  });

  it("is ASCII, CRLF, no quotes, with the expected file name and a stable hash", () => {
    const a = okFile(build());
    const b = okFile(build());
    expect(a.content).toMatch(/^[\x20-\x7E\r\n]+$/);
    expect(a.content.endsWith("\r\n")).toBe(true);
    expect(a.content).not.toContain('"');
    expect(a.fileName).toBe("ARAD012310.001");
    expect(a.sha256).toBe(b.sha256);
  });

  it("removes commas and other unsafe characters instead of shifting columns", () => {
    const ins = build();
    ins[2]!.vendor = { ...ins[2]!.vendor, name: 'Shree Ganesh, Traders "Main"' };
    const file = okFile(ins);
    const row = rowsOf(file.content)[2]!;
    expect(row).toHaveLength(28);
    expect(row[4]).toBe("Shree Ganesh Traders Main");
    expect(file.warnings.some((w) => w.field === "beneName")).toBe(true);
  });

  it("rejects the whole file and lists every problem", () => {
    const ins = build();
    ins[0]!.vendor = { ...ins[0]!.vendor, beneCode: undefined };
    ins[1]!.vendor = { ...ins[1]!.vendor, ifsc: "ICIC000456" };
    ins[2]!.amountPaise = 0;
    const result = generateBulkFile(ins, options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.vendorId, e.field])).toEqual([
      ["V002", "beneCode"],
      ["V003", "ifsc"],
      ["V001", "amount"],
    ]);
  });

  it("rejects duplicate references, vendors and shared account numbers", () => {
    const ins = build();
    const dupe = { ...ins[0]!, vendor: { ...ins[0]!.vendor, id: "V999" } };
    const result = generateBulkFile([...ins, dupe], options);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.errors.map((e) => e.message).join("\n");
    expect(messages).toMatch(/used twice/);
    expect(messages).toMatch(/same account number/);
  });

  it("rejects bad run settings", () => {
    const result = generateBulkFile(build(), { ...options, clientCode: "", sequence: 1000, valueDate: "2026-02-30" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.field)).toEqual(["clientCode", "sequence", "valueDate"]);
  });

  it("enforces an optional per-payment limit", () => {
    const result = generateBulkFile(build(), { ...options, maxAmountPaise: 1_00_000_00 });
    expect(result.ok).toBe(false);
  });

  it("drops an invalid email with a warning rather than failing", () => {
    const ins = build();
    ins[2]!.vendor = { ...ins[2]!.vendor, email: "not-an-email" };
    const file = okFile(ins);
    expect(rowsOf(file.content)[2]![27]).toBe("");
    expect(file.warnings.some((w) => w.field === "beneEmail")).toBe(true);
  });

  it("refuses names that become empty (e.g. only Hindi script)", () => {
    const ins = build();
    ins[2]!.vendor = { ...ins[2]!.vendor, name: "श्री गणेश" };
    const result = generateBulkFile(ins, options);
    expect(result.ok).toBe(false);
  });
});
