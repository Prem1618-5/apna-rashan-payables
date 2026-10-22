/** Field encryption, hashing, PIN hashing and masking. */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const VERSION = "v1";

/**
 * AES-256-GCM. Output: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
 * `aad` binds the ciphertext to its purpose (e.g. "bank_account") so values can't be swapped between columns.
 */
export function encrypt(plain: string, key: Buffer, aad = ""): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(token: string, key: Buffer, aad = ""): string {
  const [v, iv, tag, ct] = token.split(":");
  if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error("unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** Deterministic keyed hash for equality lookups on encrypted values (duplicate account detection). */
export function blindIndex(value: string, key: Buffer, purpose: string): Buffer {
  const sub = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `arad-blind-index:${purpose}`, 32));
  return createHmac("sha256", sub).update(value, "utf8").digest();
}

/** "50200012345678" -> "XXXXXXXXXX5678". Never shows more than the last 4. */
export function maskAccount(account: string): string {
  const a = account.replace(/\s+/g, "");
  const last = a.slice(-4);
  return "X".repeat(Math.max(a.length - 4, 2)) + last;
}

export function maskFromLast4(last4: string, length = 10): string {
  return "X".repeat(Math.max(length - last4.length, 2)) + last4;
}

/** Last 4 chars of a secret, e.g. for showing which key is configured. */
export function maskSecret(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  return secret.length <= 4 ? "****" : `****${secret.slice(-4)}`;
}

export const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

// ---------------------------------------------------------------- PINs

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(pin, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Used to spend the same time when the phone number is unknown (no user enumeration by timing). */
export const DUMMY_PIN_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// ---------------------------------------------------------------- sessions

export const newSessionToken = () => randomBytes(32).toString("base64url");

/** Session tokens are stored only as HMAC(SESSION_SECRET, token). */
export const hashSessionToken = (token: string, secret: string) => createHmac("sha256", secret).update(token, "utf8").digest();
