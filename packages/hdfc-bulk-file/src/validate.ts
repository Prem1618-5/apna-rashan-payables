/** Offline checks for Indian bank details. They catch typing errors; they do not prove the account belongs to the vendor. */

/** 4 letters (bank), a zero, 6 letters/digits (branch). Example: HDFC0000123. */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function isValidIfsc(ifsc: string): boolean {
  return IFSC_PATTERN.test(ifsc);
}

/** Most Indian account numbers are 9 to 18 digits; a few banks use letters. */
export function checkAccountNumber(account: string): { ok: boolean; unusual: boolean } {
  const ok = /^[A-Z0-9]{6,25}$/.test(account);
  const unusual = ok && !/^\d{9,18}$/.test(account);
  return { ok, unusual };
}

export function isValidEmail(email: string): boolean {
  return /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email);
}

export function isHdfcIfsc(ifsc: string): boolean {
  return ifsc.startsWith("HDFC");
}
