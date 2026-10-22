/** Seeded PRNG (mulberry32) so `--seed 42` always gives the same invoices. */

export class Rng {
  private s: number;
  constructor(seed: number) {
    // Mix the seed (murmur3 finaliser) so consecutive seeds give unrelated streams.
    let h = (seed >>> 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    this.s = (h ^ (h >>> 16)) >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** k distinct items. */
  sample<T>(xs: readonly T[], k: number): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a.slice(0, Math.min(k, a.length));
  }
  /** Weighted choice: [[value, weight], …]. */
  weighted<T>(xs: readonly (readonly [T, number])[]): T {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of xs) {
      r -= w;
      if (r <= 0) return v;
    }
    return xs[xs.length - 1]![0];
  }
}
