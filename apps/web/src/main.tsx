import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isMockMode } from "./api/mode";
import { listenForInstallPrompt } from "./lib/install";
import "./styles.css";

isMockMode(); // reads ?mock=1 before the router sees the URL
listenForInstallPrompt();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker: after first paint, so it never competes with the app for a slow phone's CPU.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const register = () => void import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
  if ("requestIdleCallback" in window) requestIdleCallback(register, { timeout: 4000 });
  else setTimeout(register, 2000);
}
