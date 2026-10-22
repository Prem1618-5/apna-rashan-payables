/** Routes HTTP-shaped calls from the API client to the in-browser MockServer. */
import type { Transport } from "../client";
import { HttpError, MockServer, session } from "./server";

let server: MockServer | undefined;
export function mockServer(): MockServer {
  if (!server) server = new MockServer();
  return server;
}

/** Wipes the demo data; the next call re-seeds. */
export function resetMock() {
  mockServer().reset();
  server = undefined;
}

type Handler = (ctx: { m: string[]; q: URLSearchParams; body: unknown; sid: string | undefined }) => unknown;
const S = () => mockServer();
const U = (sid: string | undefined) => S().requireUser(sid);
const b = <T>(body: unknown) => (body ?? {}) as T;

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/health$/, () => ({ ok: true, version: "mock" })],
  ["POST", /^\/api\/auth\/login$/, ({ body }) => {
    const { phone, pin } = b<{ phone?: string; pin?: string }>(body);
    const r = S().login(String(phone ?? ""), String(pin ?? ""));
    session.set(r.sid);
    return r.me;
  }],
  ["POST", /^\/api\/auth\/logout$/, () => {
    session.set(undefined);
    return { ok: true };
  }],
  ["GET", /^\/api\/me$/, ({ sid }) => S().me(U(sid))],
  ["PUT", /^\/api\/me\/lang$/, ({ sid, body }) => S().setLang(U(sid), b<{ lang?: string }>(body).lang)],
  ["GET", /^\/api\/stores$/, ({ sid }) => S().stores(U(sid))],
  ["POST", /^\/api\/stores$/, ({ sid, body }) => S().createStore(U(sid), b(body))],
  ["GET", /^\/api\/users$/, ({ sid }) => S().users(U(sid))],
  ["POST", /^\/api\/users$/, ({ sid, body }) => S().createUser(U(sid), b(body))],
  ["POST", /^\/api\/documents$/, ({ sid, body }) => {
    const u = U(sid);
    if (!(body instanceof FormData)) throw new HttpError(400, "bad_request", "multipart form expected");
    let qr: string[] = [];
    try {
      qr = JSON.parse(String(body.get("qr") ?? "[]")) as string[];
    } catch {
      throw new HttpError(400, "bad_request", "qr must be a JSON array");
    }
    const pages = body.getAll("page").filter((p): p is File => typeof p !== "string");
    return S().capture(u, { storeId: String(body.get("storeId") ?? ""), clientId: String(body.get("clientId") ?? ""), qr, pages });
  }],
  ["GET", /^\/api\/invoices$/, ({ sid, q }) => S().invoices(U(sid), q)],
  ["GET", /^\/api\/invoices\/([^/]+)$/, ({ sid, m }) => S().getInvoice(U(sid), m[1]!)],
  ["POST", /^\/api\/invoices\/([^/]+)\/lock-total$/, ({ sid, m, body }) => S().lockTotal(U(sid), m[1]!, b<{ typedTotalPaise?: unknown }>(body).typedTotalPaise)],
  ["PUT", /^\/api\/invoices\/([^/]+)\/header$/, ({ sid, m, body }) => S().updateHeader(U(sid), m[1]!, b(body))],
  ["PUT", /^\/api\/invoices\/([^/]+)\/lines\/([^/]+)$/, ({ sid, m, body }) => S().updateLine(U(sid), m[1]!, m[2]!, b(body))],
  ["POST", /^\/api\/invoices\/([^/]+)\/lines$/, ({ sid, m, body }) => S().addLine(U(sid), m[1]!, b(body))],
  ["POST", /^\/api\/invoices\/([^/]+)\/seal$/, ({ sid, m, body }) => S().seal(U(sid), m[1]!, b<{ durationMs?: unknown }>(body).durationMs)],
  ["POST", /^\/api\/invoices\/([^/]+)\/(reject|hold|unhold|re-extract)$/, ({ sid, m, body }) =>
    S().setState(U(sid), m[1]!, m[2] as "reject" | "hold" | "unhold" | "re-extract", b<{ reason?: string }>(body).reason)],
  ["GET", /^\/api\/vendors$/, ({ sid, q }) => S().vendors(U(sid), q)],
  ["GET", /^\/api\/vendors\/([^/]+)$/, ({ sid, m }) => S().getVendor(U(sid), m[1]!)],
  ["POST", /^\/api\/vendors$/, ({ sid, body }) => S().createVendor(U(sid), b(body))],
  ["PUT", /^\/api\/vendors\/([^/]+)$/, ({ sid, m, body }) => S().updateVendor(U(sid), m[1]!, b(body))],
  ["POST", /^\/api\/vendors\/([^/]+)\/approve$/, ({ sid, m }) => S().approveVendor(U(sid), m[1]!)],
  ["POST", /^\/api\/vendors\/([^/]+)\/bank$/, ({ sid, m, body }) => S().addBank(U(sid), m[1]!, b(body))],
  ["POST", /^\/api\/vendors\/([^/]+)\/bank\/([^/]+)\/approve$/, ({ sid, m }) => S().approveBank(U(sid), m[1]!, m[2]!)],
  ["GET", /^\/api\/payables$/, ({ sid, q }) => S().payables(U(sid), q.get("due"))],
  ["POST", /^\/api\/payment-runs$/, ({ sid, body }) => {
    const { invoiceIds, valueDate } = b<{ invoiceIds?: unknown; valueDate?: unknown }>(body);
    return S().createRun(U(sid), invoiceIds, valueDate);
  }],
  ["GET", /^\/api\/payment-runs$/, ({ sid }) => S().runs(U(sid))],
  ["GET", /^\/api\/payment-runs\/([^/]+)$/, ({ sid, m }) => S().getRun(U(sid), m[1]!)],
  ["POST", /^\/api\/payment-runs\/([^/]+)\/approve$/, ({ sid, m }) => S().approveRun(U(sid), m[1]!)],
  ["POST", /^\/api\/payment-runs\/([^/]+)\/mark-uploaded$/, ({ sid, m }) => S().markUploaded(U(sid), m[1]!)],
  ["POST", /^\/api\/payment-runs\/([^/]+)\/mark-paid$/, ({ sid, m, body }) => S().markPaid(U(sid), m[1]!, b<{ utrs?: Record<string, string> }>(body).utrs)],
  ["POST", /^\/api\/payment-runs\/([^/]+)\/items\/([^/]+)\/mark-failed$/, ({ sid, m, body }) => S().markFailed(U(sid), m[1]!, m[2]!, b<{ reason?: string }>(body).reason)],
  ["POST", /^\/api\/payment-runs\/([^/]+)\/cancel$/, ({ sid, m }) => S().cancelRun(U(sid), m[1]!)],
  ["GET", /^\/api\/dashboard$/, ({ sid }) => S().dashboard(U(sid))],
  ["GET", /^\/api\/settings$/, ({ sid }) => S().settings(U(sid))],
  ["GET", /^\/api\/audit$/, ({ sid, q }) => S().auditFor(U(sid), q.get("entity"), q.get("id"))],
];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const attachment = (name: string, content: string, type: string) =>
  new Response(content, { status: 200, headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"` } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answers a request the way services/api would, with a little latency so loading states are real. */
export const mockTransport: Transport = async (method, path, body) => {
  const url = new URL(path, "http://mock.local");
  await sleep(method === "GET" ? 90 + Math.random() * 160 : 140 + Math.random() * 220);
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new TypeError("Failed to fetch");
  const sid = session.get();
  try {
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/api\/payment-runs\/([^/]+)\/file$/.exec(url.pathname))) {
      const f = S().runFile(U(sid), m[1]!);
      return attachment(f.name, f.content, "text/plain; charset=us-ascii");
    }
    if (method === "GET" && (m = /^\/api\/payment-runs\/([^/]+)\/advice\.csv$/.exec(url.pathname))) {
      const f = S().adviceCsv(U(sid), m[1]!);
      return attachment(f.name, f.content, "text/csv; charset=utf-8");
    }
    if (method === "GET" && (m = /^\/api\/documents\/([^/]+)\/pages\/(\d+)$/.exec(url.pathname))) {
      U(sid);
      const svg = S().pageSvg(m[1]!, Number(m[2]));
      if (!svg) throw new HttpError(404, "not_found", "Page not found");
      return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
    }
    for (const [rm, re, fn] of routes) {
      if (rm !== method) continue;
      const match = re.exec(url.pathname);
      if (match) return json(await fn({ m: [...match], q: url.searchParams, body, sid }));
    }
    throw new HttpError(404, "not_found", `No route ${method} ${url.pathname}`);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message, details: e.details } }, e.status);
    console.error("[mock]", e);
    return json({ error: { code: "internal", message: e instanceof Error ? e.message : "Server error" } }, 500);
  }
};
