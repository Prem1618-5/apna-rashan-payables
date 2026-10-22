/** Tolerant JSON parsing for model output: strict parse, then one local repair attempt. */

export type ParseResult = { ok: true; value: unknown; repaired: boolean; truncated: boolean } | { ok: false; error: string };

/**
 * Fixes the usual ways model JSON breaks: code fences, prose around the object, trailing commas,
 * NaN/undefined, smart quotes, raw newlines in strings, and output cut off mid-way.
 *
 * For cut-off output we go back to the last comma outside a string and close the brackets.
 * That drops the last, possibly incomplete, value instead of keeping half a number
 * ("1234" cut to "12" would be a silent wrong amount).
 */
export function repairJson(text: string): { text: string; truncated: boolean } {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)(?:```|$)/i.exec(s);
  if (fence) s = fence[1]!.trim();
  const start = s.search(/[{[]/);
  if (start > 0) s = s.slice(start);
  s = s.replace(/[“”]/g, '"');

  let out = "";
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let ended = false;
  let lastComma: { at: number; stack: string[] } | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (!stack.length) {
        out += ch;
        ended = true;
        break;
      }
    } else if (ch === ",") lastComma = { at: out.length, stack: [...stack] };
    out += ch;
  }
  let truncated = false;
  if (!ended) {
    truncated = true;
    if (lastComma) {
      out = out.slice(0, lastComma.at);
      stack.length = 0;
      stack.push(...lastComma.stack);
    } else if (inStr) out += '"';
    while (stack.length) out += stack.pop();
  }
  out = out
    .replace(/:\s*(NaN|undefined|-?Infinity)\b/g, ": null")
    .replace(/,\s*([}\]])/g, "$1");
  return { text: out, truncated };
}

export function parseModelJson(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text), repaired: false, truncated: false };
  } catch {
    // fall through to one repair attempt
  }
  try {
    const r = repairJson(text);
    return { ok: true, value: JSON.parse(r.text), repaired: true, truncated: r.truncated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
