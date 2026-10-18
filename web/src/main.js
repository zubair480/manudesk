// main.js — routing: `/` = runs list, `/runs/<id>` (or `?run=<id>` when the host has no SPA rewrite) = guide view.
import "./styles.css";
import { initTheme } from "./theme.js";
import { mountGuide } from "./guide.js";
import { mountRuns } from "./runs.js";

// data.js and the viewers belong to other sessions; load them lazily so a missing module never blanks the page
const MODS = import.meta.glob(["./data.js", "./floorplan.js", "./fmaxchart.js"]);
import.meta.glob("./viewers.css", { eager: true });
const cache = {};
const module = name => cache[name] || (cache[name] = (MODS[`./${name}.js`] ? MODS[`./${name}.js`]() : Promise.resolve(null)).catch(e => { console.error(`${name}.js failed to load`, e); return null; }));

const missing = () => { throw new Error("The data layer (src/data.js) is not available yet."); };
let teardown = null;

function setSample(on) { const b = document.getElementById("wfSample"); if (b) b.hidden = !on; }
function navigate(href) { history.pushState(null, "", href); route(); }

async function route() {
  if (teardown) { teardown(); teardown = null; }
  scrollTo(0, 0); setSample(false);
  const data = (await module("data")) || { listRuns: missing, loadRun: missing };
  const api = { data, module, setSample, navigate };
  const pm = location.pathname.match(/^\/runs\/([^/]+)/), id = (pm && decodeURIComponent(pm[1])) || new URLSearchParams(location.search).get("run");
  document.body.classList.toggle("is-runs", !id);
  teardown = id ? mountGuide(id, api) : mountRuns(api);
}

document.addEventListener("click", e => { const a = e.target.closest && e.target.closest("a[data-route]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(a.getAttribute("href")); });
addEventListener("popstate", route);
initTheme();
route();
