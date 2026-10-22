/**
 * Invoice page storage. "fs" for local dev (STORAGE_DIR), "s3" for AWS (S3_BUCKET, private bucket).
 * Objects are never public; the API streams them back after auth + store-scope checks.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";

export interface Storage {
  readonly driver: "fs" | "s3" | "memory";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,250}$/;

function checkKey(key: string): string {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.includes("//")) throw new Error(`invalid storage key: ${key}`);
  return key;
}

export class FsStorage implements Storage {
  readonly driver = "fs" as const;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    const p = resolve(join(this.root, checkKey(key)));
    if (!p.startsWith(this.root + sep)) throw new Error("storage key escapes the storage folder");
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    // Write then rename, so a crash never leaves a half-written page.
    const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export class MemoryStorage implements Storage {
  readonly driver = "memory" as const;
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.objects.set(checkKey(key), Buffer.from(data));
  }
  async get(key: string) {
    const b = this.objects.get(checkKey(key));
    if (!b) throw Object.assign(new Error(`no such object: ${key}`), { code: "ENOENT" });
    return b;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export class S3Storage implements Storage {
  readonly driver = "s3" as const;
  // Loaded lazily so the fs driver never pays for the AWS SDK.
  private clientP?: Promise<{ send: (cmd: unknown) => Promise<unknown>; mod: typeof import("@aws-sdk/client-s3") }>;
  constructor(
    private readonly bucket: string,
    private readonly region: string,
    private readonly endpoint?: string,
    private readonly forcePathStyle = false,
  ) {}
  private client() {
    this.clientP ??= import("@aws-sdk/client-s3").then((mod) => {
      // Credentials: SDK default chain (ECS task role on AWS, env vars for MinIO).
      const c = new mod.S3Client({ region: this.region, ...(this.endpoint ? { endpoint: this.endpoint } : {}), forcePathStyle: this.forcePathStyle });
      return { send: (cmd: unknown) => c.send(cmd as never), mod };
    });
    return this.clientP;
  }
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const { send, mod } = await this.client();
    await send(new mod.PutObjectCommand({ Bucket: this.bucket, Key: checkKey(key), Body: data, ContentType: contentType }));
  }
  async get(key: string): Promise<Buffer> {
    const { send, mod } = await this.client();
    const out = (await send(new mod.GetObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!out.Body) throw new Error(`empty object: ${key}`);
    return Buffer.from(await out.Body.transformToByteArray());
  }
  async delete(key: string): Promise<void> {
    const { send, mod } = await this.client();
    await send(new mod.DeleteObjectCommand({ Bucket: this.bucket, Key: checkKey(key) }));
  }
}

export function createStorage(config: Pick<Config, "STORAGE_DRIVER" | "STORAGE_DIR" | "S3_BUCKET" | "AWS_REGION" | "S3_ENDPOINT" | "S3_FORCE_PATH_STYLE">): Storage {
  if (config.STORAGE_DRIVER === "s3") return new S3Storage(config.S3_BUCKET!, config.AWS_REGION, config.S3_ENDPOINT, config.S3_FORCE_PATH_STYLE);
  return new FsStorage(config.STORAGE_DIR);
}
