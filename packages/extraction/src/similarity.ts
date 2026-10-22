/** Text similarity used to align lines and compare vendor names across readers. */

const STOP = /\b(m\/?s|pvt|private|ltd|limited|llp|co|company|and|the|traders?|enterprises?|agency|agencies|distributors?)\b/g;

export function normDesc(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normVendor(s: string): string {
  return normDesc(s).replace(STOP, " ").replace(/\s+/g, " ").trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice on character bigrams, 0..1. Works for Devanagari too. */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    inter += Math.min(n, B.get(g) ?? 0);
  }
  for (const n of B.values()) total += n;
  return (2 * inter) / total;
}

export const descSimilarity = (a: string, b: string) => dice(normDesc(a), normDesc(b));
export const vendorSimilarity = (a: string, b: string) => {
  const x = normVendor(a);
  const y = normVendor(b);
  return x && y ? dice(x, y) : dice(normDesc(a), normDesc(b));
};

/**
 * Order-preserving alignment of two sequences (weighted LCS / Needleman–Wunsch with zero gap cost).
 * Returns index pairs; unmatched items appear with the other side undefined.
 */
export function align<A, B>(a: A[], b: B[], sim: (x: A, y: B) => number, threshold: number): { a?: number; b?: number; score?: number }[] {
  const n = a.length;
  const m = b.length;
  const S: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const sims: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => sim(a[i]!, b[j]!)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sims[i - 1]![j - 1]!;
      const diag = s >= threshold ? S[i - 1]![j - 1]! + (s - threshold) + 1e-6 : -Infinity;
      S[i]![j] = Math.max(diag, S[i - 1]![j]!, S[i]![j - 1]!);
    }
  }
  const out: { a?: number; b?: number; score?: number }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const s = sims[i - 1]![j - 1]!;
      if (s >= threshold && Math.abs(S[i]![j]! - (S[i - 1]![j - 1]! + (s - threshold) + 1e-6)) < 1e-9) {
        out.push({ a: i - 1, b: j - 1, score: s });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && (j === 0 || S[i - 1]![j]! >= S[i]![j - 1]!)) {
      out.push({ a: i - 1 });
      i--;
    } else {
      out.push({ b: j - 1 });
      j--;
    }
  }
  return out.reverse();
}
