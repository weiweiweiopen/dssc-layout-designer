import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LocaleProvider } from "./i18n";
import "./styles.css";
const TypeStudio = lazy(() => import("./TypeStudio"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>{new URLSearchParams(window.location.search).get("studio") === "type" ? <Suspense fallback={<p>正在載入向量工作區…</p>}><TypeStudio /></Suspense> : <App />}</LocaleProvider>
  </StrictMode>,
);
