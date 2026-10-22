/** Save a generated file on the phone. Works on Android Chrome and iOS Safari (including home-screen mode). */

export function isIosDevice() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * octet-stream keeps the exact file name: Safari would add ".txt" to a text/plain file
 * called "ARAD012210.001", and the bank needs the name unchanged.
 */
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadText(name: string, text: string) {
  downloadBlob(name, new Blob([text], { type: "application/octet-stream" }));
}

export function canShareFiles(): boolean {
  try {
    const f = new File(["x"], "x.txt", { type: "text/plain" });
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}

/** iOS: opens the share sheet so the owner can "Save to Files" or send it to the computer. */
export async function shareText(name: string, text: string, title: string): Promise<boolean> {
  const file = new File([text], name, { type: "text/plain" });
  if (!navigator.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (e) {
    return (e as DOMException).name === "AbortError";
  }
}
