import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyKey, groupTyped } from "../src/components/Keypad";
import { Amount } from "../src/components/ui";
import { inputToMilli, inputToPaise, inrShort, keypadToPaise, milliToInput, paiseToInput } from "../src/lib/format";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("money in UI components", () => {
  it("Amount shows Indian grouping, ₹, tabular figures and quieter paise", () => {
    const html = renderToStaticMarkup(<Amount paise={12345670} />);
    expect(text(html)).toBe("₹1,23,456.70");
    expect(html).toContain("num");
    expect(html).toMatch(/opacity-60">\.70</);
    expect(text(renderToStaticMarkup(<Amount paise={-24400} />))).toBe("-₹244.00");
    expect(text(renderToStaticMarkup(<Amount paise={5} />))).toBe("₹0.05");
    expect(inrShort(1_25_000_00)).toBe("₹1,25,000");
  });

  it("keypad builds amounts safely (max 2 decimals, one dot, no leading zeros)", () => {
    let s = "";
    for (const k of ["1", "7", "0", "5", "7", ".", "5", "0", "9"]) s = applyKey(s, k, { decimal: true });
    expect(s).toBe("17057.50");
    expect(keypadToPaise(s)).toBe(1705750);
    expect(groupTyped("1705750.5")).toBe("17,05,750.5");
    expect(applyKey("0", "5", { decimal: true })).toBe("5");
    expect(applyKey("", ".", { decimal: true })).toBe("0.");
    expect(applyKey("12.", ".", { decimal: true })).toBe("12.");
    expect(applyKey("12", "back")).toBe("1");
    expect(applyKey("123", "4", { maxLength: 3 })).toBe("123");
    expect(keypadToPaise("")).toBeUndefined();
    expect(keypadToPaise("0.")).toBe(0);
  });

  it("form inputs convert rupees and quantities without floats", () => {
    expect(inputToPaise("1,250.5")).toBe(125050);
    expect(inputToPaise("0.1")).toBe(10);
    expect(inputToPaise("abc")).toBeUndefined();
    expect(paiseToInput(125050)).toBe("1250.50");
    expect(paiseToInput(15800)).toBe("158");
    expect(inputToMilli("2.5")).toBe(2500);
    expect(milliToInput(12000)).toBe("12");
  });
});
