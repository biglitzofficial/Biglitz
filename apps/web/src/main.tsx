import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// /admin is the Admin / Super Admin portal entry: same app, opened on the dashboard with the desktop layout.
if (window.location.pathname.replace(/\/$/, "") === "/admin") {
  window.history.replaceState(null, "", "/#/");
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* app works without it; not installable */
    });
  });
}
