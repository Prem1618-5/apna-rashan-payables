/**
 * Runtime configuration. Parsed once from process.env (twelve-factor) and validated.
 * Every variable is documented in the repo's .env.example.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const DEV_SESSION_SECRET = "change-me-to-a-long-random-string-at-least-32-chars";

/** Treat empty strings as "not set" so `FOO=` in .env behaves like a missing variable. */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const bool = (def: boolean) =>
  z.preprocess(
    (v) => {
      const b = blank(v);
      if (b === undefined) return def;
      if (typeof b === "boolean") return b;
      const s = String(b).trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return true;
      if (["false", "0", "no", "off"].includes(s)) return false;
      return s; // fails the boolean check below with a clear message
    },
    z.boolean({ error: "must be true or false" }),
  );

const int = (def: number, min: number, max: number) =>
  z.preprocess((v) => {
    const b = blank(v);
    return b === undefined ? def : Number(b);
  }, z.number({ error: "must be a number" }).int("must be a whole number").min(min).max(max));

const optStr = z.preprocess(blank, z.string().optional());

const schema = z
  .object({
    NODE_ENV: z.preprocess((v) => blank(v) ?? "development", z.enum(["development", "test", "production"])),
    PORT: int(8080, 1, 65535),
    LOG_LEVEL: z.preprocess((v) => blank(v) ?? "info", z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])),
    WEB_DIST: optStr,
    RUN_WORKER: bool(true),

    DATABASE_URL: z.preprocess(blank, z.string({ error: "is required (postgres://user:pass@host:port/db)" }).regex(/^postgres(ql)?:\/\//, "must start with postgres://")),
    DATABASE_POOL_MAX: int(10, 1, 200),

    STORAGE_DRIVER: z.preprocess((v) => blank(v) ?? "fs", z.enum(["fs", "s3"])),
    STORAGE_DIR: z.preprocess((v) => blank(v) ?? "data/uploads", z.string()),
    S3_BUCKET: optStr,
    AWS_REGION: z.preprocess((v) => blank(v) ?? "ap-south-1", z.string()),
    /** Optional, for MinIO / S3-compatible stores. Empty = AWS. Credentials come from the SDK default chain. */
    S3_ENDPOINT: z.preprocess(blank, z.string().url("must be a URL like http://minio:9000").optional()),
    S3_FORCE_PATH_STYLE: bool(false),

    SESSION_SECRET: z.preprocess(blank, z.string({ error: "is required" }).min(32, "must be at least 32 characters")),
    DATA_ENCRYPTION_KEY: optStr,

    /** Login attempts per client IP per minute (on top of the per-account lockout). */
    LOGIN_RATE_LIMIT_PER_MIN: int(10, 1, 10_000),

    EXTRACTOR: z.preprocess((v) => blank(v) ?? "auto", z.enum(["auto", "mock"])),
    DATA_CLASS: z.preprocess((v) => blank(v) ?? "synthetic", z.enum(["synthetic", "real"])),

    HDFC_CLIENT_CODE: optStr,
    RTGS_FROM_PAISE: int(2_00_000_00, 1, Number.MAX_SAFE_INTEGER),
    COOLING_OFF_HOURS: int(24, 0, 24 * 30),
    REQUIRE_DIFFERENT_APPROVER: bool(true),

    SEED_OWNER_NAME: z.preprocess((v) => blank(v) ?? "Owner", z.string()),
    SEED_OWNER_PHONE: optStr,
    SEED_OWNER_PIN: optStr,
  })
  .superRefine((c, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (c.STORAGE_DRIVER === "s3" && !c.S3_BUCKET) issue("S3_BUCKET", "is required when STORAGE_DRIVER=s3");
    if (c.NODE_ENV === "production") {
      if (c.SESSION_SECRET === DEV_SESSION_SECRET) issue("SESSION_SECRET", "is still the example value; generate one with: openssl rand -base64 32");
      if (!c.DATA_ENCRYPTION_KEY) issue("DATA_ENCRYPTION_KEY", "is required in production (openssl rand -base64 32)");
    }
    if (c.DATA_ENCRYPTION_KEY && decodeKey(c.DATA_ENCRYPTION_KEY) === undefined) {
      issue("DATA_ENCRYPTION_KEY", "must be 32 bytes encoded as base64 (openssl rand -base64 32) or 64 hex characters");
    }
    if (c.HDFC_CLIENT_CODE && !/^[A-Z0-9]{1,20}$/.test(c.HDFC_CLIENT_CODE)) issue("HDFC_CLIENT_CODE", "must be 1-20 capital letters or digits");
    if (c.SEED_OWNER_PIN && !/^\d{4,6}$/.test(c.SEED_OWNER_PIN)) issue("SEED_OWNER_PIN", "must be 4-6 digits");
    if (c.SEED_OWNER_PHONE && !/^[6-9]\d{9}$/.test(c.SEED_OWNER_PHONE)) issue("SEED_OWNER_PHONE", "must be a 10-digit Indian mobile number");
  });

export type RawConfig = z.infer<typeof schema>;

export interface Config extends Omit<RawConfig, "DATA_ENCRYPTION_KEY" | "WEB_DIST" | "STORAGE_DIR"> {
  /** 32-byte AES-256 key for bank fields and bank files. */
  dataKey: Buffer;
  /** True when DATA_ENCRYPTION_KEY was not set and a dev-only key was derived. */
  dataKeyDerived: boolean;
  /** Absolute path or undefined (don't serve the PWA). */
  WEB_DIST?: string;
  /** Absolute path. */
  STORAGE_DIR: string;
  isProd: boolean;
  version: string;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

function decodeKey(text: string): Buffer | undefined {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    const b = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return b;
  }
  return undefined;
}

/** Repo-relative paths in .env.example are resolved from the workspace root (where pnpm-workspace.yaml is). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const c = parsed.data;
  const root = findRepoRoot();
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p));

  let dataKey = c.DATA_ENCRYPTION_KEY ? decodeKey(c.DATA_ENCRYPTION_KEY) : undefined;
  const dataKeyDerived = !dataKey;
  // Dev/test convenience only (production requires the variable, checked above).
  if (!dataKey) dataKey = createHash("sha256").update(`arad-dev-data-key:${c.SESSION_SECRET}`).digest();

  const { DATA_ENCRYPTION_KEY: _k, ...rest } = c;
  return {
    ...rest,
    WEB_DIST: c.WEB_DIST ? abs(c.WEB_DIST) : undefined,
    STORAGE_DIR: abs(c.STORAGE_DIR),
    dataKey,
    dataKeyDerived,
    isProd: c.NODE_ENV === "production",
    version: env.APP_VERSION || env.GIT_SHA || "0.1.0",
  };
}
