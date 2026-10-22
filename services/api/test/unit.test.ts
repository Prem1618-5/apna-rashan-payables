import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { blindIndex, decrypt, encrypt, hashPin, hashSessionToken, maskAccount, maskFromLast4, maskSecret, verifyPin } from "../src/crypto.js";
import { backoffMs } from "../src/worker.js";
import { mockFixture } from "../src/extraction.js";
import { runChecks } from "@arad/core";

describe("crypto", () => {
  const key = randomBytes(32);

  it("encrypts with AES-256-GCM and decrypts back", () => {
    const ct = encrypt("50200012345678", key, "bank_account");
    expect(ct).toMatch(/^v1:/);
    expect(ct).not.toContain("50200012345678");
    expect(decrypt(ct, key, "bank_account")).toBe("50200012345678");
    // Random IV: same input, different ciphertext.
    expect(encrypt("50200012345678", key, "bank_account")).not.toBe(ct);
  });

  it("refuses a wrong key, wrong purpose or tampered ciphertext", () => {
    const ct = encrypt("123456789", key, "bank_account");
    expect(() => decrypt(ct, randomBytes(32), "bank_account")).toThrow();
    expect(() => decrypt(ct, key, "bank_file")).toThrow();
    const parts = ct.split(":");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] = body[0]! ^ 1;
    expect(() => decrypt([parts[0], parts[1], parts[2], body.toString("base64")].join(":"), key, "bank_account")).toThrow();
  });

  it("masks account numbers and secrets", () => {
    expect(maskAccount("50200012345678")).toBe("XXXXXXXXXX5678");
    expect(maskAccount("123456")).toBe("XX3456");
    expect(maskFromLast4("5678", 14)).toBe("XXXXXXXXXX5678");
    expect(maskSecret("AIzaSyD-very-secret-key")).toBe("****-key");
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it("blind index is deterministic per key and purpose", () => {
    expect(blindIndex("123", key, "a").equals(blindIndex("123", key, "a"))).toBe(true);
    expect(blindIndex("123", key, "a").equals(blindIndex("123", key, "b"))).toBe(false);
    expect(blindIndex("123", key, "a").equals(blindIndex("124", key, "a"))).toBe(false);
  });

  it("hashes PINs with scrypt and verifies", async () => {
    const h = await hashPin("1234");
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifyPin("1234", h)).toBe(true);
    expect(await verifyPin("1235", h)).toBe(false);
    expect(await verifyPin("1234", "garbage")).toBe(false);
  });

  it("session tokens are stored as HMACs", () => {
    expect(hashSessionToken("t", "s").length).toBe(32);
    expect(hashSessionToken("t", "s").equals(hashSessionToken("t", "s2"))).toBe(false);
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://a:b@localhost/db", SESSION_SECRET: "x".repeat(40) };

  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.RUN_WORKER).toBe(true);
    expect(c.STORAGE_DRIVER).toBe("fs");
    expect(c.RTGS_FROM_PAISE).toBe(20_000_000);
    expect(c.COOLING_OFF_HOURS).toBe(24);
    expect(c.REQUIRE_DIFFERENT_APPROVER).toBe(true);
    expect(c.dataKey.length).toBe(32);
    expect(c.dataKeyDerived).toBe(true);
    expect(c.STORAGE_DIR.startsWith("/")).toBe(true);
  });

  it("parses booleans, numbers and empty values", () => {
    const c = loadConfig({ ...base, RUN_WORKER: "false", PORT: "9090", COOLING_OFF_HOURS: "", S3_BUCKET: "", REQUIRE_DIFFERENT_APPROVER: "0" });
    expect(c.RUN_WORKER).toBe(false);
    expect(c.PORT).toBe(9090);
    expect(c.COOLING_OFF_HOURS).toBe(24);
    expect(c.S3_BUCKET).toBeUndefined();
    expect(c.REQUIRE_DIFFERENT_APPROVER).toBe(false);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ PORT: "abc", RUN_WORKER: "maybe", STORAGE_DRIVER: "s3", SESSION_SECRET: "short" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).problems.join("\n");
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("PORT");
      expect(msg).toContain("RUN_WORKER");
      expect(msg).toContain("SESSION_SECRET");
    }
  });

  it("requires S3_BUCKET for s3 and real secrets in production", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", SESSION_SECRET: "change-me-to-a-long-random-string-at-least-32-chars", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64") })).toThrow(
      /SESSION_SECRET/,
    );
    const ok = loadConfig({ ...base, NODE_ENV: "production", DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64") });
    expect(ok.isProd).toBe(true);
    expect(ok.dataKeyDerived).toBe(false);
  });

  it("validates the encryption key and HDFC client code", () => {
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: "too-short" })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(loadConfig({ ...base, DATA_ENCRYPTION_KEY: "ab".repeat(32) }).dataKey.length).toBe(32);
    expect(() => loadConfig({ ...base, HDFC_CLIENT_CODE: "bad code" })).toThrow(/HDFC_CLIENT_CODE/);
  });

  it("accepts the S3-compatible endpoint settings", () => {
    const c = loadConfig({ ...base, STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_ENDPOINT: "http://minio:9000", S3_FORCE_PATH_STYLE: "true" });
    expect(c.S3_ENDPOINT).toBe("http://minio:9000");
    expect(c.S3_FORCE_PATH_STYLE).toBe(true);
  });
});

describe("worker backoff", () => {
  it("grows exponentially with jitter and a cap", () => {
    expect(backoffMs(1, 1000, 60_000)).toBeGreaterThanOrEqual(1000);
    expect(backoffMs(1, 1000, 60_000)).toBeLessThanOrEqual(1200);
    expect(backoffMs(3, 1000, 60_000)).toBeGreaterThanOrEqual(4000);
    expect(backoffMs(20, 1000, 60_000)).toBeLessThanOrEqual(72_000);
  });
});

describe("mock extractor fixture", () => {
  it("passes every maths check", () => {
    const { lines, totals } = mockFixture();
    expect(lines).toHaveLength(5);
    const checks = runChecks({
      header: { sellerGstin: undefined, invoiceNo: "X", invoiceDate: "2026-10-01" },
      totals,
      lines: lines.map((l, i) => ({ ...l, id: `l${i}` })),
    });
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  });
});
