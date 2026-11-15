import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { fmtUTC } from "./lib/format";
import { useApp } from "./store";
import "./styles.css";
import "./pages.css";
import "./theme.css";
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
  const { page, t, theme } = useApp();
  const go = useApp.getState().go;
  const [past, setPast] = useState(false);
  useEffect(() => {
    const f = () => setPast(window.scrollY > window.innerHeight - 70);
    f();
    window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, [page]);
  const tool = page === "app" || page === "compare";
  return (
    <div className={`top ${page === "home" && !past ? "clear" : ""}`}>
      <button className="brand" onClick={() => go("home")}><Mark />Longshadow</button>
      <nav>
        <button className={page === "app" ? "on" : ""} onClick={() => go("app")}>Navigator</button>
        <button className={page === "compare" ? "on" : ""} onClick={() => go("compare")}>Compare sites</button>
        <button className={page === "method" ? "on" : ""} onClick={() => go("method")}>Method and checks</button>
      </nav>
      <div className="right">
        {tool && <span>{fmtUTC(t)}</span>}
        <button className="theme" onClick={() => useApp.getState().setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
      </div>
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

// reuse the root across hot reloads in development
const w = window as unknown as { __root?: ReturnType<typeof createRoot> };
const root = w.__root ?? (w.__root = createRoot(document.getElementById("root")!));
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
