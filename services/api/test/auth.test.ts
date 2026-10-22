import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, json, login, seedBasic, upload, type Fixture, type TestEnv } from "./helpers.js";

let env: TestEnv;
let fx: Fixture;

beforeAll(async () => {
  env = await createTestEnv();
  fx = await seedBasic(env.pool);
});
afterAll(() => env.close());

describe("health and headers", () => {
  it("answers /api/health without auth, with security headers", async () => {
    const res = await env.app.inject({ url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ ok: true });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' blob: data:");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("uses the error format for unknown routes and missing sessions", async () => {
    const res = await env.app.inject({ url: "/api/invoices" });
    expect(res.statusCode).toBe(401);
    expect(json(res).error.code).toBe("UNAUTHORIZED");
  });
});

describe("login", () => {
  it("logs in with phone + PIN and sets an httpOnly SameSite=Lax cookie", async () => {
    const res = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: fx.owner.phone, pin: fx.owner.pin } });
    expect(res.statusCode).toBe(200);
    const me = json(res);
    expect(me).toMatchObject({ role: "owner", phone: fx.owner.phone, lang: "en" });
    expect(me.storeIds).toHaveLength(2);
    const cookie = res.cookies.find((c) => c.name === "sid")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.secure).toBeFalsy(); // not production
    // Stored hashed, never the raw token.
    const s = await env.pool.query("SELECT encode(token_hash, 'hex') AS h FROM sessions");
    expect(s.rows.map((r) => r.h)).not.toContain(cookie.value);
  });

  it("rejects a wrong PIN and locks the account after 5 failures", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: fx.staffB.phone, pin: "9999" } });
      expect(r.statusCode).toBe(401);
      expect(json(r).error.code).toBe("INVALID_LOGIN");
    }
    const locked = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: fx.staffB.phone, pin: fx.staffB.pin } });
    expect(locked.statusCode).toBe(423);
    expect(json(locked).error.code).toBe("ACCOUNT_LOCKED");
    await env.pool.query("UPDATE users SET locked_until = NULL WHERE id = $1", [fx.staffB.id]);
    const unknown = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "9999999999", pin: "1234" } });
    expect(unknown.statusCode).toBe(401);
  });

  it("validates input", async () => {
    const r = await env.app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "123", pin: "x" } });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.code).toBe("VALIDATION");
  });

  it("serves /api/me, changes language and logs out", async () => {
    const cookie = await login(env.app, fx.staffA);
    const me = await env.app.inject({ url: "/api/me", headers: { cookie } });
    expect(json(me)).toMatchObject({ role: "staff", storeIds: [fx.storeA] });
    const lang = await env.app.inject({ method: "PUT", url: "/api/me/lang", headers: { cookie }, payload: { lang: "hi" } });
    expect(json(lang).lang).toBe("hi");
    const out = await env.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const after = await env.app.inject({ url: "/api/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("rate-limits login per IP", async () => {
    const limited = await createTestEnv({ LOGIN_RATE_LIMIT_PER_MIN: "3" });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        codes.push((await limited.app.inject({ method: "POST", url: "/api/auth/login", payload: { phone: "9000000001", pin: "0000" } })).statusCode);
      }
      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes[4]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe("roles and store scoping", () => {
  it("staff cannot read another store's invoice, list it, or capture into that store", async () => {
    const a = await login(env.app, fx.staffA);
    const b = await login(env.app, fx.staffB);
    const cap = await upload(env.app, a, { storeId: fx.storeA });
    expect(cap.statusCode).toBe(201);
    const { invoiceId, documentId } = json(cap);

    expect((await env.app.inject({ url: `/api/invoices/${invoiceId}`, headers: { cookie: a } })).statusCode).toBe(200);
    const other = await env.app.inject({ url: `/api/invoices/${invoiceId}`, headers: { cookie: b } });
    expect(other.statusCode).toBe(404);
    expect((await env.app.inject({ url: `/api/documents/${documentId}/pages/1`, headers: { cookie: b } })).statusCode).toBe(404);
    const list = json(await env.app.inject({ url: "/api/invoices", headers: { cookie: b } }));
    expect(list.items).toHaveLength(0);
    const listA = json(await env.app.inject({ url: "/api/invoices", headers: { cookie: a } }));
    expect(listA.items.map((i: { id: string }) => i.id)).toContain(invoiceId);
    const capB = await upload(env.app, b, { storeId: fx.storeA });
    expect(capB.statusCode).toBe(403);
    // Mutations are scoped too.
    const hold = await env.app.inject({ method: "POST", url: `/api/invoices/${invoiceId}/reject`, headers: { cookie: b }, payload: { reason: "not mine" } });
    expect(hold.statusCode).toBe(404);

    const stores = json(await env.app.inject({ url: "/api/stores", headers: { cookie: b } }));
    expect(stores.map((s: { id: string }) => s.id)).toEqual([fx.storeB]);
  });

  it("owner-only routes refuse staff", async () => {
    const a = await login(env.app, fx.staffA);
    for (const url of ["/api/dashboard", "/api/settings", "/api/audit", "/api/users"]) {
      const r = await env.app.inject({ url, headers: { cookie: a } });
      expect(r.statusCode, url).toBe(403);
    }
    const o = await login(env.app, fx.owner);
    for (const url of ["/api/dashboard", "/api/settings", "/api/audit", "/api/users", "/api/stores"]) {
      const r = await env.app.inject({ url, headers: { cookie: o } });
      expect(r.statusCode, url).toBe(200);
    }
    const settings = json(await env.app.inject({ url: "/api/settings", headers: { cookie: o } }));
    expect(settings).toMatchObject({ hdfcClientCode: "ARAD01", coolingOffHours: 24, requireDifferentApprover: true });
    expect(settings.aiProviders[0]).toMatchObject({ id: "mock", trainsOnInput: false });
    expect(JSON.stringify(settings)).not.toMatch(/SECRET|secret/);
  });

  it("owner creates stores and users", async () => {
    const o = await login(env.app, fx.owner);
    const s = await env.app.inject({ method: "POST", url: "/api/stores", headers: { cookie: o }, payload: { code: "s3", name: "Store Three" } });
    expect(s.statusCode).toBe(201);
    expect(json(s).code).toBe("S3");
    const bad = await env.app.inject({ method: "POST", url: "/api/stores", headers: { cookie: o }, payload: { code: "S4", name: "X", gstin: "20AAAAA0000A1Z0" } });
    expect(json(bad).error.code).toBe("INVALID_GSTIN");
    const u = await env.app.inject({ method: "POST", url: "/api/users", headers: { cookie: o }, payload: { name: "New Staff", phone: "9123456780", pin: "4321", role: "staff", storeIds: [json(s).id] } });
    expect(u.statusCode).toBe(201);
    expect(json(u)).toMatchObject({ role: "staff", active: true, storeIds: [json(s).id] });
    expect(JSON.stringify(json(u))).not.toContain("4321");
    const dup = await env.app.inject({ method: "POST", url: "/api/users", headers: { cookie: o }, payload: { name: "Dup", phone: "9123456780", pin: "4321", role: "staff", storeIds: [json(s).id] } });
    expect(dup.statusCode).toBe(409);
    await login(env.app, { phone: "9123456780", pin: "4321" });
  });
});
