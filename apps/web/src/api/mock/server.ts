/**
 * In-browser implementation of every route in packages/core/src/api.ts.
 * Same status codes and error shape as the real server, so the UI cannot tell them apart.
 */
import type {
  AuditEntry,
  BankInput,
  BankVersion,
  CaptureResponse,
  Dashboard,
  HeaderUpdate,
  InvoiceDetail,
  InvoiceLine,
  InvoiceState,
  InvoiceSummary,
  LineInput,
  LineUpdate,
  LockTotalResponse,
  Me,
  PayableBill,
  PayablesResponse,
  PaymentRunDetail,
  PaymentRunItem,
  PaymentRunSummary,
  RunWarning,
  Settings,
  Store,
  StoreInput,
  UserInput,
  UserRow,
  VendorDetail,
  VendorInput,
  VendorSummary,
} from "@arad/core";
import { blockingFailures, classifyQr, computeLine, isValidGstin, normalizeGstin, runChecks, verificationBalance } from "@arad/core";
import { checkAccountNumber, consolidate, generateBulkFile, isValidIfsc, type PayableBill as FileBill, type Vendor as FileVendor } from "@arad/hdfc-bulk-file";
import { clearDb, loadDb, saveDb, session, type Db, type DbInvoice, type DbRun, type DbUser, type DbVendor } from "./db";
import { invoiceSvg, PAGE_H, PAGE_W, svgDataUrl } from "./invoice-svg";
import { addDays, baseInvoice, DAY, isoDay, makeRng, seed } from "./seed";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const SETTINGS: Settings = {
  hdfcClientCode: "ARAD01",
  rtgsFromPaise: 2_00_000_00,
  coolingOffHours: 24,
  requireDifferentApprover: true,
  aiProviders: [
    { id: "gemini", enabled: true, keys: 3, trainsOnInput: true, allowedForRealData: false, model: "gemini-flash-latest" },
    { id: "gemini-second", enabled: true, keys: 3, trainsOnInput: true, allowedForRealData: false, model: "gemini-pro-latest" },
    { id: "textract", enabled: false, keys: 0, trainsOnInput: false, allowedForRealData: true },
    { id: "local-ocr", enabled: true, keys: 0, trainsOnInput: false, allowedForRealData: true, model: "paddleocr" },
  ],
};

const OPEN_RUN: DbRun["state"][] = ["DRAFT", "APPROVED", "UPLOADED"];

export class MockServer {
  db: Db;
  private svgCache = new Map<string, string>();
  private photos = new Map<string, string[]>();
  private rnd = makeRng(Date.now() & 0xffff);
  now: () => number;

  constructor(opts: { db?: Db; now?: () => number; persist?: boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.persist = opts.persist ?? true;
    const loaded = opts.db ?? (this.persist ? loadDb() : undefined);
    if (loaded) this.db = loaded;
    else {
      const s = seed(this.now());
      this.db = s.db;
      for (const r of s.runs) this.seedRun(r);
      this.db.audit = [];
      this.save();
    }
  }
  private persist: boolean;
  save() {
    if (this.persist) saveDb(this.db);
  }
  reset() {
    clearDb();
  }

  // ------------------------------------------------------------ helpers
  private today() {
    return isoDay(0, this.now());
  }
  private iso() {
    return new Date(this.now()).toISOString();
  }
  private id(prefix: string) {
    this.db.seq++;
    return `${prefix}_${this.db.seq.toString(36)}${Math.floor(this.rnd() * 1296).toString(36)}`;
  }
  private audit(actor: DbUser | undefined, action: string, entity: string, entityId: string, detail?: unknown) {
    const e: AuditEntry = { id: this.id("au"), at: this.iso(), actor: actor?.name ?? "system", action, entity, entityId, detail };
    this.db.audit.push(e);
  }
  userBySession(sid: string | undefined): DbUser | undefined {
    return sid ? this.db.users.find((u) => u.id === sid && u.active) : undefined;
  }
  requireUser(sid: string | undefined): DbUser {
    const u = this.userBySession(sid);
    if (!u) throw new HttpError(401, "unauthorized", "Please log in again");
    return u;
  }
  requireOwner(u: DbUser) {
    if (u.role !== "owner") throw new HttpError(403, "forbidden", "Only the owner can do this");
  }
  private toMe(u: DbUser): Me {
    return { id: u.id, name: u.name, phone: u.phone, role: u.role, storeIds: [...u.storeIds], lang: u.lang };
  }
  private store(id: string): Store {
    const s = this.db.stores.find((x) => x.id === id);
    if (!s) throw new HttpError(404, "not_found", "Store not found");
    return s;
  }
  private vendor(id: string | undefined): DbVendor | undefined {
    return id ? this.db.vendors.find((v) => v.id === id) : undefined;
  }
  private canSeeStore(u: DbUser, storeId: string) {
    return u.role === "owner" || u.storeIds.includes(storeId);
  }
  private invoice(u: DbUser, id: string): DbInvoice {
    this.tick();
    const inv = this.db.invoices.find((i) => i.id === id);
    if (!inv || !this.canSeeStore(u, inv.storeId)) throw new HttpError(404, "not_found", "Bill not found");
    return inv;
  }
  /** Bills that were "being read" become ready after their time. */
  tick() {
    const now = this.now();
    let changed = false;
    for (const inv of this.db.invoices) {
      if (inv.state === "EXTRACTING" && inv.readyAt && Date.parse(inv.readyAt) <= now) {
        inv.state = "NEEDS_VERIFICATION";
        inv.readyAt = undefined;
        changed = true;
      }
    }
    if (changed) this.save();
  }
  private signedAmount(inv: DbInvoice) {
    return inv.header.docType === "CRN" ? -inv.totals.grandTotalPaise : inv.totals.grandTotalPaise;
  }
  private checks(inv: DbInvoice) {
    return runChecks(
      { header: inv.header, totals: inv.totals, lines: inv.lines, qr: inv.qr, lockedTotalPaise: inv.lockedTotalPaise },
      { storeGstins: this.db.stores.map((s) => s.gstin!).filter(Boolean), today: this.today() },
    );
  }
  private flaggedCount(inv: DbInvoice) {
    const low = (m?: { confidence: number; flagged?: boolean }) => !!m && (m.confidence < 0.8 || !!m.flagged);
    let n = Object.values(inv.headerMeta).filter(low).length;
    for (const l of inv.lines) n += Object.values(l.meta ?? {}).filter(low).length;
    return n;
  }
  private pageUrl(inv: DbInvoice) {
    let url = this.svgCache.get(inv.id);
    if (!url) {
      url = svgDataUrl(invoiceSvg(inv.paper));
      this.svgCache.set(inv.id, url);
    }
    return url;
  }
  pageSvg(documentId: string, n: number): string | undefined {
    const inv = this.db.invoices.find((i) => i.documentId === documentId);
    if (!inv) return undefined;
    return n === 0 ? invoiceSvg(inv.paper) : undefined;
  }
  private summary(inv: DbInvoice): InvoiceSummary {
    const showAmount = inv.state !== "CAPTURED" && inv.state !== "EXTRACTING";
    return {
      id: inv.id,
      storeId: inv.storeId,
      storeName: this.store(inv.storeId).name,
      state: inv.state,
      vendorId: showAmount ? inv.vendorId : undefined,
      vendorName: showAmount ? inv.header.vendorName : undefined,
      invoiceNo: showAmount ? inv.header.invoiceNo : undefined,
      invoiceDate: showAmount ? inv.header.invoiceDate : undefined,
      grandTotalPaise: showAmount ? inv.totals.grandTotalPaise : undefined,
      lineCount: showAmount ? inv.lines.filter((l) => l.status !== "removed").length : 0,
      flaggedCount: showAmount ? this.flaggedCount(inv) : 0,
      createdAt: inv.createdAt,
    };
  }
  detail(inv: DbInvoice): InvoiceDetail {
    const ready = inv.state !== "CAPTURED" && inv.state !== "EXTRACTING";
    const pages = ready ? [{ url: this.pageUrl(inv), width: PAGE_W, height: PAGE_H }] : [];
    for (const url of this.photos.get(inv.documentId) ?? []) pages.push({ url, width: 0, height: 0 });
    return {
      id: inv.id,
      storeId: inv.storeId,
      state: inv.state,
      vendorId: inv.vendorId,
      vendorName: inv.header.vendorName,
      header: { ...inv.header },
      headerMeta: structuredClone(inv.headerMeta),
      totals: { ...inv.totals },
      totalsMeta: structuredClone(inv.totalsMeta),
      lines: ready ? structuredClone(inv.lines) : [],
      checks: ready ? this.checks(inv) : [],
      qr: inv.qr,
      lockedTotalPaise: inv.lockedTotalPaise,
      pages: pages.map((p) => (p.width ? p : { url: p.url })),
      dueDate: inv.dueDate,
      duplicateOfId: inv.duplicateOfId,
      holdReason: inv.holdReason ?? inv.rejectReason,
      createdAt: inv.createdAt,
      capturedBy: inv.capturedBy,
      verifiedBy: inv.verifiedBy,
      verifiedAt: inv.verifiedAt,
      extraction: ready
        ? {
            providers: [
              { provider: "local-ocr", ok: true, ms: 2100 + (inv.lines.length * 90) },
              { provider: "gemini", ok: true, ms: 3400 + inv.lines.length * 120 },
            ],
          }
        : undefined,
    };
  }

  // ------------------------------------------------------------ auth
  login(phone: string, pin: string): { me: Me; sid: string } {
    const u = this.db.users.find((x) => x.phone === phone.replace(/\D/g, "").slice(-10) && x.active);
    if (!u || u.pin !== pin) throw new HttpError(401, "bad_login", "Wrong phone number or PIN");
    this.audit(u, "login", "user", u.id);
    this.save();
    return { me: this.toMe(u), sid: u.id };
  }
  me(u: DbUser) {
    return this.toMe(u);
  }
  setLang(u: DbUser, lang: unknown) {
    if (lang !== "en" && lang !== "hi") throw new HttpError(400, "bad_request", "lang must be en or hi");
    u.lang = lang;
    this.save();
    return this.toMe(u);
  }

  // ------------------------------------------------------------ stores & users
  stores(u: DbUser): Store[] {
    return this.db.stores.filter((s) => this.canSeeStore(u, s.id));
  }
  createStore(u: DbUser, s: StoreInput): Store {
    this.requireOwner(u);
    if (!s?.name?.trim() || !s.code?.trim()) throw new HttpError(400, "bad_request", "Store name and code are required");
    if (this.db.stores.some((x) => x.code.toUpperCase() === s.code.trim().toUpperCase())) throw new HttpError(409, "duplicate", "A store with this code exists");
    if (s.gstin && !isValidGstin(normalizeGstin(s.gstin))) throw new HttpError(400, "bad_gstin", "GSTIN is not valid");
    const store: Store = { id: this.id("st"), code: s.code.trim().toUpperCase(), name: s.name.trim(), gstin: normalizeGstin(s.gstin), address: s.address?.trim() || undefined };
    this.db.stores.push(store);
    for (const x of this.db.users) if (x.role === "owner") x.storeIds.push(store.id);
    this.audit(u, "create", "store", store.id);
    this.save();
    return store;
  }
  users(u: DbUser): UserRow[] {
    this.requireOwner(u);
    return this.db.users.map(({ pin: _p, lang: _l, ...r }) => ({ ...r, storeIds: [...r.storeIds] }));
  }
  createUser(u: DbUser, input: UserInput): UserRow {
    this.requireOwner(u);
    const phone = (input?.phone ?? "").replace(/\D/g, "");
    if (!input?.name?.trim()) throw new HttpError(400, "bad_request", "Name is required");
    if (!/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, "bad_phone", "Phone must be a 10-digit mobile number");
    if (!/^\d{4,6}$/.test(input.pin ?? "")) throw new HttpError(400, "bad_pin", "PIN must be 4 to 6 digits");
    if (this.db.users.some((x) => x.phone === phone)) throw new HttpError(409, "duplicate", "This phone number already has an account");
    const row: DbUser = { id: this.id("u"), name: input.name.trim(), phone, pin: input.pin, role: input.role === "owner" ? "owner" : "staff", storeIds: input.storeIds ?? [], active: true, lang: "hi" };
    this.db.users.push(row);
    this.audit(u, "create", "user", row.id, { role: row.role });
    this.save();
    const { pin: _p, lang: _l, ...out } = row;
    return out;
  }

  // ------------------------------------------------------------ capture
  capture(u: DbUser, fields: { storeId: string; clientId: string; qr: string[]; pages: Blob[] }): CaptureResponse {
    if (!fields.storeId || !this.canSeeStore(u, fields.storeId)) throw new HttpError(403, "forbidden", "You cannot add bills to this store");
    if (!fields.clientId) throw new HttpError(400, "bad_request", "clientId is required");
    if (!fields.pages.length || fields.pages.length > 10) throw new HttpError(400, "bad_request", "Send 1 to 10 pages");
    const existing = this.db.invoices.find((i) => i.clientId === fields.clientId);
    if (existing) return { documentId: existing.documentId, invoiceId: existing.id, state: existing.state };

    // Pretend to read the photo: pick an active vendor and build a fresh bill with a page image.
    const pool = this.db.vendors.filter((v) => v.status === "ACTIVE" && v.bank.some((b) => b.status === "APPROVED"));
    const vendor = pool[Math.floor(this.rnd() * pool.length)]!;
    const store = this.store(fields.storeId);
    const id = this.id("inv");
    const catalogue = this.db.invoices.find((i) => i.vendorId === vendor.id)?.paper.lines ?? this.db.invoices[0]!.paper.lines;
    const n = Math.min(catalogue.length, 4 + Math.floor(this.rnd() * 3));
    const lines = catalogue.slice(0, n).map((l) => {
      const qtyMilli = (4 + Math.floor(this.rnd() * 20)) * 1000;
      return { ...l, qtyMilli, ...computeLine({ ...l, qtyMilli }) };
    });
    const qr = fields.qr.map(classifyQr).find((q) => q.kind === "einvoice");
    const inv = baseInvoice(
      {
        id,
        vendor,
        vendorSeed: { city: "Ranchi, Jharkhand", state: vendor.gstin?.slice(0, 2) ?? "20" },
        store,
        invoiceNo: `${vendor.name.replace(/[^A-Z]/g, "").slice(0, 3)}/${String(2000 + Math.floor(this.rnd() * 7000))}`,
        invoiceDate: this.today(),
        lines,
        seed: Math.floor(this.rnd() * 1e6),
      },
      u.name,
      this.iso(),
    );
    inv.clientId = fields.clientId;
    inv.state = "EXTRACTING";
    inv.readyAt = new Date(this.now() + 2000).toISOString();
    if (qr?.kind === "einvoice") inv.qr = undefined; // a real server would trust it; the fake bill would not match
    this.db.invoices.push(inv);
    try {
      this.photos.set(inv.documentId, fields.pages.filter((p) => p.type.startsWith("image/")).map((p) => URL.createObjectURL(p)));
    } catch {
      /* no object URLs in tests */
    }
    this.audit(u, "capture", "invoice", inv.id, { pages: fields.pages.length, qr: fields.qr.length });
    this.save();
    return { documentId: inv.documentId, invoiceId: inv.id, state: inv.state };
  }

  // ------------------------------------------------------------ invoices
  invoices(u: DbUser, q: URLSearchParams) {
    this.tick();
    const state = q.get("state") as InvoiceState | null;
    const storeId = q.get("storeId");
    const text = q.get("q")?.trim().toLowerCase();
    const limit = Math.min(Number(q.get("limit") ?? 30) || 30, 100);
    const offset = Number(q.get("cursor") ?? 0) || 0;
    const all = this.db.invoices
      .filter((i) => this.canSeeStore(u, i.storeId))
      .filter((i) => !state || i.state === state)
      .filter((i) => !storeId || i.storeId === storeId)
      .filter((i) => !text || `${i.header.vendorName ?? ""} ${i.header.invoiceNo ?? ""}`.toLowerCase().includes(text))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const items = all.slice(offset, offset + limit).map((i) => this.summary(i));
    return { items, nextCursor: offset + limit < all.length ? String(offset + limit) : undefined };
  }
  getInvoice(u: DbUser, id: string) {
    return this.detail(this.invoice(u, id));
  }
  private editable(inv: DbInvoice) {
    if (inv.state !== "NEEDS_VERIFICATION") throw new HttpError(409, "bad_state", "This bill is not waiting for checking");
  }
  lockTotal(u: DbUser, id: string, typed: unknown): LockTotalResponse {
    const inv = this.invoice(u, id);
    this.editable(inv);
    if (!Number.isSafeInteger(typed) || (typed as number) <= 0) throw new HttpError(400, "bad_amount", "Type the total in rupees and paise");
    const t = typed as number;
    inv.lockAttempts++;
    const match = t === inv.totals.grandTotalPaise;
    const extracted = inv.totals.grandTotalPaise;
    if (match || inv.lockAttempts >= 2) {
      inv.lockedTotalPaise = t;
      if (!match) {
        // Two careful human readings beat the machine: trust the paper, flag the bill.
        inv.totalsMeta.grandTotalPaise = { confidence: 0.4, flagged: true, reason: "Typed total differs from the bill reader", sources: { Typed: String(t), Reader: String(extracted) } };
        inv.totals.grandTotalPaise = t;
      }
    }
    this.audit(u, match ? "lock_total" : "lock_total_mismatch", "invoice", inv.id, { attempts: inv.lockAttempts });
    this.save();
    return { match, extractedTotalPaise: extracted, attempts: inv.lockAttempts, invoice: this.detail(inv) };
  }
  updateHeader(u: DbUser, id: string, upd: HeaderUpdate) {
    const inv = this.invoice(u, id);
    this.editable(inv);
    const keys = ["vendorName", "sellerGstin", "buyerGstin", "invoiceNo", "invoiceDate", "irn", "docType"] as const;
    for (const k of keys) {
      if (upd[k] !== undefined && upd[k] !== inv.header[k]) {
        (inv.header as Record<string, unknown>)[k] = k.endsWith("Gstin") ? normalizeGstin(upd[k] as string) : upd[k];
        inv.headerMeta[k] = { confidence: 1, reason: "Corrected by staff" };
      }
    }
    if (upd.invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(upd.invoiceDate)) throw new HttpError(400, "bad_date", "Date must be YYYY-MM-DD");
    if (upd.vendorId) {
      if (!this.vendor(upd.vendorId)) throw new HttpError(400, "bad_vendor", "Vendor not found");
      inv.vendorId = upd.vendorId;
    } else if (upd.sellerGstin) {
      const v = this.db.vendors.find((x) => x.gstin === inv.header.sellerGstin);
      if (v) inv.vendorId = v.id;
    }
    if (upd.totals) Object.assign(inv.totals, upd.totals);
    this.audit(u, "edit_header", "invoice", inv.id, { fields: Object.keys(upd) });
    this.save();
    return this.detail(inv);
  }
  private validLine(l: LineInput) {
    const bad = (m: string) => new HttpError(400, "bad_line", m);
    if (!l || typeof l.description !== "string" || !l.description.trim()) throw bad("Item name is required");
    for (const k of ["qtyMilli", "ratePaise", "discountPaise", "gstRateBp"] as const) if (!Number.isSafeInteger(l[k]) || l[k] < 0) throw bad(`${k} must be a whole number of at least 0`);
    if (l.qtyMilli <= 0) throw bad("Quantity must be more than zero");
    if (l.gstRateBp > 4000) throw bad("GST rate looks wrong");
  }
  private applyLine(target: InvoiceLine, l: LineInput) {
    const c = computeLine(l);
    Object.assign(target, {
      description: l.description.trim(),
      hsn: l.hsn?.trim() || undefined,
      qtyMilli: l.qtyMilli,
      unit: l.unit?.trim() || undefined,
      mrpPaise: l.mrpPaise || undefined,
      ratePaise: l.ratePaise,
      discountPaise: l.discountPaise,
      gstRateBp: l.gstRateBp,
      taxablePaise: c.taxablePaise,
      taxPaise: c.taxPaise,
      totalPaise: l.totalPaise ?? c.totalPaise,
      status: "edited",
      meta: undefined,
    });
  }
  updateLine(u: DbUser, id: string, lineId: string, upd: LineUpdate) {
    const inv = this.invoice(u, id);
    this.editable(inv);
    const line = inv.lines.find((l) => l.id === lineId);
    if (!line) throw new HttpError(404, "not_found", "Line not found");
    if (upd?.action === "accept") {
      if (line.status === "pending" || line.status === "removed") line.status = "accepted";
    } else if (upd?.action === "remove") line.status = "removed";
    else if (upd?.action === "edit") {
      this.validLine(upd.line);
      this.applyLine(line, upd.line);
    } else throw new HttpError(400, "bad_request", "action must be accept, edit or remove");
    this.audit(u, `line_${upd.action}`, "invoice", inv.id, { lineId });
    this.save();
    return this.detail(inv);
  }
  addLine(u: DbUser, id: string, l: LineInput) {
    const inv = this.invoice(u, id);
    this.editable(inv);
    this.validLine(l);
    const line = { id: `${inv.id}_n${inv.lines.length + 1}`, idx: inv.lines.length } as InvoiceLine;
    this.applyLine(line, l);
    inv.lines.push(line);
    this.audit(u, "line_add", "invoice", inv.id, { lineId: line.id });
    this.save();
    return this.detail(inv);
  }
  seal(u: DbUser, id: string, durationMs: unknown) {
    const inv = this.invoice(u, id);
    this.editable(inv);
    if (inv.lockedTotalPaise === undefined) throw new HttpError(409, "not_locked", "Type the grand total first");
    const bal = verificationBalance(inv.lockedTotalPaise, inv.lines, inv.totals);
    if (!bal.balanced) throw new HttpError(409, "not_balanced", "The bill does not balance to zero yet", bal);
    const fails = blockingFailures(this.checks(inv));
    if (fails.length) throw new HttpError(409, "checks_failed", fails[0]!.message, fails);
    inv.state = "VERIFIED";
    inv.verifiedBy = u.name;
    inv.verifiedAt = this.iso();
    inv.verifyMs = typeof durationMs === "number" ? durationMs : undefined;
    const terms = this.vendor(inv.vendorId)?.paymentTermsDays ?? 15;
    inv.dueDate = addDays(inv.header.invoiceDate ?? this.today(), terms);
    this.audit(u, "seal", "invoice", inv.id, { durationMs, edits: inv.lines.filter((l) => l.status === "edited").length });
    this.save();
    return this.detail(inv);
  }
  setState(u: DbUser, id: string, action: "reject" | "hold" | "unhold" | "re-extract", reason?: string) {
    const inv = this.invoice(u, id);
    if (action === "reject") {
      if (!["NEEDS_VERIFICATION", "EXTRACTION_FAILED", "ON_HOLD", "DUPLICATE"].includes(inv.state)) throw new HttpError(409, "bad_state", "This bill cannot be rejected now");
      inv.state = "REJECTED";
      inv.rejectReason = reason;
    } else if (action === "hold") {
      if (!["NEEDS_VERIFICATION", "VERIFIED"].includes(inv.state)) throw new HttpError(409, "bad_state", "This bill cannot be put on hold now");
      inv.state = "ON_HOLD";
      inv.holdReason = reason;
    } else if (action === "unhold") {
      if (inv.state !== "ON_HOLD") throw new HttpError(409, "bad_state", "This bill is not on hold");
      inv.state = inv.verifiedAt ? "VERIFIED" : "NEEDS_VERIFICATION";
      inv.holdReason = undefined;
    } else {
      if (!["NEEDS_VERIFICATION", "EXTRACTION_FAILED"].includes(inv.state)) throw new HttpError(409, "bad_state", "Only unchecked bills can be read again");
      inv.lines.forEach((l) => (l.status = "pending"));
      inv.lockedTotalPaise = undefined;
      inv.lockAttempts = 0;
      inv.state = "NEEDS_VERIFICATION";
    }
    if ((action === "reject" || action === "hold") && !reason?.trim()) throw new HttpError(400, "bad_request", "Please give a reason");
    this.audit(u, action, "invoice", inv.id, reason ? { reason } : undefined);
    this.save();
    return this.detail(inv);
  }

  // ------------------------------------------------------------ vendors
  private approvedBank(v: DbVendor) {
    return v.bank.find((b) => b.status === "APPROVED");
  }
  private mask(acct: string) {
    return `XXXXXX${acct.slice(-4)}`;
  }
  private owed(vendorId: string) {
    return this.db.invoices.filter((i) => i.vendorId === vendorId && (i.state === "VERIFIED" || i.state === "IN_PAYMENT_RUN")).reduce((s, i) => s + this.signedAmount(i), 0);
  }
  private vendorSummary(v: DbVendor): VendorSummary {
    const approved = this.approvedBank(v);
    const pending = v.bank.find((b) => b.status === "PENDING");
    const shown = approved ?? pending;
    return {
      id: v.id,
      name: v.name,
      gstin: v.gstin,
      status: v.status,
      bankStatus: pending ? "PENDING" : approved ? "APPROVED" : "NONE",
      accountMasked: shown ? this.mask(shown.accountNumber) : undefined,
      ifsc: shown?.ifsc,
      owedPaise: this.owed(v.id),
    };
  }
  private vendorDetail(v: DbVendor): VendorDetail {
    const versions: BankVersion[] = v.bank
      .map(({ accountNumber, ...b }) => ({ ...b, accountMasked: this.mask(accountNumber) }))
      .sort((a, b) => b.version - a.version);
    return { ...this.vendorSummary(v), tradeName: v.tradeName, pan: v.pan, phone: v.phone, email: v.email, paymentTermsDays: v.paymentTermsDays, bankVersions: versions };
  }
  private mustVendor(id: string) {
    const v = this.vendor(id);
    if (!v) throw new HttpError(404, "not_found", "Vendor not found");
    return v;
  }
  vendors(_u: DbUser, q: URLSearchParams): VendorSummary[] {
    const text = q.get("q")?.trim().toLowerCase();
    const status = q.get("status");
    return this.db.vendors
      .filter((v) => !status || v.status === status)
      .filter((v) => !text || `${v.name} ${v.gstin ?? ""}`.toLowerCase().includes(text))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((v) => this.vendorSummary(v));
  }
  getVendor(_u: DbUser, id: string) {
    return this.vendorDetail(this.mustVendor(id));
  }
  private cleanVendor(input: VendorInput, selfId?: string) {
    if (!input?.name?.trim()) throw new HttpError(400, "bad_request", "Vendor name is required");
    const g = normalizeGstin(input.gstin);
    if (g && !isValidGstin(g)) throw new HttpError(400, "bad_gstin", "GSTIN is not valid. Check each letter and digit.");
    if (g && this.db.vendors.some((v) => v.gstin === g && v.id !== selfId)) throw new HttpError(409, "duplicate_vendor", "A vendor with this GSTIN already exists");
    const terms = input.paymentTermsDays ?? 15;
    if (!Number.isInteger(terms) || terms < 0 || terms > 180) throw new HttpError(400, "bad_request", "Payment terms must be 0 to 180 days");
    return {
      name: input.name.trim(),
      tradeName: input.tradeName?.trim() || undefined,
      gstin: g,
      pan: input.pan?.trim().toUpperCase() || (g ? g.slice(2, 12) : undefined),
      phone: input.phone?.replace(/\D/g, "") || undefined,
      email: input.email?.trim() || undefined,
      paymentTermsDays: terms,
    };
  }
  createVendor(u: DbUser, input: VendorInput) {
    const v: DbVendor = { id: this.id("v"), ...this.cleanVendor(input), status: u.role === "owner" ? "ACTIVE" : "PENDING", createdAt: this.iso(), bank: [] };
    this.db.vendors.push(v);
    this.audit(u, "create", "vendor", v.id);
    this.save();
    return this.vendorDetail(v);
  }
  updateVendor(u: DbUser, id: string, input: VendorInput) {
    const v = this.mustVendor(id);
    Object.assign(v, this.cleanVendor(input, id));
    this.audit(u, "update", "vendor", v.id);
    this.save();
    return this.vendorDetail(v);
  }
  approveVendor(u: DbUser, id: string) {
    this.requireOwner(u);
    const v = this.mustVendor(id);
    if (v.status !== "PENDING") throw new HttpError(409, "bad_state", "This vendor is not waiting for approval");
    v.status = "ACTIVE";
    this.audit(u, "approve", "vendor", v.id);
    this.save();
    return this.vendorDetail(v);
  }
  addBank(u: DbUser, id: string, b: BankInput) {
    const v = this.mustVendor(id);
    const acct = (b?.accountNumber ?? "").replace(/\s+/g, "").toUpperCase();
    const confirm = (b?.accountNumberConfirm ?? "").replace(/\s+/g, "").toUpperCase();
    const ifsc = (b?.ifsc ?? "").replace(/\s+/g, "").toUpperCase();
    if (acct !== confirm) throw new HttpError(400, "account_mismatch", "The two account numbers do not match");
    if (!checkAccountNumber(acct).ok) throw new HttpError(400, "bad_account", "Account number must be 6 to 25 letters or digits");
    if (!isValidIfsc(ifsc)) throw new HttpError(400, "bad_ifsc", "IFSC must look like HDFC0001234");
    const other = this.db.vendors.find((x) => x.id !== v.id && x.bank.some((k) => k.accountNumber === acct && k.status !== "REJECTED"));
    if (other) throw new HttpError(409, "duplicate_account", `This account is already saved for ${other.name}`);
    for (const k of v.bank) if (k.status === "PENDING") k.status = "REJECTED";
    const version = Math.max(0, ...v.bank.map((k) => k.version)) + 1;
    v.bank.push({
      id: this.id("bk"),
      version,
      accountNumber: acct,
      ifsc,
      bankName: b.bankName?.trim() || undefined,
      branchName: b.branchName?.trim() || undefined,
      beneCode: b.beneCode?.trim().toUpperCase() || undefined,
      status: "PENDING",
      createdBy: u.name,
      createdAt: this.iso(),
    });
    this.audit(u, "bank_add", "vendor", v.id, { version, account: this.mask(acct) });
    this.save();
    return this.vendorDetail(v);
  }
  approveBank(u: DbUser, id: string, versionId: string) {
    this.requireOwner(u);
    const v = this.mustVendor(id);
    const k = v.bank.find((x) => x.id === versionId);
    if (!k) throw new HttpError(404, "not_found", "Bank version not found");
    if (k.status !== "PENDING") throw new HttpError(409, "bad_state", "These bank details are not waiting for approval");
    for (const x of v.bank) if (x.status === "APPROVED") x.status = "SUPERSEDED";
    k.status = "APPROVED";
    k.approvedBy = u.name;
    k.approvedAt = this.iso();
    k.usableFrom = new Date(this.now() + SETTINGS.coolingOffHours * 3600_000).toISOString();
    this.audit(u, "bank_approve", "vendor", v.id, { version: k.version, usableFrom: k.usableFrom });
    this.save();
    return this.vendorDetail(v);
  }

  // ------------------------------------------------------------ payables
  /** Why this vendor cannot be paid right now, if so. */
  blockedReason(v: DbVendor | undefined): string | undefined {
    if (!v) return "Bill is not linked to a vendor";
    if (v.status === "BLOCKED") return "Vendor is blocked";
    if (v.status === "PENDING") return "New vendor waiting for owner approval";
    if (v.bank.some((b) => b.status === "PENDING")) return "Bank change waiting for owner approval";
    const a = this.approvedBank(v);
    if (!a) return "Bank details not added";
    if (a.usableFrom && Date.parse(a.usableFrom) > this.now()) {
      const d = new Date(a.usableFrom);
      return `New bank account: cooling-off until ${d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
    }
    return undefined;
  }
  payables(_u: DbUser, due: string | null): PayablesResponse {
    const today = this.today();
    const week = addDays(today, 7);
    const inOpenRun = new Set(this.db.runs.filter((r) => OPEN_RUN.includes(r.state)).flatMap((r) => r.invoiceIds));
    const bills = this.db.invoices.filter((i) => i.state === "VERIFIED" && !inOpenRun.has(i.id) && i.vendorId && i.dueDate);
    const match = (d: string) => (due === "overdue" ? d < today : due === "today" ? d <= today : due === "week" ? d <= week : true);
    const groups = new Map<string, PayableBill[]>();
    for (const i of bills) {
      if (!match(i.dueDate!)) continue;
      const list = groups.get(i.vendorId!) ?? [];
      list.push({
        invoiceId: i.id,
        storeId: i.storeId,
        storeName: this.store(i.storeId).name,
        invoiceNo: i.header.invoiceNo ?? "",
        invoiceDate: i.header.invoiceDate ?? "",
        dueDate: i.dueDate!,
        amountPaise: this.signedAmount(i),
        docType: i.header.docType ?? "INV",
      });
      groups.set(i.vendorId!, list);
    }
    const vendors = [...groups.entries()]
      .map(([vendorId, list]) => {
        const v = this.vendor(vendorId);
        const blockedReason = this.blockedReason(v);
        list.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.storeName.localeCompare(b.storeName));
        return { vendorId, vendorName: v?.name ?? "Unknown vendor", bankReady: !blockedReason, blockedReason, totalPaise: list.reduce((s, b) => s + b.amountPaise, 0), bills: list };
      })
      .sort((a, b) => (a.bills[0]!.dueDate.localeCompare(b.bills[0]!.dueDate)) || a.vendorName.localeCompare(b.vendorName));
    return { vendors, totalPaise: vendors.reduce((s, v) => s + v.totalPaise, 0) };
  }

  // ------------------------------------------------------------ payment runs
  private runSummary(r: DbRun): PaymentRunSummary {
    return {
      id: r.id,
      ref: r.ref,
      state: r.state,
      valueDate: r.valueDate,
      count: r.items.filter((i) => i.state !== "FAILED" || r.state !== "PAID").length,
      totalPaise: r.items.reduce((s, i) => s + i.amountPaise, 0),
      createdAt: r.createdAt,
      preparedBy: r.preparedBy,
      approvedBy: r.approvedBy,
    };
  }
  private warningsFor(r: DbRun, viewer?: DbUser): RunWarning[] {
    const out: RunWarning[] = [];
    if (r.state === "DRAFT") {
      for (const item of r.items) {
        const v = this.vendor(item.vendorId);
        const reason = this.blockedReason(v);
        if (reason) out.push({ vendorId: item.vendorId, level: "block", code: "bank_not_ready", message: `${item.vendorName}: ${reason}` });
        if (item.amountPaise <= 0) out.push({ vendorId: item.vendorId, level: "block", code: "amount_unusual", message: `${item.vendorName}: credit notes cancel the bills, nothing to pay` });
        if (v && Date.parse(v.createdAt) > this.now() - 30 * DAY) out.push({ vendorId: v.id, level: "info", code: "new_vendor", message: `${v.name} is a new vendor (added in the last 30 days)` });
        const a = v && this.approvedBank(v);
        if (a?.approvedAt && Date.parse(a.approvedAt) > this.now() - 7 * DAY && v!.bank.some((b) => b.status === "SUPERSEDED"))
          out.push({ vendorId: v!.id, level: "warn", code: "bank_recent_change", message: `${v!.name}: bank account changed on ${new Date(a.approvedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}. Call the vendor to confirm.` });
        if (item.amountPaise >= SETTINGS.rtgsFromPaise) out.push({ vendorId: item.vendorId, level: "info", code: "amount_unusual", message: `${item.vendorName}: large amount, goes by RTGS` });
        const amounts = item.bills.map((b) => b.amountPaise);
        if (new Set(amounts).size !== amounts.length) out.push({ vendorId: item.vendorId, level: "warn", code: "possible_duplicate", message: `${item.vendorName}: two bills with the same amount. Check they are not the same bill.` });
      }
      if (viewer && SETTINGS.requireDifferentApprover && viewer.id === r.preparedById && viewer.role === "owner")
        out.push({ level: "warn", code: "same_preparer", message: "You prepared this run yourself. Check every vendor and amount carefully before approving." });
    }
    const order = { block: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }
  private runDetail(r: DbRun, viewer?: DbUser): PaymentRunDetail {
    return {
      ...this.runSummary(r),
      items: structuredClone(r.items),
      warnings: this.warningsFor(r, viewer),
      file: r.file ? { name: r.file.name, sha256: r.file.sha256, control: structuredClone(r.file.control) } : undefined,
    };
  }
  private mustRun(id: string) {
    const r = this.db.runs.find((x) => x.id === id);
    if (!r) throw new HttpError(404, "not_found", "Payment run not found");
    return r;
  }
  createRun(u: DbUser, invoiceIds: unknown, valueDate: unknown, at = this.now()): PaymentRunDetail {
    if (!Array.isArray(invoiceIds) || !invoiceIds.length) throw new HttpError(400, "bad_request", "Pick at least one bill");
    if (typeof valueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valueDate)) throw new HttpError(400, "bad_date", "Payment date must be YYYY-MM-DD");
    if (valueDate < isoDay(0, at)) throw new HttpError(400, "bad_date", "Payment date cannot be in the past");
    const inOpenRun = new Set(this.db.runs.filter((r) => OPEN_RUN.includes(r.state)).flatMap((r) => r.invoiceIds));
    const invs = [...new Set(invoiceIds as string[])].map((id) => {
      const inv = this.db.invoices.find((i) => i.id === id);
      if (!inv) throw new HttpError(400, "bad_request", `Bill ${id} not found`);
      if (inv.state !== "VERIFIED") throw new HttpError(409, "bad_state", `Bill ${inv.header.invoiceNo} is not verified`);
      if (inOpenRun.has(inv.id)) throw new HttpError(409, "in_open_run", `Bill ${inv.header.invoiceNo} is already in another payment run`);
      if (!inv.vendorId) throw new HttpError(409, "no_vendor", `Bill ${inv.header.invoiceNo} has no vendor`);
      return inv;
    });
    const dayKey = isoDay(0, at).replace(/-/g, "").slice(2);
    const sameDay = this.db.runs.filter((r) => r.ref.startsWith(`PR${dayKey}`)).length;
    const ref = `PR${dayKey}${String(sameDay + 1).padStart(2, "0")}`;
    const byVendor = new Map<string, DbInvoice[]>();
    for (const i of invs) byVendor.set(i.vendorId!, [...(byVendor.get(i.vendorId!) ?? []), i]);
    const items: PaymentRunItem[] = [...byVendor.entries()]
      .map(([vendorId, list]) => {
        const v = this.vendor(vendorId)!;
        const bank = this.approvedBank(v);
        const amountPaise = list.reduce((s, i) => s + this.signedAmount(i), 0);
        const ifsc = bank?.ifsc ?? "";
        const txnType: PaymentRunItem["txnType"] = ifsc.startsWith("HDFC") ? "I" : amountPaise >= SETTINGS.rtgsFromPaise ? "R" : "N";
        return {
          id: this.id("pi"),
          vendorId,
          vendorName: v.name,
          accountMasked: bank ? this.mask(bank.accountNumber) : "",
          ifsc,
          txnType,
          amountPaise,
          customerRef: "",
          bills: list.map((i) => ({ invoiceId: i.id, invoiceNo: i.header.invoiceNo ?? "", storeName: this.store(i.storeId).name, amountPaise: this.signedAmount(i) })),
          state: "PENDING" as const,
        };
      })
      .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
    items.forEach((it, n) => (it.customerRef = `${ref}${String(n + 1).padStart(3, "0")}`));
    const run: DbRun = {
      id: this.id("run"),
      ref,
      state: "DRAFT",
      valueDate,
      createdAt: new Date(at).toISOString(),
      preparedBy: u.name,
      preparedById: u.id,
      items,
      warnings: [],
      invoiceIds: invs.map((i) => i.id),
    };
    this.db.runs.unshift(run);
    for (const i of invs) i.state = "IN_PAYMENT_RUN";
    this.audit(u, "create", "payment_run", run.id, { count: items.length });
    this.save();
    return this.runDetail(run, u);
  }
  runs(u: DbUser): PaymentRunSummary[] {
    this.requireOwner(u);
    return [...this.db.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => this.runSummary(r));
  }
  getRun(u: DbUser, id: string) {
    this.requireOwner(u);
    return this.runDetail(this.mustRun(id), u);
  }
  approveRun(u: DbUser, id: string, at = this.now()) {
    this.requireOwner(u);
    const r = this.mustRun(id);
    if (r.state !== "DRAFT") throw new HttpError(409, "bad_state", "Only a draft run can be approved");
    const blocks = this.warningsFor(r).filter((w) => w.level === "block");
    if (blocks.length) throw new HttpError(409, "run_blocked", blocks[0]!.message, blocks);
    const fileVendors: FileVendor[] = r.items.map((it) => {
      const v = this.vendor(it.vendorId)!;
      const b = this.approvedBank(v)!;
      return { id: v.id, name: v.name, accountNumber: b.accountNumber, ifsc: b.ifsc, beneCode: b.beneCode, email: v.email, bankName: b.bankName, branchName: b.branchName };
    });
    const bills: FileBill[] = r.items.flatMap((it) =>
      it.bills.map((b) => ({ vendorId: it.vendorId, billNo: b.invoiceNo, storeCode: this.db.stores.find((s) => s.name === b.storeName)?.code ?? "", amountPaise: b.amountPaise })),
    );
    const { instructions, errors } = consolidate(bills, fileVendors, r.ref);
    if (errors.length) throw new HttpError(409, "file_invalid", errors[0]!.message, errors);
    const sequence = (this.db.fileSeqByDate[r.valueDate] ?? 0) + 1;
    const res = generateBulkFile(instructions, { clientCode: SETTINGS.hdfcClientCode!, valueDate: r.valueDate, sequence, rtgsFromPaise: SETTINGS.rtgsFromPaise });
    if (!res.ok) throw new HttpError(409, "file_invalid", res.errors[0]?.message ?? "The bank file could not be made", res.errors);
    this.db.fileSeqByDate[r.valueDate] = sequence;
    for (const row of res.rows) {
      const it = r.items.find((x) => x.vendorId === row.vendorId);
      if (it) {
        it.customerRef = row.customerRef;
        it.txnType = row.txnType;
      }
    }
    r.items.sort((a, b) => a.customerRef.localeCompare(b.customerRef));
    r.file = {
      name: res.fileName,
      sha256: res.sha256,
      content: res.content,
      control: { count: res.control.count, total: res.control.total, byType: res.control.byType },
    };
    r.state = "APPROVED";
    r.approvedBy = u.name;
    this.audit(u, "approve", "payment_run", r.id, { file: res.fileName, sha256: res.sha256, count: res.control.count, total: res.control.total });
    void at;
    this.save();
    return this.runDetail(r, u);
  }
  runFile(u: DbUser, id: string) {
    this.requireOwner(u);
    const r = this.mustRun(id);
    if (!r.file) throw new HttpError(409, "no_file", "Approve the run first");
    this.audit(u, "download_file", "payment_run", r.id);
    this.save();
    return { name: r.file.name, content: r.file.content };
  }
  adviceCsv(u: DbUser, id: string) {
    this.requireOwner(u);
    const r = this.mustRun(id);
    const rows = [["Vendor", "Reference", "Type", "Amount", "Bills", "UTR", "Status"].join(",")];
    for (const it of r.items) {
      const bills = it.bills.map((b) => `${b.invoiceNo} (${b.storeName})`).join("; ");
      rows.push([it.vendorName, it.customerRef, it.txnType, (it.amountPaise / 100).toFixed(2), `"${bills}"`, it.utr ?? "", it.state].join(","));
    }
    return { name: `${r.ref}-advice.csv`, content: rows.join("\r\n") + "\r\n" };
  }
  markUploaded(u: DbUser, id: string) {
    this.requireOwner(u);
    const r = this.mustRun(id);
    if (r.state !== "APPROVED") throw new HttpError(409, "bad_state", "Only an approved run can be marked uploaded");
    r.state = "UPLOADED";
    this.audit(u, "mark_uploaded", "payment_run", r.id);
    this.save();
    return this.runDetail(r, u);
  }
  markPaid(u: DbUser, id: string, utrs?: Record<string, string>) {
    this.requireOwner(u);
    const r = this.mustRun(id);
    if (r.state !== "UPLOADED" && r.state !== "APPROVED") throw new HttpError(409, "bad_state", "Mark the file uploaded first");
    r.state = "PAID";
    for (const it of r.items) {
      if (it.state !== "PENDING") continue;
      it.state = "PAID";
      const utr = utrs?.[it.id]?.trim();
      if (utr) it.utr = utr.toUpperCase();
      for (const b of it.bills) {
        const inv = this.db.invoices.find((i) => i.id === b.invoiceId);
        if (inv && inv.state === "IN_PAYMENT_RUN") inv.state = "PAID";
      }
    }
    this.audit(u, "mark_paid", "payment_run", r.id, { utrs: Object.keys(utrs ?? {}).length });
    this.save();
    return this.runDetail(r, u);
  }
  markFailed(u: DbUser, id: string, itemId: string, reason?: string) {
    this.requireOwner(u);
    const r = this.mustRun(id);
    if (r.state === "DRAFT" || r.state === "CANCELLED") throw new HttpError(409, "bad_state", "This run has not been sent to the bank");
    const it = r.items.find((x) => x.id === itemId);
    if (!it) throw new HttpError(404, "not_found", "Payment not found");
    if (!reason?.trim()) throw new HttpError(400, "bad_request", "Please give a reason");
    it.state = "FAILED";
    it.failReason = reason.trim();
    for (const b of it.bills) {
      const inv = this.db.invoices.find((i) => i.id === b.invoiceId);
      if (inv && (inv.state === "IN_PAYMENT_RUN" || inv.state === "PAID")) inv.state = "VERIFIED";
    }
    r.invoiceIds = r.invoiceIds.filter((x) => !it.bills.some((b) => b.invoiceId === x));
    this.audit(u, "mark_failed", "payment_run", r.id, { itemId, reason });
    this.save();
    return this.runDetail(r, u);
  }
  cancelRun(u: DbUser, id: string) {
    this.requireOwner(u);
    const r = this.mustRun(id);
    if (r.state !== "DRAFT" && r.state !== "APPROVED") throw new HttpError(409, "bad_state", "This run was already uploaded to the bank");
    r.state = "CANCELLED";
    for (const invId of r.invoiceIds) {
      const inv = this.db.invoices.find((i) => i.id === invId);
      if (inv?.state === "IN_PAYMENT_RUN") inv.state = "VERIFIED";
    }
    this.audit(u, "cancel", "payment_run", r.id);
    this.save();
    return this.runDetail(r, u);
  }
  private seedRun(s: { state: "DRAFT" | "PAID"; invoiceIds: string[]; byUser: string; daysAgo: number }) {
    const prep = this.db.users.find((x) => x.id === s.byUser)!;
    const owner = this.db.users.find((x) => x.role === "owner")!;
    const at = this.now() - s.daysAgo * DAY - 4 * 3600_000;
    const d = this.createRun(prep, s.invoiceIds, isoDay(0, at), at);
    const r = this.mustRun(d.id);
    if (s.state === "PAID") {
      this.approveRun(owner, r.id, at);
      r.approvedBy = owner.name;
      this.markUploaded(owner, r.id);
      const utrs = Object.fromEntries(r.items.map((it, i) => [it.id, `HDFCN${isoDay(0, at).replace(/-/g, "")}${String(48211 + i * 37)}`]));
      this.markPaid(owner, r.id, utrs);
    }
  }

  // ------------------------------------------------------------ dashboard, settings, audit
  dashboard(u: DbUser): Dashboard {
    this.requireOwner(u);
    this.tick();
    const today = this.today();
    const week = addDays(today, 7);
    const day = (iso?: string) => (iso ? isoDay(0, Date.parse(iso)) : "");
    const stores = this.db.stores.map((s) => {
      const list = this.db.invoices.filter((i) => i.storeId === s.id);
      return {
        storeId: s.id,
        storeName: s.name,
        captured: list.filter((i) => day(i.createdAt) === today).length,
        needsVerification: list.filter((i) => i.state === "NEEDS_VERIFICATION" || i.state === "EXTRACTING").length,
        verified: list.filter((i) => day(i.verifiedAt) === today).length,
        flagged: list.filter((i) => i.state === "NEEDS_VERIFICATION" && this.flaggedCount(i) > 0).length,
      };
    });
    const unpaid = this.db.invoices.filter((i) => (i.state === "VERIFIED" || i.state === "IN_PAYMENT_RUN") && i.dueDate);
    const sum = (l: DbInvoice[]) => l.reduce((s, i) => s + this.signedAmount(i), 0);
    const dueSoon = unpaid.filter((i) => i.dueDate! <= week);
    return {
      stores,
      owedPaise: sum(unpaid),
      overduePaise: sum(unpaid.filter((i) => i.dueDate! < today)),
      dueThisWeekPaise: sum(unpaid.filter((i) => i.dueDate! >= today && i.dueDate! <= week)),
      vendorsDue: new Set(dueSoon.map((i) => i.vendorId)).size,
      pendingApprovals: {
        vendors: this.db.vendors.filter((v) => v.status === "PENDING").length,
        bankChanges: this.db.vendors.filter((v) => v.bank.some((b) => b.status === "PENDING")).length,
        runs: this.db.runs.filter((r) => r.state === "DRAFT").length,
      },
      recentRuns: this.runs(u).slice(0, 5),
    };
  }
  settings(u: DbUser): Settings {
    this.requireOwner(u);
    return structuredClone(SETTINGS);
  }
  auditFor(u: DbUser, entity: string | null, id: string | null): AuditEntry[] {
    if (u.role !== "owner" && entity !== "invoice") throw new HttpError(403, "forbidden", "Only the owner can see this");
    return this.db.audit.filter((a) => (!entity || a.entity === entity) && (!id || a.entityId === id)).slice(-100).reverse();
  }
}

export { session };
