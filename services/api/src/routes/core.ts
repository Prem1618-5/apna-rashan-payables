/** Auth, me, stores, users, dashboard, settings, audit, health. */
import type { FastifyInstance } from "fastify";
import { isValidGstin, normalizeGstin, type Store, type UserRow } from "@arad/core";
import { z } from "zod";
import { audit } from "../audit.js";
import { cookieOptions, login, logout, meOf, SESSION_COOKIE, userOf } from "../auth.js";
import { actorOf, storeScope, type AppContext } from "../context.js";
import { hashPin } from "../crypto.js";
import { isUniqueViolation, many, one, tx } from "../db.js";
import { ApiError, conflict, parse } from "../errors.js";
import { auditEntries, dashboard, settings } from "../services/dashboard.js";

const phone = z.string().trim().regex(/^[6-9]\d{9}$/, "must be a 10-digit mobile number");
const pin = z.string().regex(/^\d{4,6}$/, "must be 4-6 digits");

export function coreRoutes(app: FastifyInstance, ctx: AppContext, opts: { loginRateLimit: number }) {
  app.get("/api/health", { config: { auth: "public" }, logLevel: "warn" }, async (_req, reply) => {
    try {
      await Promise.race([ctx.pool.query("SELECT 1"), new Promise((_, rej) => setTimeout(() => rej(new Error("db timeout")), 2000))]);
      return { ok: true, version: ctx.config.version };
    } catch {
      return reply.code(503).send({ ok: false, version: ctx.config.version, error: { code: "DB_UNAVAILABLE", message: "Database is not reachable" } });
    }
  });

  app.post(
    "/api/auth/login",
    { config: { auth: "public", rateLimit: { max: opts.loginRateLimit, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = parse(z.object({ phone, pin }), req.body);
      const { token, user } = await login(ctx, body.phone, body.pin, { ip: req.ip, userAgent: req.headers["user-agent"] });
      reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx.config));
      return meOf(user);
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    await logout(ctx, userOf(req));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => meOf(userOf(req)));

  app.put("/api/me/lang", async (req) => {
    const user = userOf(req);
    const { lang } = parse(z.object({ lang: z.enum(["en", "hi"]) }), req.body);
    await ctx.pool.query("UPDATE users SET lang = $2, updated_at = now() WHERE id = $1", [user.id, lang]);
    return meOf({ ...user, lang });
  });

  // ------------------------------------------------------------ stores

  const toStore = (r: { id: string; code: string; name: string; gstin: string | null; address: string | null }): Store => ({
    id: r.id,
    code: r.code,
    name: r.name,
    gstin: r.gstin ?? undefined,
    address: r.address ?? undefined,
  });

  app.get("/api/stores", async (req) => {
    const user = userOf(req);
    const params: unknown[] = [];
    const rows = await many<{ id: string; code: string; name: string; gstin: string | null; address: string | null }>(
      ctx.pool,
      `SELECT id, code, name, gstin, address FROM stores WHERE ${storeScope(user, "id", params)} ORDER BY code`,
      params,
    );
    return rows.map(toStore);
  });

  app.post("/api/stores", { config: { auth: "owner" } }, async (req, reply) => {
    const user = userOf(req);
    const body = parse(
      z.object({
        code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, "must be 1-10 letters or digits"),
        name: z.string().trim().min(1).max(100),
        gstin: z.string().optional(),
        address: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    const gstin = normalizeGstin(body.gstin);
    if (gstin && !isValidGstin(gstin)) throw new ApiError(400, "INVALID_GSTIN", "GSTIN is not valid");
    try {
      const row = await tx(ctx.pool, async (c) => {
        const r = await one<{ id: string; code: string; name: string; gstin: string | null; address: string | null }>(
          c,
          "INSERT INTO stores (code, name, gstin, address) VALUES ($1, $2, $3, $4) RETURNING id, code, name, gstin, address",
          [body.code, body.name, gstin ?? null, body.address || null],
        );
        await audit(c, actorOf(user), { action: "store.create", entity: "store", entityId: r!.id, detail: { code: body.code, name: body.name, gstin } });
        return r!;
      });
      return reply.code(201).send(toStore(row));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("DUPLICATE_STORE", "A store with this code or GSTIN already exists");
      throw e;
    }
  });

  // ------------------------------------------------------------ users

  async function userRows(where = "TRUE", params: unknown[] = []): Promise<UserRow[]> {
    const rows = await many<{ id: string; name: string; phone: string; role: "owner" | "staff"; active: boolean; store_ids: string[] }>(
      ctx.pool,
      `SELECT u.id, u.name, u.phone, u.role, u.active,
              coalesce(array_agg(us.store_id) FILTER (WHERE us.store_id IS NOT NULL), '{}') AS store_ids
         FROM users u LEFT JOIN user_stores us ON us.user_id = u.id
        WHERE ${where} GROUP BY u.id ORDER BY u.role, u.name`,
      params,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, role: r.role, storeIds: r.store_ids, active: r.active }));
  }

  app.get("/api/users", { config: { auth: "owner" } }, async () => userRows());

  app.post("/api/users", { config: { auth: "owner" } }, async (req, reply) => {
    const owner = userOf(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        phone,
        pin,
        role: z.enum(["owner", "staff"]),
        storeIds: z.array(z.string().uuid()).max(200).default([]),
      }),
      req.body,
    );
    if (body.role === "staff" && !body.storeIds.length) throw new ApiError(400, "STORE_REQUIRED", "Staff must belong to at least one store");
    const pinHash = await hashPin(body.pin);
    try {
      const id = await tx(ctx.pool, async (c) => {
        const known = await many<{ id: string }>(c, "SELECT id FROM stores WHERE id = ANY($1::uuid[])", [body.storeIds]);
        if (known.length !== new Set(body.storeIds).size) throw new ApiError(400, "UNKNOWN_STORE", "One or more stores do not exist");
        const r = await one<{ id: string }>(c, "INSERT INTO users (name, phone, pin_hash, role) VALUES ($1, $2, $3, $4) RETURNING id", [body.name, body.phone, pinHash, body.role]);
        for (const s of new Set(body.storeIds)) await c.query("INSERT INTO user_stores (user_id, store_id) VALUES ($1, $2)", [r!.id, s]);
        await audit(c, actorOf(owner), { action: "user.create", entity: "user", entityId: r!.id, detail: { name: body.name, role: body.role, storeIds: body.storeIds } });
        return r!.id;
      });
      const [row] = await userRows("u.id = $1", [id]);
      return reply.code(201).send(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict("DUPLICATE_PHONE", "A user with this phone number already exists");
      throw e;
    }
  });

  // ------------------------------------------------------------ owner views

  app.get("/api/dashboard", { config: { auth: "owner" } }, async (req) => dashboard(ctx, userOf(req)));
  app.get("/api/settings", { config: { auth: "owner" } }, async () => settings(ctx));
  app.get("/api/audit", { config: { auth: "owner" } }, async (req) => {
    const q = parse(z.object({ entity: z.string().max(40).optional(), id: z.string().max(80).optional(), limit: z.coerce.number().int().optional() }), req.query);
    return auditEntries(ctx, q);
  });
}
