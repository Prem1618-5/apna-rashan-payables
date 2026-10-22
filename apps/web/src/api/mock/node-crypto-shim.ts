/**
 * Browser stand-in for the one node:crypto call @arad/hdfc-bulk-file makes
 * (createHash("sha256").update(text, "ascii").digest("hex")). Only the mock backend bundles it.
 */
import { sha256Hex } from "./sha256";

export function createHash(algorithm: string) {
  if (algorithm !== "sha256") throw new Error(`unsupported hash ${algorithm}`);
  let data = "";
  const h = {
    update(chunk: string) {
      data += chunk;
      return h;
    },
    digest(_enc: "hex") {
      return sha256Hex(data);
    },
  };
  return h;
}

// generate.ts also calls Buffer.byteLength(content, "ascii"); give the browser a tiny Buffer with just that.
const g = globalThis as { Buffer?: unknown };
if (typeof g.Buffer === "undefined") {
  g.Buffer = { byteLength: (s: string) => new TextEncoder().encode(s).length };
}

export default { createHash };
