/** Mock mode: VITE_MOCK=1 at build time, or `?mock=1` once (remembered), `?mock=0` to turn off. */
const KEY = "arad.mock";

function readFlag(): boolean {
  if (import.meta.env.VITE_MOCK === "1") return true;
  try {
    const url = new URL(location.href);
    const q = url.searchParams.get("mock");
    if (q === "1") localStorage.setItem(KEY, "1");
    if (q === "0") localStorage.removeItem(KEY);
    if (q !== null) {
      url.searchParams.delete("mock");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let cached: boolean | undefined;
export function isMockMode(): boolean {
  if (cached === undefined) cached = typeof window !== "undefined" && readFlag();
  return cached;
}
