// theme.js — light / dark for the glass look. index.html sets data-theme before first paint (stored choice, else the
// system preference); this adds the round bottom-right toggle and follows the system until the viewer picks one.
const KEY = "menudesk.theme";
const root = document.documentElement;
const stored = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
const sys = matchMedia("(prefers-color-scheme: dark)");

function apply(t) { root.dataset.theme = t; root.style.colorScheme = t;
  const b = document.getElementById("thBtn"); if (b) { b.title = t == "dark" ? "Switch to light" : "Switch to dark"; b.setAttribute("aria-pressed", String(t == "dark")); } }

export function initTheme() {
  const btn = document.createElement("button");
  btn.id = "thBtn"; btn.type = "button"; btn.setAttribute("aria-label", "Toggle light or dark theme"); btn.innerHTML = "<i></i>";
  document.body.append(btn);
  apply(stored() || (sys.matches ? "dark" : "light"));
  btn.addEventListener("click", () => { const t = root.dataset.theme == "dark" ? "light" : "dark"; try { localStorage.setItem(KEY, t); } catch (e) { } apply(t); });
  sys.addEventListener("change", e => { if (!stored()) apply(e.matches ? "dark" : "light"); });
}
