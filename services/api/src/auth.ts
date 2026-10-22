/** Phone + PIN login, opaque session cookie "sid" (stored hashed), role + store scoping on every /api request. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Lang, Me, Role } from "@arad/core";
import { audit, SYSTEM } from "./audit.js";
import type { AppContext, SessionUser } from "./context.js";
import { DUMMY_PIN_HASH, hashPin, hashSessionToken, newSessionToken, verifyPin } from "./crypto.js";
import { many, one, tx, type Db, type Pool } from "./db.js";
import { ApiError, forbidden, unauthorized } from "./errors.js";
import type { Config } from "./config.js";

export const SESSION_COOKIE = "sid";
export const SESSION_HOURS = 12;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export type AuthMode = "public" | "user" | "owner";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
  interface FastifyContextConfig {
    /** Default "user" for every /api route. */
    auth?: AuthMode;
  }
}

export function cookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  };
}

interface SessionRow {
  session_id: string;
  expires_at: Date;
  id: string;
  name: string;
  phone: string;
  role: Role;
  lang: Lang;
  store_ids: string[];
}

async function allStoreIds(db: Db): Promise<string[]> {
  return (await many<{ id: string }>(db, "SELECT id FROM stores ORDER BY code")).map((r) => r.id);
}

export async function loadSession(ctx: AppContext, token: string): Promise<{ user: SessionUser; slid: boolean } | undefined> {
  const hash = hashSessionToken(token, ctx.config.SESSION_SECRET);
  const row = await one<SessionRow>(
    ctx.pool,
    `SELECT s.id AS session_id, s.expires_at, u.id, u.name, u.phone, u.role, u.lang,
            coalesce(array_agg(us.store_id ORDER BY us.store_id) FILTER (WHERE us.store_id IS NOT NULL), '{}') AS store_ids
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.active
       LEFT JOIN user_stores us ON us.user_id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      GROUP BY s.id, u.id`,
    [hash],
  );
  if (!row) return undefined;
  // Sliding expiry, written at most every 5 minutes per session.
  const slide = await ctx.pool.query(
    `UPDATE sessions SET expires_at = now() + ($2::int * interval '1 hour'), last_seen_at = now()
      WHERE id = $1 AND expires_at < now() + ($2::int * interval '1 hour') - interval '5 minutes'`,
    [row.session_id, SESSION_HOURS],
  );
  const storeIds = row.role === "owner" ? await allStoreIds(ctx.pool) : row.store_ids;
  return {
    user: { id: row.id, name: row.name, phone: row.phone, role: row.role, lang: row.lang, storeIds, sessionId: row.session_id },
    slid: (slide.rowCount ?? 0) > 0,
  };
}

export function meOf(u: SessionUser): Me {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, storeIds: u.storeIds, lang: u.lang };
}

interface UserAuthRow {
  id: string;
  name: string;
  pin_hash: string;
  active: boolean;
  failed_logins: number;
  locked_until: Date | null;
}

export async function login(ctx: AppContext, phone: string, pin: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; user: SessionUser }> {
  const bad = new ApiError(401, "INVALID_LOGIN", "Phone number or PIN is wrong");
  const u = await one<UserAuthRow>(ctx.pool, "SELECT id, name, pin_hash, active, failed_logins, locked_until FROM users WHERE phone = $1", [phone]);
  if (!u) {
    await verifyPin(pin, DUMMY_PIN_HASH); // same time as a real check
    throw bad;
  }
  if (u.locked_until && u.locked_until > new Date()) {
    const minutes = Math.max(1, Math.ceil((u.locked_until.getTime() - Date.now()) / 60_000));
    throw new ApiError(423, "ACCOUNT_LOCKED", `Too many wrong PINs. Try again in ${minutes} minute(s) or ask the owner.`, { retryAfterMinutes: minutes });
  }
  const ok = await verifyPin(pin, u.pin_hash);
  if (!ok || !u.active) {
    if (!u.active) throw bad;
    await tx(ctx.pool, async (c) => {
      const r = await one<{ failed_logins: number }>(c, "UPDATE users SET failed_logins = failed_logins + 1, updated_at = now() WHERE id = $1 RETURNING failed_logins", [u.id]);
      if (r && r.failed_logins >= MAX_FAILED_LOGINS) {
        await c.query(`UPDATE users SET failed_logins = 0, locked_until = now() + ($2::int * interval '1 minute') WHERE id = $1`, [u.id, LOCKOUT_MINUTES]);
        await audit(c, SYSTEM, { action: "user.locked", entity: "user", entityId: u.id, detail: { minutes: LOCKOUT_MINUTES, ip: meta.ip } });
      }
    });
    throw bad;
  }
  const token = newSessionToken();
  await tx(ctx.pool, async (c) => {
    await c.query("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [u.id]);
    await c.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, now() + ($3::int * interval '1 hour'), $4, $5)`,
      [hashSessionToken(token, ctx.config.SESSION_SECRET), u.id, SESSION_HOURS, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
    );
    await audit(c, { id: u.id, name: u.name }, { action: "auth.login", entity: "user", entityId: u.id, detail: { ip: meta.ip } });
    // Housekeeping: drop this user's expired sessions.
    await c.query("DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()", [u.id]);
  });
  const session = await loadSession(ctx, token);
  if (!session) throw new Error("session vanished right after login");
  return { token, user: session.user };
}

export async function logout(ctx: AppContext, user: SessionUser): Promise<void> {
  await tx(ctx.pool, async (c) => {
    await c.query("DELETE FROM sessions WHERE id = $1", [user.sessionId]);
    await audit(c, { id: user.id, name: user.name }, { action: "auth.logout", entity: "user", entityId: user.id });
  });
}

/** Registers the onRequest hook that authenticates every /api route and enforces the route's role. */
export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/") && req.url !== "/api") return;
    const mode: AuthMode = req.routeOptions.config?.auth ?? "user";
    if (mode === "public") return;
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw unauthorized();
    const session = await loadSession(ctx, token);
    if (!session) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      throw new ApiError(401, "SESSION_EXPIRED", "Your session has ended. Please log in again.");
    }
    if (session.slid) reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx.config));
    req.user = session.user;
    if (mode === "owner" && session.user.role !== "owner") throw forbidden("Only the owner can do this");
  });
}

/** The authenticated user (the hook guarantees it for non-public routes). */
export function userOf(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** First boot: create the owner from SEED_OWNER_* when there are no users at all. */
export async function ensureOwner(pool: Pool, config: Config, log: { info(o: object, m?: string): void; warn(o: object, m?: string): void }): Promise<void> {
  const any = await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM users");
  if ((any?.n ?? 0) > 0) return;
  if (!config.SEED_OWNER_PIN || !config.SEED_OWNER_PHONE) {
    log.warn({}, "no users exist; set SEED_OWNER_PHONE and SEED_OWNER_PIN to create the owner on first boot");
    return;
  }
  const pinHash = await hashPin(config.SEED_OWNER_PIN);
  await tx(pool, async (c) => {
    const r = await one<{ id: string }>(
      c,
      `INSERT INTO users (name, phone, pin_hash, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT (phone) DO NOTHING RETURNING id`,
      [config.SEED_OWNER_NAME, config.SEED_OWNER_PHONE, pinHash],
    );
    if (r) await audit(c, SYSTEM, { action: "user.create", entity: "user", entityId: r.id, detail: { role: "owner", phone: config.SEED_OWNER_PHONE, source: "first_boot" } });
  });
  log.info({}, "created owner account on first boot");
}
