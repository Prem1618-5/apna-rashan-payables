import type { FileOptions, PayableBill, Vendor } from "../src/index.js";

export const vendors: Vendor[] = [
  {
    id: "V001",
    name: "Shree Ganesh Traders",
    accountNumber: "50200012345678",
    ifsc: "SBIN0001234",
    email: "accounts@ganeshtraders.example",
    bankName: "State Bank of India",
    branchName: "Main Road Ranchi",
  },
  {
    id: "V002",
    name: "Jharkhand Dairy Pvt. Ltd.",
    accountNumber: "00601110000123",
    ifsc: "HDFC0000060",
    beneCode: "JHDAIRY01",
  },
  {
    id: "V003",
    name: "Ranchi FMCG Distributors",
    accountNumber: "123456789012",
    ifsc: "ICIC0000456",
  },
];

/** The same distributor bills each store separately; the file must pay each vendor once. */
export const bills: PayableBill[] = [
  { vendorId: "V001", billNo: "SGT/1021", storeCode: "S1", amountPaise: 1_250_00 },
  { vendorId: "V001", billNo: "SGT/1022", storeCode: "S2", amountPaise: 3_499_50 },
  { vendorId: "V001", billNo: "SGT/1023", storeCode: "S3", amountPaise: 980_00 },
  { vendorId: "V002", billNo: "JD-77", storeCode: "S1", amountPaise: 15_000_00 },
  { vendorId: "V002", billNo: "CN-5", storeCode: "S1", amountPaise: -500_00 },
  { vendorId: "V003", billNo: "RFD9001", storeCode: "S4", amountPaise: 2_10_000_00 },
];

export const options: FileOptions = {
  clientCode: "ARAD01",
  valueDate: "2026-10-23",
  sequence: 1,
};
