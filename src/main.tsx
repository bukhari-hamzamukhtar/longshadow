import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { fmtUTC } from "./lib/format";
import { useApp } from "./store";
import "./styles.css";
import { Compare } from "./ui/Compare";
import { Landing } from "./ui/Landing";
import { Method } from "./ui/Method";
import { Navigator } from "./ui/Navigator";

function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="12.5" r="5.5" fill="#eceae4" />
      <path d="M1 23 L10 19 L14 21 L20 16.5 L31 22 L31 31 L1 31 Z" fill="#08090a" stroke="#eceae4" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Header() {
  const { page, t } = useApp();
  const go = useApp.getState().go;
  const tool = page === "app" || page === "compare";
  return (
    <div className={`top ${page === "home" ? "clear" : ""}`}>
      <button className="brand" onClick={() => go("home")}><Mark />Longshadow</button>
      <nav>
        <button className={page === "app" ? "on" : ""} onClick={() => go("app")}>Navigator</button>
        <button className={page === "compare" ? "on" : ""} onClick={() => go("compare")}>Compare sites</button>
        <button className={page === "method" ? "on" : ""} onClick={() => go("method")}>Method and checks</button>
      </nav>
      {tool && <div className="right">{fmtUTC(t)}</div>}
    </div>
  );
}

function App() {
  const { page, ready, error } = useApp();
  useEffect(() => {
    useApp.getState().init();
  }, []);
  const wait = <div className="loading">{error ? `Could not load data: ${error}` : "Loading ephemeris and terrain"}</div>;
  return (
    <>
      <Header />
      {page === "home" && <Landing />}
      {page === "app" && (ready ? <Navigator /> : wait)}
      {page === "compare" && (ready ? <Compare /> : wait)}
      {page === "method" && <Method />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
