/** GSTIN: 2-digit state + 10-char PAN + entity number + Z + check character. */

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARS.indexOf(first14[i]!);
    if (value < 0) throw new Error(`invalid GSTIN character: ${first14[i]}`);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

export function isValidGstin(gstin: string | undefined): boolean {
  if (!gstin || !GSTIN_PATTERN.test(gstin)) return false;
  return gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
}

export function normalizeGstin(gstin: string | undefined): string | undefined {
  const g = gstin?.replace(/[\s-]/g, "").toUpperCase();
  return g || undefined;
}

export function gstinState(gstin: string | undefined): string | undefined {
  return gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : undefined;
}

export function gstinPan(gstin: string | undefined): string | undefined {
  return gstin && gstin.length >= 12 ? gstin.slice(2, 12) : undefined;
}

export const STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
  "97": "Other Territory",
};
