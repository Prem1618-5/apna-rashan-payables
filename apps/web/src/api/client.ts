/**
 * Typed client for every route in packages/core/src/api.ts.
 * Same origin, session cookie ("sid"), JSON in and out. Errors become ApiError.
 * In mock mode the same calls are answered by the in-browser backend (src/api/mock).
 */
import type {
  AuditEntry,
  BankInput,
  CaptureResponse,
  Dashboard,
  HeaderUpdate,
  InvoiceDetail,
  InvoiceState,
  InvoiceSummary,
  Lang,
  LineInput,
  LineUpdate,
  LockTotalResponse,
  LoginRequest,
  Me,
  Page,
  PayablesResponse,
  PaymentRunDetail,
  PaymentRunSummary,
  Settings,
  Store,
  StoreInput,
  UserInput,
  UserRow,
  VendorDetail,
  VendorInput,
  VendorStatus,
  VendorSummary,
} from "@arad/core";
import { isMockMode } from "./mode";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** No response at all: offline, DNS, server down. Worth retrying. */
  get isNetwork() {
    return this.status === 0;
  }
}

/** A minimal Response-like shape so the mock can answer without a real network. */
export interface Transport {
  (method: string, path: string, body?: unknown): Promise<Response>;
}

const fetchTransport: Transport = (method, path, body) => {
  const init: RequestInit = { method, credentials: "include", headers: { Accept: "application/json" } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return fetch(path, init);
};

let transportPromise: Promise<Transport> | undefined;
function transport(): Promise<Transport> {
  if (!transportPromise) {
    transportPromise = isMockMode() ? import("./mock").then((m) => m.mockTransport) : Promise.resolve(fetchTransport);
  }
  return transportPromise;
}

/** Called with every 401 so the app can show the login screen. */
let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await (await transport())(method, path, body);
  } catch (e) {
    throw new ApiError(0, "network", "No internet connection", e instanceof Error ? e.message : undefined);
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText || "Request failed";
    let details: unknown;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
      if (j?.error) {
        code = j.error.code ?? code;
        message = j.error.message ?? message;
        details = j.error.details;
      }
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && path !== "/api/auth/login") onUnauthorized?.();
    throw new ApiError(res.status, code, message, details);
  }
  return res;
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

/** Pulls `filename=` out of a Content-Disposition header. */
export function fileNameFromDisposition(h: string | null): string | undefined {
  if (!h) return undefined;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(h);
  if (star?.[1]) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
  const plain = /filename=("?)([^";]+)\1/i.exec(h);
  return plain?.[2]?.trim();
}

export interface CaptureUpload {
  storeId: string;
  clientId: string;
  qr: string[];
  pages: Blob[];
}

export const api = {
  // AUTH
  login: (req: LoginRequest) => json<Me>("POST", "/api/auth/login", req),
  logout: () => json<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => json<Me>("GET", "/api/me"),
  setLang: (lang: Lang) => json<Me>("PUT", "/api/me/lang", { lang }),

  // STORES / USERS
  stores: () => json<Store[]>("GET", "/api/stores"),
  createStore: (s: StoreInput) => json<Store>("POST", "/api/stores", s),
  users: () => json<UserRow[]>("GET", "/api/users"),
  createUser: (u: UserInput) => json<UserRow>("POST", "/api/users", u),

  // CAPTURE
  uploadDocument: (c: CaptureUpload) => {
    const fd = new FormData();
    fd.set("storeId", c.storeId);
    fd.set("clientId", c.clientId);
    fd.set("qr", JSON.stringify(c.qr));
    c.pages.forEach((p, i) => fd.append("page", p, p.type === "application/pdf" ? `page-${i + 1}.pdf` : `page-${i + 1}.jpg`));
    return json<CaptureResponse>("POST", "/api/documents", fd);
  },
  pageUrl: (documentId: string, n: number) => `/api/documents/${enc(documentId)}/pages/${n}`,

  // INVOICES
  invoices: (p: { state?: InvoiceState | ""; storeId?: string; q?: string; limit?: number; cursor?: string } = {}) =>
    json<Page<InvoiceSummary>>("GET", `/api/invoices${qs(p)}`),
  invoice: (id: string) => json<InvoiceDetail>("GET", `/api/invoices/${enc(id)}`),
  lockTotal: (id: string, typedTotalPaise: number) => json<LockTotalResponse>("POST", `/api/invoices/${enc(id)}/lock-total`, { typedTotalPaise }),
  updateHeader: (id: string, u: HeaderUpdate) => json<InvoiceDetail>("PUT", `/api/invoices/${enc(id)}/header`, u),
  updateLine: (id: string, lineId: string, u: LineUpdate) => json<InvoiceDetail>("PUT", `/api/invoices/${enc(id)}/lines/${enc(lineId)}`, u),
  addLine: (id: string, line: LineInput) => json<InvoiceDetail>("POST", `/api/invoices/${enc(id)}/lines`, line),
  seal: (id: string, durationMs: number) => json<InvoiceDetail>("POST", `/api/invoices/${enc(id)}/seal`, { durationMs }),
  reject: (id: string, reason: string) => json<InvoiceDetail>("POST", `/api/invoices/${enc(id)}/reject`, { reason }),
  hold: (id: string, reason: string) => json<InvoiceDetail>("POST", `/api/invoices/${enc(id)}/hold`, { reason }),
  unhold: (id: string) => json<InvoiceDetail>("POST", `/api/invoices/${enc(id)}/unhold`),
  reExtract: (id: string) => json<InvoiceDetail>("POST", `/api/invoices/${enc(id)}/re-extract`),

  // VENDORS
  vendors: (p: { q?: string; status?: VendorStatus | "" } = {}) => json<VendorSummary[]>("GET", `/api/vendors${qs(p)}`),
  vendor: (id: string) => json<VendorDetail>("GET", `/api/vendors/${enc(id)}`),
  createVendor: (v: VendorInput) => json<VendorDetail>("POST", "/api/vendors", v),
  updateVendor: (id: string, v: VendorInput) => json<VendorDetail>("PUT", `/api/vendors/${enc(id)}`, v),
  approveVendor: (id: string) => json<VendorDetail>("POST", `/api/vendors/${enc(id)}/approve`),
  addBank: (id: string, b: BankInput) => json<VendorDetail>("POST", `/api/vendors/${enc(id)}/bank`, b),
  approveBank: (id: string, versionId: string) => json<VendorDetail>("POST", `/api/vendors/${enc(id)}/bank/${enc(versionId)}/approve`),

  // PAYABLES & RUNS
  payables: (due: "overdue" | "today" | "week" | "all") => json<PayablesResponse>("GET", `/api/payables${qs({ due })}`),
  createRun: (invoiceIds: string[], valueDate: string) => json<PaymentRunDetail>("POST", "/api/payment-runs", { invoiceIds, valueDate }),
  runs: () => json<PaymentRunSummary[]>("GET", "/api/payment-runs"),
  run: (id: string) => json<PaymentRunDetail>("GET", `/api/payment-runs/${enc(id)}`),
  approveRun: (id: string) => json<PaymentRunDetail>("POST", `/api/payment-runs/${enc(id)}/approve`),
  runFile: async (id: string) => {
    const res = await send("GET", `/api/payment-runs/${enc(id)}/file`);
    return { text: await res.text(), fileName: fileNameFromDisposition(res.headers.get("Content-Disposition")) };
  },
  adviceCsv: async (id: string) => {
    const res = await send("GET", `/api/payment-runs/${enc(id)}/advice.csv`);
    return { text: await res.text(), fileName: fileNameFromDisposition(res.headers.get("Content-Disposition")) };
  },
  markUploaded: (id: string) => json<PaymentRunDetail>("POST", `/api/payment-runs/${enc(id)}/mark-uploaded`),
  markPaid: (id: string, utrs?: Record<string, string>) => json<PaymentRunDetail>("POST", `/api/payment-runs/${enc(id)}/mark-paid`, utrs ? { utrs } : {}),
  markFailed: (id: string, itemId: string, reason: string) =>
    json<PaymentRunDetail>("POST", `/api/payment-runs/${enc(id)}/items/${enc(itemId)}/mark-failed`, { reason }),
  cancelRun: (id: string) => json<PaymentRunDetail>("POST", `/api/payment-runs/${enc(id)}/cancel`),

  // DASHBOARD & SETTINGS
  dashboard: () => json<Dashboard>("GET", "/api/dashboard"),
  settings: () => json<Settings>("GET", "/api/settings"),
  audit: (entity: string, id: string) => json<AuditEntry[]>("GET", `/api/audit${qs({ entity, id })}`),
  health: () => json<{ ok: true; version: string }>("GET", "/api/health"),
};

export type Api = typeof api;

/** Message to show a person for any error. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
