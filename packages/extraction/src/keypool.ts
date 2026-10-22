/**
 * A pool of API keys for one provider. Keys are never logged or returned: callers see slot numbers only.
 * - Round-robin start slot so load spreads over keys.
 * - A key that hit 429 cools down (60 s, or the provider's retryDelay); 403 cools down longer.
 */

export interface KeySlot {
  slot: number;
  key: string;
}

/** GEMINI_API_KEY (slot 0) plus GEMINI_API_KEY_1..9 (slots 1..9). Empty values are skipped; duplicates are dropped. */
export function readKeys(env: Record<string, string | undefined>, prefix: string): KeySlot[] {
  const out: KeySlot[] = [];
  const seen = new Set<string>();
  const add = (slot: number, v: string | undefined) => {
    const k = v?.trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ slot, key: k });
  };
  add(0, env[prefix]);
  for (let i = 1; i <= 9; i++) add(i, env[`${prefix}_${i}`]);
  return out;
}

export class KeyPool {
  private next = 0;
  private coolUntil = new Map<number, number>();

  constructor(
    private readonly keys: KeySlot[],
    private readonly now: () => number = Date.now,
  ) {}

  get size() {
    return this.keys.length;
  }

  /** Keys to try for one call, starting at the round-robin slot, skipping cooling keys. */
  order(): KeySlot[] {
    if (!this.keys.length) return [];
    const start = this.next % this.keys.length;
    this.next = (this.next + 1) % this.keys.length;
    const t = this.now();
    const rotated = [...this.keys.slice(start), ...this.keys.slice(0, start)];
    return rotated.filter((k) => (this.coolUntil.get(k.slot) ?? 0) <= t);
  }

  coolDown(slot: number, ms: number) {
    this.coolUntil.set(slot, Math.max(this.coolUntil.get(slot) ?? 0, this.now() + ms));
  }

  /** Milliseconds until the first key is usable again (0 if one is usable now). */
  nextAvailableIn(): number {
    const t = this.now();
    let min = Infinity;
    for (const k of this.keys) min = Math.min(min, Math.max(0, (this.coolUntil.get(k.slot) ?? 0) - t));
    return min === Infinity ? 0 : min;
  }

  isCooling(slot: number) {
    return (this.coolUntil.get(slot) ?? 0) > this.now();
  }
}

/** Parse Google's retry hint: error.details[].retryDelay like "37s" or "1.5s". */
export function retryDelayMs(body: unknown): number | undefined {
  const details = (body as { error?: { details?: { retryDelay?: string }[] } })?.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    const m = typeof d?.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay) : null;
    if (m) return Math.ceil(Number(m[1]) * 1000);
  }
  return undefined;
}
