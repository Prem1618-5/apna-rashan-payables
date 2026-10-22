/** Vendors, payables and payment runs. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userOf } from "../auth.js";
import type { AppContext } from "../context.js";
import { parse } from "../errors.js";
import { payables } from "../services/payables.js";
import * as runs from "../services/payment-runs.js";
import * as vendors from "../services/vendors.js";

const uuid = z.string().uuid();
const id = (req: { params: unknown }) => parse(z.object({ id: uuid }), req.params).id;

const vendorInput = z.object({
  name: z.string().trim().min(1).max(120),
  tradeName: z.string().trim().max(120).optional(),
  gstin: z.string().trim().max(20).optional(),
  pan: z.string().trim().max(10).optional(),
  phone: z.string().trim().regex(/^[0-9+ -]{6,20}$/, "must be a phone number").optional().or(z.literal("")),
  email: z.string().trim().email().max(120).optional().or(z.literal("")),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
});

const bankInput = z.object({
  accountNumber: z.string().max(40),
  accountNumberConfirm: z.string().max(40),
  ifsc: z.string().max(20),
  bankName: z.string().trim().max(100).optional(),
  branchName: z.string().trim().max(100).optional(),
  beneCode: z.string().trim().max(20).optional(),
});

export function paymentRoutes(app: FastifyInstance, ctx: AppContext) {
  // ------------------------------------------------------------ vendors

  app.get("/api/vendors", async (req) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), status: z.string().max(50).optional() }), req.query);
    return vendors.listVendors(ctx.pool, userOf(req), q);
  });
  app.get("/api/vendors/:id", async (req) => vendors.getVendor(ctx.pool, userOf(req), id(req)));
  app.post("/api/vendors", async (req, reply) => reply.code(201).send(await vendors.createVendor(ctx, userOf(req), parse(vendorInput, req.body))));
  app.put("/api/vendors/:id", async (req) => vendors.updateVendor(ctx, userOf(req), id(req), parse(vendorInput, req.body)));
  app.post("/api/vendors/:id/approve", { config: { auth: "owner" } }, async (req) => vendors.approveVendor(ctx, userOf(req), id(req)));
  app.post("/api/vendors/:id/bank", async (req, reply) => reply.code(201).send(await vendors.proposeBank(ctx, userOf(req), id(req), parse(bankInput, req.body))));
  app.post("/api/vendors/:id/bank/:versionId/approve", { config: { auth: "owner" } }, async (req) => {
    const p = parse(z.object({ id: uuid, versionId: uuid }), req.params);
    return vendors.approveBank(ctx, userOf(req), p.id, p.versionId);
  });

  // ------------------------------------------------------------ payables

  app.get("/api/payables", async (req) => {
    const { due } = parse(z.object({ due: z.enum(["overdue", "today", "week", "all"]).default("all") }), req.query);
    return payables(ctx.pool, userOf(req), due);
  });

  // ------------------------------------------------------------ payment runs

  app.post("/api/payment-runs", async (req, reply) => {
    const body = parse(
      z.object({
        invoiceIds: z.array(uuid).min(1).max(2000),
        valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
      }),
      req.body,
    );
    return reply.code(201).send(await runs.createRun(ctx, userOf(req), body.invoiceIds, body.valueDate));
  });
  app.get("/api/payment-runs", async (req) => runs.listRuns(ctx, userOf(req)));
  app.get("/api/payment-runs/:id", async (req) => runs.getRun(ctx, userOf(req), id(req)));
  app.post("/api/payment-runs/:id/approve", { config: { auth: "owner" } }, async (req) => runs.approveRun(ctx, userOf(req), id(req)));

  app.get("/api/payment-runs/:id/file", { config: { auth: "owner" } }, async (req, reply) => {
    const f = await runs.runFile(ctx, userOf(req), id(req));
    return reply
      .header("Content-Type", "text/plain; charset=us-ascii")
      .header("Content-Disposition", `attachment; filename="${f.name}"`)
      .header("Cache-Control", "no-store")
      .send(Buffer.from(f.content, "ascii"));
  });

  app.get("/api/payment-runs/:id/advice.csv", { config: { auth: "owner" } }, async (req, reply) => {
    const f = await runs.adviceCsv(ctx, userOf(req), id(req));
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${f.name}"`)
      .header("Cache-Control", "no-store")
      .send(f.content);
  });

  app.post("/api/payment-runs/:id/mark-uploaded", { config: { auth: "owner" } }, async (req) => runs.markUploaded(ctx, userOf(req), id(req)));
  app.post("/api/payment-runs/:id/mark-paid", { config: { auth: "owner" } }, async (req) => {
    const body = parse(z.object({ utrs: z.record(z.string(), z.string().max(40)).optional() }), req.body ?? {});
    return runs.markPaid(ctx, userOf(req), id(req), body.utrs);
  });
  app.post("/api/payment-runs/:id/items/:itemId/mark-failed", { config: { auth: "owner" } }, async (req) => {
    const p = parse(z.object({ id: uuid, itemId: uuid }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(2).max(300) }), req.body);
    return runs.markItemFailed(ctx, userOf(req), p.id, p.itemId, reason);
  });
  app.post("/api/payment-runs/:id/cancel", async (req) => runs.cancelRun(ctx, userOf(req), id(req)));
}
