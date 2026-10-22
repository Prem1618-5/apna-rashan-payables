/**
 * Text and number helpers. The bank file is plain ASCII CSV without quoting,
 * so every value is cleaned to a small safe character set before it is written.
 */

const SAFE_TEXT = /[^A-Za-z0-9 .\-/]/g;

/** Keep letters, digits, space, dot, hyphen and slash. Accents are stripped; anything else becomes a space. */
export function cleanText(input: string | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(SAFE_TEXT, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanCode(input: string | undefined): string {
  return (input ?? "").replace(/\s+/g, "").toUpperCase();
}

/** 1234505 paise -> "12345.05". Integer paise only; never floats. */
export function formatPaise(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error(`invalid paise amount: ${paise}`);
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `${rupees}.${String(rest).padStart(2, "0")}`;
}

/** "2026-10-22" -> "22/10/2026". Dates stay as calendar strings so time zones can't shift the day. */
export function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`date must be YYYY-MM-DD: ${isoDate}`);
  const [, y, mo, d] = m;
  const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)) {
    throw new Error(`not a real calendar date: ${isoDate}`);
  }
  return `${d}/${mo}/${y}`;
}

/**
 * Pack bill numbers into the bank's narration lines (e.g. 7 lines x 30 chars).
 * If they don't all fit, the last line says how many were left out; the full
 * list is in the remittance advice.
 */
export function packIntoLines(prefix: string, tokens: string[], lineCount: number, lineLength: number): string[] {
  const width = (parts: string[]) => parts.join(" ").length;
  const lines: string[][] = [prefix ? [prefix] : []];
  let placed = 0;
  for (const raw of tokens) {
    const token = raw.slice(0, lineLength);
    const current = lines[lines.length - 1]!;
    if (width([...current, token]) <= lineLength) {
      current.push(token);
    } else if (lines.length < lineCount) {
      lines.push([token]);
    } else {
      break;
    }
    placed++;
  }

  let left = tokens.length - placed;
  if (left > 0) {
    // Make room for the note by dropping whole bill numbers, never cutting one in half.
    const last = lines[lines.length - 1]!;
    const keep = lines.length === 1 && prefix ? 1 : 0;
    while (last.length > keep && width([...last, `+${left} MORE`]) > lineLength) {
      last.pop();
      left++;
    }
    last.push(`+${left} MORE`);
  }
  return lines.map((parts) => parts.join(" ")).filter(Boolean);
}
