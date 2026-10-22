/** Keeps the Android/desktop "Install app" prompt so the More screen can offer it later. */
let deferred: BeforeInstallPromptEvent | undefined;
const subs = new Set<() => void>();

export function listenForInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    subs.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    deferred = undefined;
    subs.forEach((f) => f());
  });
}

export const canPromptInstall = () => !!deferred;
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = undefined;
  subs.forEach((f) => f());
  return outcome === "accepted";
}
export function onInstallChange(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}

export const isStandalone = () =>
  typeof window !== "undefined" && (matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export const isIos = () => typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
