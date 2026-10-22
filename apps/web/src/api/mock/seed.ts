/** Realistic, deterministic demo data: 6 Ranchi stores, 30 vendors, ~26 invoices across every state. */
import type { EInvoiceQr, FieldMeta, InvoiceLine, InvoiceTotals, LineField, Store } from "@arad/core";
import { computeLine, gstinCheckChar } from "@arad/core";
import type { Db, DbBank, DbInvoice, DbUser, DbVendor } from "./db";
import { rowBox, type PaperBill, type PaperLine } from "./invoice-svg";

export const DAY = 86_400_000;
export function isoDay(offsetDays = 0, from = Date.now()): string {
  const d = new Date(from + offsetDays * DAY);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
export const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return isoDay(0, new Date(y, m - 1, d + n, 12).getTime());
};

export function makeRng(seed: number) {
  let s = seed >>> 0 || 7;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gstin(state: string, pan: string, entity = "1"): string {
  const first = `${state}${pan}${entity}Z`;
  return first + gstinCheckChar(first);
}

const OUR_PAN = "AAQFA4321K";
export const STORES: Store[] = [
  { id: "st_mrd", code: "MRD", name: "Main Road", address: "Main Road, near Firayalal Chowk, Ranchi 834001" },
  { id: "st_llp", code: "LLP", name: "Lalpur", address: "Lalpur Chowk, Ranchi 834001" },
  { id: "st_hrm", code: "HRM", name: "Harmu", address: "Harmu Housing Colony, Ranchi 834002" },
  { id: "st_knk", code: "KNK", name: "Kanke Road", address: "Kanke Road, Ranchi 834008" },
  { id: "st_drd", code: "DRD", name: "Doranda", address: "Doranda Bazar, Ranchi 834002" },
  { id: "st_brb", code: "BRB", name: "Bariatu", address: "Bariatu Road, Ranchi 834009" },
].map((s, i) => ({ ...s, gstin: gstin("20", OUR_PAN, String(i + 1)) }));

export const USERS: DbUser[] = [
  { id: "u_owner", name: "Rajesh Agarwal", phone: "9000000001", pin: "1234", role: "owner", storeIds: STORES.map((s) => s.id), active: true, lang: "en" },
  { id: "u_sunita", name: "Sunita Kumari", phone: "9000000002", pin: "1111", role: "staff", storeIds: ["st_mrd", "st_llp"], active: true, lang: "hi" },
  { id: "u_amit", name: "Amit Oraon", phone: "9000000003", pin: "2222", role: "staff", storeIds: ["st_hrm"], active: true, lang: "hi" },
  { id: "u_pooja", name: "Pooja Singh", phone: "9000000004", pin: "3333", role: "staff", storeIds: ["st_knk"], active: true, lang: "en" },
  { id: "u_ravi", name: "Ravi Mahto", phone: "9000000005", pin: "4444", role: "staff", storeIds: ["st_drd", "st_brb"], active: true, lang: "hi" },
  { id: "u_neha", name: "Neha Verma", phone: "9000000006", pin: "5555", role: "staff", storeIds: STORES.map((s) => s.id), active: true, lang: "en" },
];

interface Product {
  d: string;
  hsn: string;
  unit: string;
  mrp: number;
  gst: number;
}
const CATALOGUE: Record<string, Product[]> = {
  staples: [
    { d: "Atta Chakki Fresh 10kg", hsn: "1101", unit: "BAG", mrp: 48500, gst: 500 },
    { d: "Basmati Rice Premium 5kg", hsn: "1006", unit: "BAG", mrp: 69900, gst: 500 },
    { d: "Toor Dal 1kg", hsn: "0713", unit: "PCS", mrp: 17900, gst: 500 },
    { d: "Mustard Oil Kachi Ghani 1L", hsn: "1514", unit: "PCS", mrp: 19500, gst: 500 },
    { d: "Sugar 1kg", hsn: "1701", unit: "KG", mrp: 4800, gst: 500 },
    { d: "Iodised Salt 1kg", hsn: "2501", unit: "PCS", mrp: 2800, gst: 0 },
    { d: "Besan 1kg", hsn: "1106", unit: "PCS", mrp: 11000, gst: 500 },
    { d: "Poha Medium 1kg", hsn: "1904", unit: "PCS", mrp: 7500, gst: 500 },
    { d: "Sona Masoori Rice 25kg", hsn: "1006", unit: "BAG", mrp: 162500, gst: 500 },
  ],
  fmcg: [
    { d: "Tomato Ketchup 950g", hsn: "2103", unit: "PCS", mrp: 14500, gst: 500 },
    { d: "Glucose Biscuits 800g", hsn: "1905", unit: "PCS", mrp: 9000, gst: 500 },
    { d: "Detergent Powder 1kg", hsn: "3402", unit: "PCS", mrp: 13000, gst: 1800 },
    { d: "Bath Soap 4x100g", hsn: "3401", unit: "PCK", mrp: 18000, gst: 500 },
    { d: "Toothpaste 150g", hsn: "3306", unit: "PCS", mrp: 11500, gst: 500 },
    { d: "Instant Noodles 12-pack", hsn: "1902", unit: "PCK", mrp: 16800, gst: 500 },
    { d: "Hair Oil Coconut 500ml", hsn: "3305", unit: "PCS", mrp: 21000, gst: 500 },
    { d: "Dishwash Bar 3x200g", hsn: "3402", unit: "PCK", mrp: 6000, gst: 1800 },
  ],
  tea: [
    { d: "Assam Tea Dust 1kg", hsn: "0902", unit: "PCS", mrp: 52000, gst: 500 },
    { d: "Darjeeling Leaf Tea 250g", hsn: "0902", unit: "PCS", mrp: 32000, gst: 500 },
    { d: "Masala Chai 500g", hsn: "0902", unit: "PCS", mrp: 29000, gst: 500 },
    { d: "Green Tea Bags 100", hsn: "0902", unit: "BOX", mrp: 45000, gst: 500 },
  ],
  dairy: [
    { d: "Toned Milk 500ml", hsn: "0401", unit: "PCS", mrp: 2800, gst: 0 },
    { d: "Paneer Fresh 200g", hsn: "0406", unit: "PCS", mrp: 9000, gst: 0 },
    { d: "Dahi Cup 400g", hsn: "0403", unit: "PCS", mrp: 4500, gst: 0 },
    { d: "Pure Ghee 1L", hsn: "0405", unit: "PCS", mrp: 64000, gst: 500 },
    { d: "Butter 100g", hsn: "0405", unit: "PCS", mrp: 5800, gst: 500 },
  ],
  oil: [
    { d: "Mustard Oil 15L Tin", hsn: "1514", unit: "TIN", mrp: 245000, gst: 500 },
    { d: "Refined Soyabean Oil 1L", hsn: "1507", unit: "PCS", mrp: 16500, gst: 500 },
    { d: "Groundnut Oil 5L", hsn: "1508", unit: "CAN", mrp: 99000, gst: 500 },
  ],
  spices: [
    { d: "Turmeric Powder 200g", hsn: "0910", unit: "PCS", mrp: 6800, gst: 500 },
    { d: "Red Chilli Powder 200g", hsn: "0904", unit: "PCS", mrp: 8200, gst: 500 },
    { d: "Garam Masala 100g", hsn: "0910", unit: "PCS", mrp: 9500, gst: 500 },
    { d: "Jeera Whole 500g", hsn: "0909", unit: "PCS", mrp: 31000, gst: 500 },
    { d: "Coriander Powder 500g", hsn: "0909", unit: "PCS", mrp: 12000, gst: 500 },
  ],
  snacks: [
    { d: "Aloo Bhujia 400g", hsn: "2106", unit: "PCS", mrp: 11000, gst: 500 },
    { d: "Cream Biscuits 300g", hsn: "1905", unit: "PCS", mrp: 4000, gst: 500 },
    { d: "Potato Chips 90g", hsn: "2005", unit: "PCS", mrp: 2000, gst: 500 },
    { d: "Mixture Namkeen 1kg", hsn: "2106", unit: "PCS", mrp: 24000, gst: 500 },
    { d: "Rusk Toast 300g", hsn: "1905", unit: "PCS", mrp: 5500, gst: 500 },
  ],
  beverages: [
    { d: "Cola 2.25L", hsn: "2202", unit: "PCS", mrp: 11000, gst: 4000 },
    { d: "Mango Drink 1.2L", hsn: "2202", unit: "PCS", mrp: 7500, gst: 500 },
    { d: "Packaged Water 1L x12", hsn: "2201", unit: "CTN", mrp: 24000, gst: 500 },
    { d: "Soda 750ml", hsn: "2202", unit: "PCS", mrp: 4000, gst: 4000 },
  ],
  homecare: [
    { d: "Floor Cleaner 1L", hsn: "3402", unit: "PCS", mrp: 19900, gst: 1800 },
    { d: "Detergent Cake 250g", hsn: "3401", unit: "PCS", mrp: 1500, gst: 500 },
    { d: "Toilet Cleaner 500ml", hsn: "3402", unit: "PCS", mrp: 9900, gst: 1800 },
  ],
  misc: [
    { d: "Agarbatti Sandal 100 sticks", hsn: "3307", unit: "PCK", mrp: 6000, gst: 500 },
    { d: "Carry Bag Medium 1kg", hsn: "3923", unit: "KG", mrp: 22000, gst: 1800 },
    { d: "Forest Honey 500g", hsn: "0409", unit: "PCS", mrp: 32000, gst: 500 },
  ],
  rice: [
    { d: "Sona Masoori Rice 25kg", hsn: "1006", unit: "BAG", mrp: 162500, gst: 500 },
    { d: "Kolam Rice 25kg", hsn: "1006", unit: "BAG", mrp: 185000, gst: 500 },
    { d: "Parboiled Rice 25kg", hsn: "1006", unit: "BAG", mrp: 120000, gst: 500 },
  ],
  dal: [
    { d: "Moong Dal 1kg", hsn: "0713", unit: "PCS", mrp: 15500, gst: 500 },
    { d: "Chana Dal 1kg", hsn: "0713", unit: "PCS", mrp: 11000, gst: 500 },
    { d: "Masoor Dal 1kg", hsn: "0713", unit: "PCS", mrp: 12500, gst: 500 },
    { d: "Urad Dal 1kg", hsn: "0713", unit: "PCS", mrp: 16000, gst: 500 },
  ],
};

interface VendorSeed {
  name: string;
  state: string;
  cat: keyof typeof CATALOGUE;
  terms: number;
  ifsc?: string;
  beneCode?: string;
  status?: DbVendor["status"];
  city: string;
  /** "pendingChange": approved old + pending new; "pendingNew": only a pending one; "cooling": approved hours ago; "recent": approved 2 days ago */
  bankCase?: "pendingChange" | "pendingNew" | "cooling" | "recent";
  prefix: string;
}

const V: VendorSeed[] = [
  { name: "Shree Balaji Traders", state: "20", cat: "staples", terms: 15, ifsc: "SBIN0001792", city: "Upper Bazar, Ranchi, Jharkhand 834001", prefix: "SBT/26-27/" },
  { name: "Maa Tara Distributors", state: "20", cat: "fmcg", terms: 21, ifsc: "HDFC0000466", beneCode: "MAATARA01", city: "Kokar Industrial Area, Ranchi 834001", prefix: "MTD-" },
  { name: "Bengal Tea House", state: "19", cat: "tea", terms: 30, ifsc: "UTIB0000034", city: "Burrabazar, Kolkata, West Bengal 700007", prefix: "BTH/" },
  { name: "Jharkhand Agro Foods Pvt Ltd", state: "20", cat: "staples", terms: 30, ifsc: "ICIC0001553", city: "Tupudana Industrial Area, Ranchi 835221", prefix: "JAF/" },
  { name: "Ranchi Dairy Products", state: "20", cat: "dairy", terms: 7, ifsc: "BKID0004510", city: "Hotwar, Ranchi 835217", prefix: "RDP" },
  { name: "Gupta Oil Mills", state: "20", cat: "oil", terms: 15, ifsc: "PUNB0247800", city: "Ratu Road, Ranchi 834005", prefix: "GOM/" },
  { name: "Patliputra Spices", state: "10", cat: "spices", terms: 30, ifsc: "CNRB0003121", city: "Bazar Samiti, Patna, Bihar 800006", prefix: "PS-" },
  { name: "Kanke Fresh Farms", state: "20", cat: "dairy", terms: 7, city: "Kanke, Ranchi 834006", prefix: "KFF" },
  { name: "Singh Brothers Wholesale", state: "20", cat: "fmcg", terms: 21, ifsc: "HDFC0001213", beneCode: "SINGHBRO", city: "Daily Market, Ranchi 834001", prefix: "SBW/" },
  { name: "Annapurna Atta Udyog", state: "20", cat: "staples", terms: 15, ifsc: "BARB0RANCHI", city: "Namkum, Ranchi 834010", prefix: "AAU/" },
  { name: "Bajrang Masala Co", state: "20", cat: "spices", terms: 30, ifsc: "UBIN0531448", city: "Doranda, Ranchi 834002", prefix: "BMC-" },
  { name: "Sai Beverages", state: "20", cat: "beverages", terms: 15, ifsc: "KKBK0005893", bankCase: "pendingChange", city: "Argora, Ranchi 834002", prefix: "SB/" },
  { name: "Durga Biscuit Agency", state: "20", cat: "snacks", terms: 21, ifsc: "SBIN0006655", city: "Hinoo, Ranchi 834002", prefix: "DBA" },
  { name: "Tirupati Rice Mill", state: "22", cat: "rice", terms: 30, ifsc: "SBIN0004290", city: "Raipur, Chhattisgarh 492001", prefix: "TRM/" },
  { name: "Mahavir Pulses", state: "23", cat: "dal", terms: 30, ifsc: "HDFC0002741", beneCode: "MAHAVIRP", city: "Indore, Madhya Pradesh 452002", prefix: "MP/" },
  { name: "Laxmi Home Care", state: "20", cat: "homecare", terms: 30, ifsc: "ICIC0006218", city: "Bariatu, Ranchi 834009", prefix: "LHC" },
  { name: "Ganesh Namkeen Bhandar", state: "20", cat: "snacks", terms: 7, ifsc: "PUNB0110200", city: "Main Road, Ranchi 834001", prefix: "GNB-" },
  { name: "Om Sai Plastics", state: "20", cat: "misc", terms: 30, ifsc: "CNRB0008841", city: "Pundag, Ranchi 834004", prefix: "OSP/" },
  { name: "Kolkata Snacks Co", state: "19", cat: "snacks", terms: 21, ifsc: "UTIB0002456", city: "Howrah, West Bengal 711101", prefix: "KSC/" },
  { name: "Utkal Salt Works", state: "21", cat: "staples", terms: 30, ifsc: "SBIN0010321", city: "Ganjam, Odisha 761001", prefix: "USW" },
  { name: "Hazaribagh Honey House", state: "20", cat: "misc", terms: 15, ifsc: "BKID0004466", status: "PENDING", bankCase: "pendingNew", city: "Hazaribagh, Jharkhand 825301", prefix: "HHH" },
  { name: "Morabadi Eggs and Poultry", state: "20", cat: "dairy", terms: 7, status: "PENDING", city: "Morabadi, Ranchi 834008", prefix: "MEP" },
  { name: "Shubham Agencies", state: "20", cat: "fmcg", terms: 21, ifsc: "HDFC0000221", beneCode: "SHUBHAMAG", bankCase: "recent", city: "Harmu Road, Ranchi 834002", prefix: "SA/" },
  { name: "Pragati Paper Products", state: "20", cat: "misc", terms: 30, ifsc: "UBIN0554328", status: "BLOCKED", city: "Namkum, Ranchi 834010", prefix: "PPP" },
  { name: "Dhanbad Cold Drinks", state: "20", cat: "beverages", terms: 15, ifsc: "IDIB000R012", city: "Bank More, Dhanbad 826001", prefix: "DCD/" },
  { name: "Ashirwad Ghee Bhandar", state: "20", cat: "dairy", terms: 15, ifsc: "SBIN0003654", city: "Lalpur, Ranchi 834001", prefix: "AGB" },
  { name: "Royal Dry Fruits", state: "07", cat: "misc", terms: 30, ifsc: "YESB0000187", city: "Khari Baoli, Delhi 110006", prefix: "RDF/" },
  { name: "New Bharat Soap Works", state: "09", cat: "homecare", terms: 30, ifsc: "PUNB0365400", bankCase: "cooling", city: "Kanpur, Uttar Pradesh 208001", prefix: "NBSW" },
  { name: "Krishna Flour Mill", state: "20", cat: "staples", terms: 15, ifsc: "CBIN0281234", city: "Tatisilwai, Ranchi 835103", prefix: "KFM/" },
  { name: "Lalpur Vegetable Supply", state: "20", cat: "misc", terms: 3, ifsc: "SBIN0007788", city: "Lalpur, Ranchi 834001", prefix: "LVS" },
];

const BANK_NAMES: Record<string, string> = {
  SBIN: "State Bank of India", HDFC: "HDFC Bank", UTIB: "Axis Bank", ICIC: "ICICI Bank", BKID: "Bank of India", PUNB: "Punjab National Bank",
  CNRB: "Canara Bank", BARB: "Bank of Baroda", UBIN: "Union Bank of India", KKBK: "Kotak Mahindra Bank", IDIB: "Indian Bank", YESB: "Yes Bank", CBIN: "Central Bank of India",
};

function panFor(name: string, i: number, rnd: () => number): string {
  const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pick = () => L[Math.floor(rnd() * 26)]!;
  const type = /Pvt Ltd|Co$/.test(name) ? "C" : "F";
  return `${pick()}${pick()}${pick()}${type}${name[0]!.toUpperCase()}${String(1000 + ((i * 7919) % 9000)).padStart(4, "0")}${pick()}`;
}

export function money2(rupees: number) {
  return Math.round(rupees * 100);
}

function line(p: Product, qty: number, opts: { discountPaise?: number; rateFactor?: number } = {}): PaperLine {
  // Trade rate: MRP minus retailer margin, before GST.
  const ratePaise = Math.round((p.mrp / (1 + p.gst / 10000)) * (opts.rateFactor ?? 0.84));
  const discountPaise = opts.discountPaise ?? 0;
  const c = computeLine({ qtyMilli: qty * 1000, ratePaise, discountPaise, gstRateBp: p.gst });
  return { description: p.d, hsn: p.hsn, qtyMilli: qty * 1000, unit: p.unit, mrpPaise: p.mrp, ratePaise, discountPaise, gstRateBp: p.gst, ...c };
}

function fixedLine(d: string, hsn: string, qty: number, unit: string, mrp: number, rate: number, disc: number, gst: number): PaperLine {
  const c = computeLine({ qtyMilli: qty * 1000, ratePaise: rate, discountPaise: disc, gstRateBp: gst });
  return { description: d, hsn, qtyMilli: qty * 1000, unit, mrpPaise: mrp, ratePaise: rate, discountPaise: disc, gstRateBp: gst, ...c };
}

export function totalsFor(lines: PaperLine[], interState: boolean, extra: Partial<InvoiceTotals> = {}): InvoiceTotals {
  const taxable = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const tax = lines.reduce((s, l) => s + l.taxPaise, 0);
  const sum = lines.reduce((s, l) => s + l.totalPaise, 0);
  const other = extra.otherChargesPaise ?? 0;
  const disc = extra.discountPaise ?? 0;
  const raw = sum + other - disc;
  const grand = Math.round(raw / 100) * 100;
  const cgst = interState ? 0 : Math.floor(tax / 2);
  return {
    taxablePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: interState ? 0 : tax - cgst,
    igstPaise: interState ? tax : 0,
    otherChargesPaise: other,
    discountPaise: disc,
    roundOffPaise: grand - raw,
    grandTotalPaise: grand,
  };
}

export function hexId(rnd: () => number, len = 64) {
  let s = "";
  for (let i = 0; i < len; i++) s += "0123456789abcdef"[Math.floor(rnd() * 16)];
  return s;
}

export interface BillSpec {
  id: string;
  vendor: DbVendor;
  vendorSeed: { city: string; state: string };
  store: Store;
  invoiceNo: string;
  invoiceDate: string;
  lines: PaperLine[];
  docType?: "INV" | "CRN";
  qr?: boolean;
  seed: number;
}

export function paperFor(spec: BillSpec): PaperBill {
  const inter = spec.vendorSeed.state !== "20";
  return {
    vendorName: spec.vendor.name,
    vendorAddress: [spec.vendorSeed.city],
    vendorPhone: spec.vendor.phone,
    sellerGstin: spec.vendor.gstin,
    buyerName: `Apna Rashan Apni Dukan - ${spec.store.name}`,
    buyerAddress: spec.store.address ?? "Ranchi",
    buyerGstin: spec.store.gstin,
    invoiceNo: spec.invoiceNo,
    invoiceDate: spec.invoiceDate,
    docType: spec.docType ?? "INV",
    lines: spec.lines,
    totals: totalsFor(spec.lines, inter),
    irn: spec.qr ? hexId(makeRng(spec.seed + 99)) : undefined,
    seed: spec.seed,
  };
}

/** Turn what's on paper into what the extractors "read" (exact by default). */
export function extractedLines(paper: PaperBill, invoiceId: string, opts: { skip?: number[]; tweak?: (l: InvoiceLine, paperIdx: number) => void } = {}): InvoiceLine[] {
  const out: InvoiceLine[] = [];
  paper.lines.forEach((p, i) => {
    if (opts.skip?.includes(i)) return;
    const l: InvoiceLine = {
      id: `${invoiceId}_l${i + 1}`,
      idx: out.length,
      description: p.description,
      hsn: p.hsn,
      qtyMilli: p.qtyMilli,
      unit: p.unit,
      mrpPaise: p.mrpPaise,
      ratePaise: p.ratePaise,
      discountPaise: p.discountPaise,
      gstRateBp: p.gstRateBp,
      taxablePaise: p.taxablePaise,
      taxPaise: p.taxPaise,
      totalPaise: p.totalPaise,
      status: "pending",
      box: rowBox(i),
    };
    opts.tweak?.(l, i);
    out.push(l);
  });
  return out;
}

export function qrFor(paper: PaperBill, itemCount = paper.lines.length): EInvoiceQr | undefined {
  if (!paper.irn) return undefined;
  return {
    sellerGstin: paper.sellerGstin ?? "",
    buyerGstin: paper.buyerGstin ?? "",
    docNo: paper.invoiceNo,
    docType: paper.docType,
    docDate: paper.invoiceDate,
    totalPaise: paper.totals.grandTotalPaise,
    itemCount,
    mainHsn: paper.lines[0]?.hsn,
    irn: paper.irn,
  };
}

const meta = (confidence: number, sources?: Record<string, string>, reason?: string): FieldMeta => ({
  confidence,
  ...(sources ? { sources, flagged: true } : {}),
  ...(reason ? { reason } : {}),
});

export function baseInvoice(spec: BillSpec, capturedBy: string, createdAt: string): DbInvoice {
  const paper = paperFor(spec);
  const lines = extractedLines(paper, spec.id);
  return {
    id: spec.id,
    documentId: `doc_${spec.id.replace(/^inv_/, "")}`,
    storeId: spec.store.id,
    state: "NEEDS_VERIFICATION",
    vendorId: spec.vendor.id,
    header: {
      vendorName: paper.vendorName,
      sellerGstin: paper.sellerGstin,
      buyerGstin: paper.buyerGstin,
      invoiceNo: paper.invoiceNo,
      invoiceDate: paper.invoiceDate,
      irn: paper.irn,
      docType: paper.docType,
    },
    headerMeta: { vendorName: meta(0.97), sellerGstin: meta(0.99), invoiceNo: meta(0.96), invoiceDate: meta(0.95) },
    totals: { ...paper.totals },
    totalsMeta: { grandTotalPaise: meta(0.97) },
    lines,
    qr: qrFor(paper),
    lockAttempts: 0,
    paper,
    createdAt,
    capturedBy,
  };
}

export interface SeedResult {
  db: Db;
  /** Runs to build through the normal server logic once the base data exists. */
  runs: { state: "DRAFT" | "PAID"; invoiceIds: string[]; byUser: string; daysAgo: number }[];
}

export function seed(now = Date.now()): SeedResult {
  const rnd = makeRng(20261022);
  const today = isoDay(0, now);
  const ts = (daysAgo: number, hour = 11, min = 0) => {
    const d = new Date(now - daysAgo * DAY);
    d.setHours(hour, min, 0, 0);
    let t = d.getTime();
    // Never in the future: "today 10:41" seeded at 8 am becomes "a little while ago".
    if (t > now - 60_000) t = now - (4 + ((hour * 7 + min) % 70)) * 60_000;
    return new Date(t).toISOString();
  };

  const vendors: DbVendor[] = V.map((v, i) => {
    const pan = panFor(v.name, i, rnd);
    const id = `v_${String(i + 1).padStart(2, "0")}`;
    const bank: DbBank[] = [];
    if (v.ifsc) {
      const acct = String(Math.floor(10 ** 10 + rnd() * 9 * 10 ** 13)).slice(0, 11 + (i % 5));
      const bankName = BANK_NAMES[v.ifsc.slice(0, 4)];
      const approved: DbBank = {
        id: `bk_${id}_1`,
        version: 1,
        accountNumber: v.ifsc.startsWith("HDFC") ? `5020${String(acct).slice(0, 10)}` : acct,
        ifsc: v.ifsc,
        bankName,
        branchName: v.city.split(",")[0],
        beneCode: v.beneCode,
        status: "APPROVED",
        createdBy: "Rajesh Agarwal",
        createdAt: ts(120 - i),
        approvedBy: "Rajesh Agarwal",
        approvedAt: ts(119 - i),
        usableFrom: ts(118 - i),
      };
      if (v.bankCase === "pendingNew") {
        bank.push({ ...approved, status: "PENDING", createdBy: "Sunita Kumari", createdAt: ts(1, 15), approvedBy: undefined, approvedAt: undefined, usableFrom: undefined });
      } else if (v.bankCase === "cooling") {
        const at = new Date(now - 3 * 3600_000).toISOString();
        bank.push({ ...approved, status: "SUPERSEDED", accountNumber: acct.replace(/\d$/, "7") });
        bank.push({ ...approved, id: `bk_${id}_2`, version: 2, status: "APPROVED", createdAt: at, approvedAt: at, usableFrom: new Date(now + 21 * 3600_000).toISOString() });
      } else if (v.bankCase === "recent") {
        bank.push({ ...approved, status: "SUPERSEDED", accountNumber: `${approved.accountNumber.slice(0, -3)}118` });
        bank.push({ ...approved, id: `bk_${id}_2`, version: 2, createdAt: ts(3), approvedAt: ts(2), usableFrom: ts(1) });
      } else {
        bank.push(approved);
        if (v.bankCase === "pendingChange") {
          bank.push({
            ...approved,
            id: `bk_${id}_2`,
            version: 2,
            status: "PENDING",
            accountNumber: "39188812004417",
            ifsc: "SBIN0001792",
            bankName: "State Bank of India",
            branchName: "Main Branch Ranchi",
            createdBy: "Pooja Singh",
            createdAt: ts(0, 9, 40),
            approvedBy: undefined,
            approvedAt: undefined,
            usableFrom: undefined,
          });
        }
      }
    }
    const slug = v.name.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 12);
    return {
      id,
      name: v.name,
      tradeName: undefined,
      gstin: gstin(v.state, pan),
      pan,
      phone: `9${String(430000000 + Math.floor(rnd() * 99999999)).slice(0, 9)}`,
      email: i % 3 === 0 ? `accounts@${slug}.in` : undefined,
      paymentTermsDays: v.terms,
      status: v.status ?? "ACTIVE",
      createdAt: v.status === "PENDING" ? ts(1, 14) : ts(200 - i),
      bank,
    };
  });

  const vs = (i: number) => ({ vendor: vendors[i - 1]!, vendorSeed: V[i - 1]! });
  const st = (code: string) => STORES.find((s) => s.code === code)!;
  const cat = (i: number) => CATALOGUE[V[i - 1]!.cat]!;
  const invoices: DbInvoice[] = [];
  let seq = 1;
  const nextNo = (vi: number) => `${V[vi - 1]!.prefix}${String(1000 + Math.floor(rnd() * 8000))}`;
  const pickLines = (vi: number, n: number) => {
    const c = cat(vi);
    const start = Math.floor(rnd() * c.length);
    return Array.from({ length: Math.min(n, c.length) }, (_, k) => {
      const p = c[(start + k) % c.length]!;
      const qty = p.mrp > 100000 ? 2 + Math.floor(rnd() * 6) : 6 + Math.floor(rnd() * 30);
      return line(p, qty, { discountPaise: rnd() > 0.75 ? money2(10 * (1 + Math.floor(rnd() * 15))) : 0 });
    });
  };

  // ---- Demo bill 1: 8 lines, e-invoice QR, one misread quantity (the signature verify flow).
  {
    const id = "inv_demo1";
    const lines = [
      fixedLine("Atta Chakki Fresh 10kg", "1101", 10, "BAG", 48500, 39800, 0, 500),
      fixedLine("Basmati Rice Premium 5kg", "1006", 6, "BAG", 69900, 56000, 12000, 500),
      fixedLine("Toor Dal 1kg", "0713", 20, "PCS", 17900, 14250, 0, 500),
      fixedLine("Mustard Oil Kachi Ghani 1L", "1514", 12, "PCS", 19500, 15800, 0, 500),
      fixedLine("Sugar 1kg", "1701", 25, "KG", 4800, 4120, 0, 500),
      fixedLine("Iodised Salt 1kg", "2501", 30, "PCS", 2800, 2150, 0, 0),
      fixedLine("Assam Tea Dust 500g", "0902", 8, "PCS", 28500, 22600, 5000, 500),
      fixedLine("Poha Medium 1kg", "1904", 15, "PCS", 7500, 5840, 0, 500),
    ];
    const spec: BillSpec = { id, ...vs(1), store: st("MRD"), invoiceNo: "SBT/26-27/0412", invoiceDate: addDays(today, -1), lines, qr: true, seed: 11 };
    const inv = baseInvoice(spec, "Sunita Kumari", ts(0, 9, 12));
    inv.lines = extractedLines(inv.paper, id, {
      tweak: (l, i) => {
        if (i === 3) {
          l.qtyMilli = 72000; // OCR read "12" as "72"; the printed amount is right
          l.meta = { qtyMilli: { confidence: 0.52, flagged: true, reason: "Readers disagree", sources: { "Local OCR": "72", "AI reader": "12" } } };
        }
        if (i === 6) l.meta = { ratePaise: { confidence: 0.74, reason: "Faint print" }, discountPaise: { confidence: 0.78 } };
      },
    });
    inv.headerMeta.vendorName = { confidence: 0.71, flagged: true, reason: "Readers disagree", sources: { "Local OCR": "SHRI BALAJI TRADERS", "AI reader": "Shree Balaji Traders" } };
    invoices.push(inv);
  }
  // ---- Demo bill 2: extractor missed one of 6 lines -> balance hint "missing line".
  {
    const id = "inv_demo2";
    const c = CATALOGUE.fmcg!;
    const lines = [line(c[0]!, 24), line(c[1]!, 36, { discountPaise: 9000 }), line(c[2]!, 18), line(c[3]!, 20), line(c[4]!, 24), line(c[5]!, 10)];
    const spec: BillSpec = { id, ...vs(2), store: st("LLP"), invoiceNo: "MTD-2026-1187", invoiceDate: addDays(today, -2), lines, seed: 12 };
    const inv = baseInvoice(spec, "Sunita Kumari", ts(0, 10, 5));
    inv.lines = extractedLines(inv.paper, id, { skip: [4] });
    inv.headerMeta.invoiceDate = { confidence: 0.76, reason: "Date partly covered by stamp" };
    invoices.push(inv);
  }
  // ---- Demo bill 3: inter-state (IGST), clean.
  {
    const id = "inv_demo3";
    const c = CATALOGUE.tea!;
    const lines = [line(c[0]!, 12), line(c[1]!, 10), line(c[2]!, 16), line(c[3]!, 6)];
    invoices.push(baseInvoice({ id, ...vs(3), store: st("MRD"), invoiceNo: "BTH/1093", invoiceDate: addDays(today, -3), lines, qr: true, seed: 13 }, "Sunita Kumari", ts(0, 10, 41)));
  }
  // ---- Other bills waiting for verification at other stores.
  for (const [vi, code, n] of [
    [17, "HRM", 5],
    [5, "KNK", 3],
    [26, "DRD", 4],
  ] as const) {
    const id = `inv_${String(seq++).padStart(3, "0")}`;
    invoices.push(baseInvoice({ id, ...vs(vi), store: st(code), invoiceNo: nextNo(vi), invoiceDate: addDays(today, -1), lines: pickLines(vi, n), seed: 20 + seq }, "Amit Oraon", ts(0, 8 + seq, 20)));
  }
  // ---- Still being read (EXTRACTING).
  {
    const id = `inv_${String(seq++).padStart(3, "0")}`;
    const inv = baseInvoice({ id, ...vs(13), store: st("LLP"), invoiceNo: nextNo(13), invoiceDate: today, lines: pickLines(13, 4), seed: 40 }, "Sunita Kumari", new Date(now - 20_000).toISOString());
    inv.state = "EXTRACTING";
    inv.readyAt = new Date(now + 40_000).toISOString();
    invoices.push(inv);
  }

  // ---- Verified bills (payables), spread across due dates and stores.
  const verified = (vi: number, code: string, dueOffset: number, n: number, opts: { qtyScale?: number; doneToday?: boolean; by?: string; docType?: "CRN" } = {}) => {
    const id = `inv_${String(seq++).padStart(3, "0")}`;
    const v = vendors[vi - 1]!;
    const due = addDays(today, dueOffset);
    const invoiceDate = addDays(due, -v.paymentTermsDays);
    let lines = pickLines(vi, n);
    if (opts.qtyScale) {
      lines = lines.map((l) => {
        const q = Math.round((l.qtyMilli / 1000) * opts.qtyScale!) * 1000;
        const c = computeLine({ ...l, qtyMilli: q });
        return { ...l, qtyMilli: q, ...c };
      });
    }
    if (opts.docType === "CRN") lines = lines.slice(0, 1).map((l) => ({ ...l, qtyMilli: 2000, ...computeLine({ ...l, qtyMilli: 2000 }) }));
    const createdDaysAgo = opts.doneToday ? 0 : Math.max(1, -dueOffset + v.paymentTermsDays - 1);
    const inv = baseInvoice(
      { id, ...vs(vi), store: st(code), invoiceNo: opts.docType === "CRN" ? `CN/${String(100 + seq)}` : nextNo(vi), invoiceDate: invoiceDate > today ? today : invoiceDate, lines, docType: opts.docType, seed: 50 + seq },
      opts.by ?? "Sunita Kumari",
      ts(createdDaysAgo, 9 + (seq % 8), (seq * 7) % 60),
    );
    inv.state = "VERIFIED";
    inv.lines.forEach((l) => (l.status = "accepted"));
    inv.lockedTotalPaise = inv.totals.grandTotalPaise;
    inv.lockAttempts = 1;
    inv.verifiedBy = opts.by ?? "Sunita Kumari";
    inv.verifiedAt = opts.doneToday ? ts(0, 9, 30 + (seq % 20)) : ts(createdDaysAgo, 17);
    inv.verifyMs = 60_000 + Math.floor(rnd() * 90_000);
    inv.dueDate = due;
    invoices.push(inv);
    return inv;
  };

  verified(1, "LLP", -4, 6);
  verified(1, "HRM", -1, 5);
  verified(1, "DRD", 2, 4);
  verified(2, "MRD", 0, 5);
  verified(4, "MRD", 3, 6, { qtyScale: 7 });
  verified(4, "KNK", 5, 5, { qtyScale: 5 });
  verified(9, "MRD", -2, 5);
  verified(9, "BRB", 4, 4);
  verified(9, "MRD", 4, 1, { docType: "CRN" });
  verified(7, "HRM", 6, 4);
  verified(8, "KNK", -3, 3);
  verified(12, "DRD", 1, 3);
  verified(23, "LLP", 2, 4, { doneToday: true });
  verified(28, "BRB", 9, 3);
  verified(14, "KNK", 12, 3);
  verified(15, "MRD", 6, 4, { doneToday: true });

  // ---- Bills that will go into seeded runs.
  const draftIds = [verified(6, "HRM", 1, 3, { by: "Amit Oraon" }).id, verified(10, "DRD", 2, 4, { by: "Ravi Mahto" }).id];
  const paidIds = [verified(11, "MRD", -6, 3).id, verified(16, "LLP", -7, 3).id, verified(20, "BRB", -6, 2, { by: "Ravi Mahto" }).id];

  // ---- On hold, duplicate, rejected.
  {
    const h = verified(19, "MRD", 3, 3);
    h.state = "ON_HOLD";
    h.holdReason = "Short supply: 4 cartons missing, waiting for credit note";
    const d = baseInvoice({ id: `inv_${String(seq++).padStart(3, "0")}`, ...vs(1), store: st("LLP"), invoiceNo: invoices.find((x) => x.vendorId === "v_01" && x.state === "VERIFIED")!.header.invoiceNo!, invoiceDate: addDays(today, -19), lines: pickLines(1, 3), seed: 90 }, "Sunita Kumari", ts(1, 16));
    d.state = "DUPLICATE";
    d.duplicateOfId = invoices.find((x) => x.vendorId === "v_01" && x.state === "VERIFIED")!.id;
    invoices.push(d);
    const r = baseInvoice({ id: `inv_${String(seq++).padStart(3, "0")}`, ...vs(18), store: st("HRM"), invoiceNo: nextNo(18), invoiceDate: addDays(today, -2), lines: pickLines(18, 2), seed: 91 }, "Amit Oraon", ts(2, 12));
    r.state = "REJECTED";
    r.rejectReason = "Not our bill: delivered to a different shop";
    invoices.push(r);
  }

  const db: Db = { version: 1, seq: 1000, stores: STORES, users: USERS.map((u) => ({ ...u })), vendors, invoices, runs: [], audit: [], fileSeqByDate: {} };
  return {
    db,
    runs: [
      { state: "PAID", invoiceIds: paidIds, byUser: "u_neha", daysAgo: 5 },
      { state: "DRAFT", invoiceIds: draftIds, byUser: "u_neha", daysAgo: 0 },
    ],
  };
}

export type { LineField };
