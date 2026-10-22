import type { Extractor, Lang, Role } from "@arad/core";
import type { Config } from "./config.js";
import type { Pool } from "./db.js";
import type { Storage } from "./storage.js";
import type { Actor } from "./audit.js";
import { forbidden } from "./errors.js";

export interface AppContext {
  config: Config;
  pool: Pool;
  storage: Storage;
  extractor: Extractor;
}

export interface SessionUser {
  id: string;
  name: string;
  phone: string;
  role: Role;
  lang: Lang;
  /** Stores this user may see. For the owner: every store. */
  storeIds: string[];
  sessionId: string;
}

export const actorOf = (u: Pick<SessionUser, "id" | "name">): Actor => ({ id: u.id, name: u.name });

export const isOwner = (u: SessionUser) => u.role === "owner";

export function canAccessStore(u: SessionUser, storeId: string): boolean {
  return u.role === "owner" || u.storeIds.includes(storeId);
}

export function assertStoreAccess(u: SessionUser, storeId: string): void {
  if (!canAccessStore(u, storeId)) throw forbidden("You do not have access to this store");
}

export function assertOwner(u: SessionUser): void {
  if (u.role !== "owner") throw forbidden("Only the owner can do this");
}

/**
 * SQL fragment restricting `column` to the user's stores. Appends the parameter to `params`.
 * Owner: no restriction.
 */
export function storeScope(u: SessionUser, column: string, params: unknown[]): string {
  if (u.role === "owner") return "TRUE";
  params.push(u.storeIds);
  return `${column} = ANY($${params.length}::uuid[])`;
}
