import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "arad-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Apna Rashan</title>");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('install', () => {});");
  writeFileSync(join(dir, "manifest.webmanifest"), "{}");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  env = await createTestEnv({ WEB_DIST: dir });
});
afterAll(async () => {
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("PWA static files", () => {
  it("serves hashed assets as immutable and the shell as no-cache", async () => {
    const asset = await env.app.inject({ url: "/assets/index-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    for (const url of ["/", "/sw.js", "/manifest.webmanifest"]) {
      const r = await env.app.inject({ url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers["cache-control"], url).toBe("no-cache");
    }
  });

  it("falls back to index.html for client routes but not for /api", async () => {
    const r = await env.app.inject({ url: "/invoices/123/verify" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Apna Rashan");
    expect(r.headers["cache-control"]).toBe("no-cache");
    const api = await env.app.inject({ url: "/api/health/nope" });
    expect(api.statusCode).toBe(401);
    const post = await env.app.inject({ method: "POST", url: "/somewhere" });
    expect(post.statusCode).toBe(404);
  });
});
