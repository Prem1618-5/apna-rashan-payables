import "fake-indexeddb/auto";
import type { CaptureResponse } from "@arad/core";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDbConnection } from "../src/lib/idb";
import { backoffMs, createOutbox, isPermanent } from "../src/lib/outbox";

const ok: CaptureResponse = { documentId: "d1", invoiceId: "i1", state: "EXTRACTING" };
const jpeg = (n = 1000) => new Blob([new Uint8Array(n).fill(7)], { type: "image/jpeg" });
const err = (status: number | undefined, message = "fail") => Object.assign(new Error(message), { status });

beforeEach(async () => {
  resetDbConnection();
  // fresh database per test
  await new Promise<void>((res) => {
    const r = indexedDB.deleteDatabase("arad");
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
});

describe("capture outbox", () => {
  it("stores the capture durably before uploading, then deletes it after the server confirms", async () => {
    let online = false;
    const uploads: { clientId: string; pages: Blob[] }[] = [];
    const box = createOutbox({ upload: async (i) => (uploads.push(i), ok), isOnline: () => online, newId: () => "c-1" });
    await box.add({ storeId: "s1", pages: [jpeg(2048), jpeg(10)], qr: ["upi://pay?pa=x@y"] });
    expect(box.items).toHaveLength(1);
    expect(box.items[0]).toMatchObject({ clientId: "c-1", pageCount: 2, bytes: 2058, storeId: "s1" });
    expect(uploads).toHaveLength(0); // offline: nothing sent

    online = true;
    await box.drain();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.clientId).toBe("c-1");
    expect(uploads[0]!.pages.map((p) => p.size)).toEqual([2048, 10]);
    expect(box.items).toHaveLength(0);
    box.stop();
  });

  it("survives a reload: a new outbox instance sees the queued item", async () => {
    const a = createOutbox({ upload: async () => ok, isOnline: () => false });
    await a.add({ storeId: "s1", pages: [jpeg()], qr: [] });
    a.stop();
    resetDbConnection();
    const b = createOutbox({ upload: async () => ok, isOnline: () => false });
    await b.refresh();
    expect(b.items).toHaveLength(1);
    b.stop();
  });

  it("keeps the item and backs off on network/server errors; never loses it", async () => {
    let now = 1_000_000;
    let fail: Error | undefined = err(undefined, "Failed to fetch");
    let calls = 0;
    const box = createOutbox({
      upload: async () => {
        calls++;
        if (fail) throw fail;
        return ok;
      },
      isOnline: () => true,
      now: () => now,
    });
    await box.add({ storeId: "s1", pages: [jpeg()], qr: [] });
    await box.drain();
    expect(box.items).toHaveLength(1);
    expect(box.items[0]!.attempts).toBe(1);
    expect(box.items[0]!.lastError).toBe("Failed to fetch");

    await box.drain(); // too early: backoff not elapsed
    expect(calls).toBe(1);

    fail = err(503, "Service unavailable");
    now += backoffMs(1) * 2;
    await box.drain();
    expect(calls).toBe(2);
    expect(box.items[0]!.attempts).toBe(2);
    expect(box.items[0]!.stuck).toBe(false);

    fail = undefined;
    now += backoffMs(2) * 2;
    await box.drain();
    expect(box.items).toHaveLength(0);
    box.stop();
  });

  it("marks a 4xx rejection as stuck (kept until a person retries or discards)", async () => {
    let fail: Error | undefined = err(413, "Photo too large");
    const box = createOutbox({ upload: async () => { if (fail) throw fail; return ok; }, isOnline: () => true });
    await box.add({ storeId: "s1", pages: [jpeg()], qr: [] });
    await box.drain();
    expect(box.items[0]).toMatchObject({ stuck: true, lastError: "Photo too large" });
    await box.drain(true);
    expect(box.items).toHaveLength(1);
    fail = undefined;
    await box.retry(box.items[0]!.clientId);
    expect(box.items).toHaveLength(0);
    await box.add({ storeId: "s1", pages: [jpeg()], qr: [] });
    fail = err(400);
    await box.drain();
    await box.discard(box.items[0]!.clientId);
    expect(box.items).toHaveLength(0);
    box.stop();
  });

  it("backoff doubles up to 10 minutes; auth and rate limits are retried", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([5000, 10000, 20000, 40000]);
    expect(backoffMs(30)).toBe(600_000);
    expect(isPermanent(400)).toBe(true);
    expect(isPermanent(413)).toBe(true);
    for (const s of [401, 403, 408, 429, 500, 503, undefined]) expect(isPermanent(s)).toBe(false);
  });
});
