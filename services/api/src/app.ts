/** Builds the Fastify app. server.ts adds config, migrations, the worker and signal handling around it. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";

import { registerAuth } from "./auth.js";
import type { AppContext } from "./context.js";
import { ApiError } from "./errors.js";
import { coreRoutes } from "./routes/core.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { paymentRoutes } from "./routes/payments.js";
import { MAX_PAGE_BYTES, MAX_PAGES } from "./services/capture.js";

export interface BuildOptions {
  /** Fastify logger options; false for silent tests. */
  logger?: FastifyServerOptions["logger"];
  /** An existing pino logger (the server shares one with the worker). Takes precedence over `logger`. */
  loggerInstance?: FastifyBaseLogger;
  /** Login attempts per IP per minute. */
  loginRateLimit?: number;
}

/** Pino options: JSON to stdout, request ids, secrets and personal data redacted. */
export function loggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "*.pin",
        "*.pinHash",
        "*.accountNumber",
        "*.accountNumberConfirm",
        "*.phone",
        "*.token",
        "body.pin",
        "body.accountNumber",
        "body.accountNumberConfirm",
      ],
      censor: "[redacted]",
    },
    serializers: {
      req(req: { method: string; url: string; id: string; ip?: string }) {
        return { method: req.method, url: req.url, id: req.id };
      },
    },
  };
}

const PERMISSIONS_POLICY = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()";

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.loggerInstance ? { loggerInstance: opts.loggerInstance } : { logger: opts.logger ?? loggerOptions(ctx.config.LOG_LEVEL) }),
    // Behind CloudFront → ALB: the client IP comes from X-Forwarded-For.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    return503OnClosing: true,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // No inline scripts. 'wasm-unsafe-eval' lets the QR decoder (zxing-wasm) compile WebAssembly.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "blob:", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'", "blob:"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(ctx.config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: ctx.config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "same-origin" },
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, c) => ({
      statusCode: 429,
      error: { code: "RATE_LIMITED", message: `Too many attempts. Try again in ${Math.ceil(c.ttl / 1000)} seconds.` },
    }),
  });
  await app.register(multipart, { limits: { fileSize: MAX_PAGE_BYTES, files: MAX_PAGES, fields: 20, fieldSize: 200 * 1024, parts: 40 } });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("Permissions-Policy", PERMISSIONS_POLICY);
    if (req.url.startsWith("/api/") && !reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((err: FastifyError & { error?: { code: string; message: string } }, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    if (err.validation) return reply.code(400).send({ error: { code: "VALIDATION", message: err.message } });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23505") return reply.code(409).send({ error: { code: "CONFLICT", message: "This conflicts with an existing record" } });
    if (pgCode && ["23514", "22P02", "22003", "23502", "22007", "22008", "23503"].includes(pgCode)) {
      req.log.warn({ pgCode, constraint: (err as { constraint?: string }).constraint }, "rejected by a database constraint");
      return reply.code(400).send({ error: { code: "INVALID_DATA", message: "Some values are not valid" } });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: { code: err.error?.code ?? err.code ?? "BAD_REQUEST", message: err.error?.message ?? err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Something went wrong. Please try again." } });
  });

  registerAuth(app, ctx);
  coreRoutes(app, ctx, { loginRateLimit: opts.loginRateLimit ?? ctx.config.LOGIN_RATE_LIMIT_PER_MIN });
  invoiceRoutes(app, ctx);
  paymentRoutes(app, ctx);

  // ------------------------------------------------------------ PWA

  const dist = ctx.config.WEB_DIST;
  const serveWeb = !!dist && existsSync(dist) && statSync(dist).isDirectory() && existsSync(join(dist, "index.html"));
  if (dist && !serveWeb) app.log.warn({ webDist: dist }, "WEB_DIST has no index.html; the PWA is not served");
  if (serveWeb) {
    const noCache = /(?:^|[\\/])(index\.html|sw\.js|registerSW\.js|manifest\.webmanifest|manifest\.json)$/;
    await app.register(fastifyStatic, {
      root: dist!,
      cacheControl: false,
      etag: true,
      lastModified: true,
      setHeaders(res, path) {
        if (noCache.test(path)) res.header("Cache-Control", "no-cache");
        else if (/[\\/]assets[\\/]/.test(path)) res.header("Cache-Control", "public, max-age=31536000, immutable");
        else res.header("Cache-Control", "public, max-age=3600");
      },
    });
  }

  // Synchronous on purpose: sendFile streams, and awaiting the reply here leaks stream listeners.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/api" || !serveWeb || (req.method !== "GET" && req.method !== "HEAD")) {
      reply.code(404).send({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.url.split("?")[0]}` } });
      return;
    }
    // SPA fallback: client-side routes get index.html.
    reply.header("Cache-Control", "no-cache").type("text/html").sendFile("index.html");
  });

  return app;
}
